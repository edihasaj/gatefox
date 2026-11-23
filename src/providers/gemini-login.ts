import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { onProcessExit } from "./exit-cleanup.js";
import { markGeminiScratchOwner, sweepGeminiScratchOnce } from "./gemini-scratch-sweep.js";
import { ensureGeminiHome, geminiCommand, geminiEnv, hasGeminiLogin } from "./gemini-home.js";
import { installGeminiCredentials, prepareGeminiScratchHome, writeGeminiBrowserShim } from "./gemini-session-home.js";

/**
 * `gateway login gemini` and the desktop app's Reconnect, one verified flow.
 *
 * The CLI has no `login` command: run with nothing to do, it starts Google's browser sign-in. Probed against 0.70.0 with
 * stdin closed, the flow stops at "Opening authentication page in your browser. Do you want to continue? [Y/n]:" and the
 * process exits 0 with no credential, so a clean exit proves nothing. Without a terminal that question is read from stdin
 * (bundle `getOauthConsentNonInteractive`); a Reconnect click is the user's consent, so the helper answers `Y`. The CLI then
 * runs the browser opener by name with the sign-in URL and prints no URL of its own, so a stand-in `open` first on PATH
 * captures it and this helper opens it, once, only when it is an `https://accounts.google.com/` URL.
 *
 * Success is judged by one thing: `oauth_creds.json` appearing in the CLI's home with both tokens. The CLI runs in a
 * disposable home and an empty private folder, never in the caller's directory (a trusted workspace's `.gemini/settings.json`
 * or `.env` would otherwise reach it), and the credential is installed into the persistent home only after it is verified.
 */
export interface GeminiLoginOptions {
  /** The gateway's persistent Gemini home. */
  home: string;
  /** Called once with the Google sign-in URL the CLI asked its browser to open. */
  openUrl(url: string): void | Promise<void>;
  signal?: AbortSignal;
  /** The CLI waits five minutes for the browser; the default allows a little longer. */
  timeoutMs?: number;
  pollMs?: number;
  /** After the credential appears, how long the CLI may take to cache the account and answer the browser. */
  settleMs?: number;
}

/**
 * The CLI's callback handler saves the tokens first, then fetches and caches the Google account (`google_accounts.json`), and
 * only then redirects the browser to its success page. Ending the CLI as soon as the credential exists cut both off: the
 * account was never cached and the browser's callback failed with "refused to connect" although the sign-in had worked.
 */
const settleBeatMs = 1000;

const consentPrompt = /\[Y\/n\]/;
const signInHost = "accounts.google.com";

/** The sign-in URL when it is a well-formed https Google account URL, and nothing else. */
export function geminiSignInUrl(text: string): string | undefined {
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" && url.hostname === signInHost && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

/** Opens `url` in the user's browser (macOS `open`, elsewhere `xdg-open`); the gateway's own PATH has no stand-in. */
export async function openGeminiSignInUrl(url: string): Promise<void> {
  const opener = process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function geminiLogin(options: GeminiLoginOptions): Promise<void> {
  const { home, signal } = options; const deadline = Date.now() + (options.timeoutMs ?? 6 * 60000); const pollMs = options.pollMs ?? 200;
  if (signal?.aborted) throw new Error("cancelled");
  const command = await geminiCommand();
  // Refuses a home holding a `.env` file, and writes the managed settings the sign-in type is pinned by.
  await ensureGeminiHome(home, { requireLogin: false });
  sweepGeminiScratchOnce();
  const root = await mkdtemp(join(tmpdir(), "gateway-gemini-login-"));
  // A gateway that exits (process.exit) during the sign-in must not leave the copied credential's folder or the detached CLI behind.
  const exitHooks: Array<() => void> = [onProcessExit(() => rmSync(root, { recursive: true, force: true }))];
  let exited = false; let killed = false; let child: ReturnType<typeof spawn> | undefined; let fallback: NodeJS.Timeout | undefined;
  const kill = () => {
    if (killed || !child?.pid) return; killed = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* Gone already. */ } }
  };
  try {
    await markGeminiScratchOwner(root);
    const scratch = join(root, "home"); const work = join(root, "work"); const urlFile = join(root, "auth-url");
    await prepareGeminiScratchHome(scratch);
    await mkdir(work, { mode: 0o700 });
    await writeGeminiBrowserShim(join(root, "bin"), urlFile, true);
    // A new process group lets one SIGKILL end the CLI and anything it started. No argument is passed: there is no login command.
    child = spawn(command, [], { cwd: work, env: geminiEnv(scratch, { shimDir: join(root, "bin") }), stdio: ["pipe", "pipe", "pipe"], detached: true });
    exitHooks.push(onProcessExit(kill));
    child.stdin!.on("error", () => {}); child.stderr!.resume(); child.once("error", () => { exited = true; }); child.once("exit", () => { exited = true; });
    // Only a short moving tail is kept, to see the question; the CLI's output is never stored or logged.
    let answered = false; let tail = "";
    const answer = () => { if (answered || exited) return; answered = true; child!.stdin!.write("Y\n"); };
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { tail = (tail + chunk).slice(-512); if (consentPrompt.test(tail)) answer(); });
    // The question is read only once the CLI is up; if it was not seen, answering anyway is harmless.
    fallback = setTimeout(answer, 10000); fallback.unref();
    let opened = false;
    for (;;) {
      if (signal?.aborted) throw new Error("cancelled");
      if (!opened) {
        const url = geminiSignInUrl(await readFile(urlFile, "utf8").catch(() => ""));
        if (url) { opened = true; await options.openUrl(url); }
      }
      // Success is the credential and nothing else; the exit code is never consulted. The file is rechecked after an exit,
      // because the CLI may have written it just before it left.
      const gone = exited;
      if (await hasGeminiLogin(scratch)) break;
      if (gone) throw new Error("Gemini sign-in did not complete");
      if (Date.now() >= deadline) throw new Error("Gemini sign-in timed out");
      await delay(pollMs);
    }
    // Let the CLI finish the callback: cache the account, then answer the browser. A CLI that exits is done; one that never
    // caches an account is ended after the cap, and the verified credential is installed either way.
    const settleUntil = Date.now() + (options.settleMs ?? 15000); const accounts = join(scratch, ".gemini", "google_accounts.json");
    while (!exited && Date.now() < settleUntil && !signal?.aborted) {
      if (await readFile(accounts, "utf8").then(() => true, () => false)) { await delay(Math.min(settleBeatMs, Math.max(0, settleUntil - Date.now()))); break; }
      await delay(pollMs);
    }
    kill();
    await installGeminiCredentials(home, scratch);
  } finally {
    clearTimeout(fallback); kill();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    for (const off of exitHooks) off();
  }
}
