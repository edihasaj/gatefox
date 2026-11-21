import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withPrivateFileLock } from "../private-file-lock.js";
import type { AcpProvisioned } from "./acp-driver.js";
import { geminiCliDir, geminiCredentialFile, geminiEnv, geminiManagedPolicy, geminiPolicyFile, geminiPoliciesDir, geminiSettingsFile, mergeGeminiSettings, writeGeminiPrivateFile } from "./gemini-home.js";
import { markGeminiScratchOwner, sweepGeminiScratchOnce } from "./gemini-scratch-sweep.js";
import { ProviderError } from "./provider.js";

/**
 * A disposable Gemini home for one CLI process.
 *
 * The CLI records every conversation: `ChatRecordingService` writes `<home>/.gemini/tmp/<project>/chats/session-*.jsonl`
 * (with the full prompt text) and `<home>/.gemini/history/`, and 0.70.0 has no setting, flag or variable that turns that
 * off. So the gateway's own Gemini home never runs the CLI: each process gets a private 0700 home inside its session
 * folder, holding only the managed settings, the policy file and a 0600 copy of the sign-in, and the whole folder is
 * deleted when the process ends. The one thing that must outlive it is a refreshed sign-in, which is copied back.
 */
const credentialNames = ["oauth_creds.json", "google_accounts.json"] as const;
type CredentialName = typeof credentialNames[number];
type Snapshot = Partial<Record<CredentialName, string>>;
const fileOf = (home: string, name: CredentialName): string => join(geminiCliDir(home), name);
const readText = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });

const isObject = (text: string): boolean => { try { const value: unknown = JSON.parse(text); return !!value && typeof value === "object" && !Array.isArray(value); } catch { return false; } };
/** A sign-in is only usable when it parses and carries both tokens; anything else must never replace a good one. */
export function usableGeminiCredential(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const creds = value as Record<string, unknown>;
    return typeof creds.access_token === "string" && creds.access_token.length > 0 && typeof creds.refresh_token === "string" && creds.refresh_token.length > 0;
  } catch { return false; }
}

/** Creates the scratch home with the managed settings and policy only. The CLI creates everything else itself. */
export async function prepareGeminiScratchHome(scratch: string): Promise<void> {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  await chmod(scratch, 0o700);
  await mkdir(geminiCliDir(scratch), { mode: 0o700 });
  await mkdir(geminiPoliciesDir(scratch), { mode: 0o700 });
  await writeFile(geminiSettingsFile(scratch), mergeGeminiSettings(""), { mode: 0o600, flag: "wx" });
  await writeFile(geminiPolicyFile(scratch), geminiManagedPolicy(), { mode: 0o600, flag: "wx" });
}

/** Copies the sign-in into the scratch home at 0600 and returns what was copied, to tell later whether the CLI changed it. */
export async function copyGeminiCredentialsIn(home: string, scratch: string): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  for (const name of credentialNames) {
    const text = await readText(fileOf(home, name));
    if (text === undefined) continue;
    snapshot[name] = text;
    await writeFile(fileOf(scratch, name), text, { mode: 0o600, flag: "wx" });
  }
  return snapshot;
}

/**
 * Carries a changed sign-in (the CLI refreshes its access token while it runs) back to the persistent home, under the
 * same cross-process lock as the other private files, atomically and at 0600. Only a file the CLI changed is copied, and
 * only while the persistent copy still is what was handed out: a newer sign-in made meanwhile (another session's refresh,
 * or `gateway login gemini`) wins, and a credential that no longer parses with both tokens never replaces a good one.
 */
export async function copyGeminiCredentialsBack(home: string, scratch: string, before: Snapshot): Promise<void> {
  const changed: Array<[CredentialName, string]> = [];
  for (const name of credentialNames) {
    const after = await readText(fileOf(scratch, name));
    if (after === undefined || after === before[name]) continue;
    if (name === "oauth_creds.json" ? !usableGeminiCredential(after) : !isObject(after)) continue;
    changed.push([name, after]);
  }
  if (!changed.length) return;
  await withPrivateFileLock(geminiCredentialFile(home), async () => {
    for (const [name, after] of changed) {
      if (await readText(fileOf(home, name)) !== before[name]) continue;
      await writeGeminiPrivateFile(fileOf(home, name), after);
    }
  });
}

/** Installs a freshly signed-in credential from a scratch home: it replaces the persistent one, under the lock. */
export async function installGeminiCredentials(home: string, scratch: string): Promise<void> {
  await withPrivateFileLock(geminiCredentialFile(home), async () => {
    for (const name of credentialNames) {
      const text = await readText(fileOf(scratch, name));
      if (text === undefined || (name === "oauth_creds.json" ? !usableGeminiCredential(text) : !isObject(text))) continue;
      await writeGeminiPrivateFile(fileOf(home, name), text);
    }
  });
}

const quoted = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
/**
 * Stand-ins for the browser opener in `dir`. The CLI opens its sign-in page by running `open` (macOS) or `xdg-open`
 * (Linux) by name — `childProcess.spawn(command, [url])` in the bundle's `open` package — so a stand-in first on PATH
 * receives the URL and nothing is launched. `target` is a file the stand-in creates atomically: it holds the URL when
 * `recordUrl` is set (the login helper opens it itself) and is empty otherwise (inference only learns that it happened).
 */
export async function writeGeminiBrowserShim(dir: string, target: string, recordUrl: boolean): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const script = ["#!/bin/sh", "# Written by the gateway: the Gemini CLI never opens a browser itself.",
    recordUrl ? 'for last in "$@"; do :; done' : "last=",
    `printf '%s\\n' "$last" > ${quoted(`${target}.tmp`)} && mv ${quoted(`${target}.tmp`)} ${quoted(target)}`, "exit 0", ""].join("\n");
  for (const name of ["open", "xdg-open"]) await writeFile(join(dir, name), script, { mode: 0o700 });
}

/** The error inference reports when the CLI asked for a browser sign-in: the saved sign-in cannot be used. Fixed text only. */
export const geminiSignInExpired = (): ProviderError => new ProviderError("authentication",
  "Gemini's saved Google sign-in can no longer be used. Run `gateway login gemini` or use Reconnect in the app.", 401, { code: "authentication_failed", event: "gemini.result" });

/**
 * Everything one live Gemini process needs inside `directory` (the session's own private folder): its disposable home,
 * the browser stand-ins, and the environment that names them. Inference must never open a browser. A sign-in that cannot
 * refresh makes the CLI wait for a browser consent before it answers `initialize`; it does that by running the opener,
 * which here is a stand-in that leaves a marker, and `bootFault` turns the marker into a 401 at once.
 */
export async function provisionGeminiHome(home: string, directory: string): Promise<AcpProvisioned> {
  const scratch = join(directory, "home"); const shims = join(directory, "bin"); const marker = join(directory, "browser-requested");
  // Say whose folder this is before it holds a credential, and clear what a killed gateway left from an earlier run.
  await markGeminiScratchOwner(directory); sweepGeminiScratchOnce();
  await prepareGeminiScratchHome(scratch);
  const before = await copyGeminiCredentialsIn(home, scratch);
  await writeGeminiBrowserShim(shims, marker, false);
  return {
    env: geminiEnv(scratch, { shimDir: shims }),
    bootFault: async () => await access(marker, constants.F_OK).then(() => geminiSignInExpired(), () => undefined),
    release: () => copyGeminiCredentialsBack(home, scratch, before),
  };
}
