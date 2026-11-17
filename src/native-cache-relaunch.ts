import { execFile, spawn } from "node:child_process";
import { readdir, stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { telemetry } from "./telemetry.js";

/**
 * A desktop adapter that started before the app was ever signed in runs the original engine (codex-shim's
 * native fallback), so that window has no gateway models. Signing in makes the app write its native model cache.
 * When that cache appears and no chat has started since the adapter began, this quits ChatGPT normally (SIGTERM,
 * which Electron treats as Quit) and reopens it once, so the next adapter loads gateway models without the user
 * restarting the app. Before sign-in no chat can run, so the only chats that could exist are ones started after
 * the sign-in; any session file newer than the adapter's start leaves the app alone. The quit and reopen run in a
 * detached helper because quitting the app also ends this adapter. Only fixed outcome words are recorded.
 */
export type CacheRelaunchOutcome = "relaunched" | "chat_started" | "not_app" | "failed";

export interface CacheRelaunchDeps {
  cacheReady: (path: string) => Promise<boolean>;
  /** Newest modification time (ms) of any file under the native sessions folder, or undefined when there is none. */
  newestSessionMs: (directory: string) => Promise<number | undefined>;
  parentCommand: (pid: number) => Promise<string | undefined>;
  relaunch: (appPid: number, appPath: string) => void;
  every: (ms: number, tick: () => void) => () => void;
  record: (outcome: CacheRelaunchOutcome) => void;
}

export interface CacheRelaunchOptions { cachePath: string; sessionsDirectory: string; appPath: string; appPid: number; startedAtMs: number; intervalMs?: number }

/** The app bundle an engine path belongs to (`…/ChatGPT.app/Contents/Resources/codex-cli/…`), or undefined. */
export function appPathFromEngine(executable: string): string | undefined {
  return /^(\/.+?\.app)\/Contents\/Resources\/codex-cli\//.exec(executable)?.[1];
}

const relaunchScript = 'kill -TERM "$1" 2>/dev/null || exit 0; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ "$i" -gt 60 ] && exit 0; sleep 0.25; done; exec /usr/bin/open "$2"';

async function cacheReady(path: string): Promise<boolean> {
  try { const info = await stat(path); if (!info.isFile() || info.size > 16 * 1024 * 1024) return false; return Array.isArray(JSON.parse(await readFile(path, "utf8")).models); }
  catch { return false; }
}

async function newestSessionMs(directory: string, depth = 0): Promise<number | undefined> {
  let newest: number | undefined;
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const value = entry.isDirectory() ? (depth < 4 ? await newestSessionMs(path, depth + 1) : undefined)
      : entry.isFile() ? await stat(path).then(info => info.mtimeMs, () => undefined) : undefined;
    if (value !== undefined && (newest === undefined || value > newest)) newest = value;
  }
  return newest;
}

const localDeps: CacheRelaunchDeps = {
  cacheReady, newestSessionMs,
  parentCommand: async pid => { try { return (await promisify(execFile)("/bin/ps", ["-o", "command=", "-p", String(pid)], { timeout: 5000 })).stdout.trim() || undefined; } catch { return undefined; } },
  relaunch: (appPid, appPath) => { spawn("/bin/sh", ["-c", relaunchScript, "gatefox-relaunch", String(appPid), appPath], { detached: true, stdio: "ignore" }).unref(); },
  every: (ms, tick) => { const timer = setInterval(tick, ms); timer.unref(); return () => clearInterval(timer); },
  record: outcome => telemetry("native_catalog_ready", { outcome }),
};

/** Watches for the native model cache; acts once. Returns a function that stops watching. */
export function watchNativeCacheForRelaunch(options: CacheRelaunchOptions, overrides: Partial<CacheRelaunchDeps> = {}): () => void {
  const deps = { ...localDeps, ...overrides };
  let busy = false; let done = false;
  const stop = deps.every(options.intervalMs ?? 2000, () => {
    if (busy || done) return; busy = true;
    void (async () => {
      if (!await deps.cacheReady(options.cachePath)) return;
      done = true; stop();
      let outcome: CacheRelaunchOutcome = "failed";
      try {
        const newest = await deps.newestSessionMs(options.sessionsDirectory);
        if (newest !== undefined && newest >= options.startedAtMs) outcome = "chat_started";
        else if (await deps.parentCommand(options.appPid) !== `${options.appPath.replace(/\/+$/, "")}/Contents/MacOS/ChatGPT`) outcome = "not_app";
        else { deps.relaunch(options.appPid, options.appPath); outcome = "relaunched"; }
      } catch { outcome = "failed"; }
      deps.record(outcome);
    })().catch(() => {}).finally(() => { busy = false; });
  });
  return () => { done = true; stop(); };
}
