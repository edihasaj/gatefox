import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { withPrivateFileLock } from "../private-file-lock.js";
import type { AcpProvisioned } from "./acp-driver.js";
import { writeGeminiPrivateFile } from "./gemini-home.js";
import { markGeminiScratchOwner, sweepGeminiScratchOnce } from "./gemini-scratch-sweep.js";
import { ProviderError } from "./provider.js";

/**
 * Google moved Google AI Pro and Ultra subscriptions from the Gemini CLI to Antigravity CLI (`agy`) on 18 June 2026, and
 * the Gemini 4 models (Neon, Carbon, Argon, Hydrogen) reach a subscription only there. `agy` keeps everything under
 * `$HOME/.gemini/antigravity-cli/`: the sign-in in `antigravity-oauth-token`, settings in `settings.json`, and a record of
 * every conversation. So the gateway's Gemini home holds the sign-in, and each process runs with `HOME` set to a
 * disposable copy inside its session folder that is deleted when the session ends.
 */
export const antigravityCliDir = (home: string): string => join(home, ".gemini", "antigravity-cli");
export const antigravityTokenFile = (home: string): string => join(antigravityCliDir(home), "antigravity-oauth-token");
const antigravityConfigDir = (home: string): string => join(home, ".gemini", "config");
/** The sign-in and the installation identity are the only files carried into a session's home. */
const carried = ["antigravity-oauth-token", "installation_id"] as const;

async function executable(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return true; } catch { return false; } }

/** PATH first, then Homebrew and the official installer's folder, which a launchd PATH usually lacks. */
export async function antigravityCommand(): Promise<string> {
  for (const directory of (process.env.PATH || "").split(delimiter)) if (directory && await executable(join(directory, "agy"))) return join(directory, "agy");
  for (const fallback of ["/opt/homebrew/bin/agy", join(homedir(), ".local/bin/agy")]) if (await executable(fallback)) return fallback;
  throw new ProviderError("cli_failed", "Antigravity CLI (agy) is not installed; install it and run `gateway login gemini`", 502);
}

/**
 * The CLI's whole environment. Nothing of the caller's environment is passed except what locates programs and the user:
 * `GEMINI_API_KEY` with `modelProvider` would bill the API instead of the subscription, and Google Cloud variables would
 * select application default credentials, so no Google, Gemini, Vertex or Antigravity variable can reach the CLI.
 */
export function antigravityEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: process.env.TMPDIR || "/tmp" };
  for (const name of ["USER", "LOGNAME", "LANG", "LC_ALL"]) if (process.env[name]) env[name] = process.env[name];
  return env;
}

/**
 * The managed `settings.json` of every session home. `strict` makes every native action, file reads included, ask the
 * gateway first, and the gateway refuses all of them except reading the tool schemas the CLI cached from the gateway's
 * own MCP server (antigravity-acp.ts). The deny rules repeat that refusal for every native action kind. `agentMode` is
 * the standard mode, never `auto`, which approves "safe" commands without asking, and AI credits are never spent after
 * the plan's quota runs out.
 */
export function antigravityManagedSettings(): string {
  return `${JSON.stringify({
    toolPermission: "strict", agentMode: "", useG1Credits: false, enableTelemetry: false, allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true, disableSlashCommands: true, modelProvider: "",
    permissions: { deny: ["command(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "download_url(*)"] },
  }, null, 2)}\n`;
}

/** A sign-in is usable when it parses and its token carries both an access and a refresh token. */
export function usableAntigravityToken(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const token = (value as { token?: unknown }).token;
    if (!token || typeof token !== "object" || Array.isArray(token)) return false;
    const { access_token: accessToken, refresh_token: refreshToken } = token as Record<string, unknown>;
    return typeof accessToken === "string" && accessToken.length > 0 && typeof refreshToken === "string" && refreshToken.length > 0;
  } catch { return false; }
}

export async function hasAntigravityLogin(home: string | undefined): Promise<boolean> {
  if (!home) return false;
  return usableAntigravityToken(await readFile(antigravityTokenFile(home), "utf8").catch(() => ""));
}

async function privateDirectory(path: string, what: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new ProviderError("invalid_request", `The gateway's ${what} must be a private directory owned by this user`, 400);
  }
  if (info.mode & 0o077) await chmod(path, 0o700);
}

const signInMessage = "Gemini is not signed in to Antigravity for the gateway. Run `gateway login gemini` in a terminal.";

/** Creates or repairs the private home. `requireLogin: false` prepares it for the sign-in itself. */
export async function ensureAntigravityHome(home: string, options: { requireLogin?: boolean } = {}): Promise<void> {
  await privateDirectory(home, "Gemini home");
  await privateDirectory(join(home, ".gemini"), "Gemini folder");
  await privateDirectory(antigravityCliDir(home), "Antigravity folder");
  if (options.requireLogin === false || await hasAntigravityLogin(home)) return;
  throw new ProviderError("authentication", signInMessage, 401, { code: "authentication_failed", event: "gemini.result" });
}

const readText = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(error => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
});

/**
 * One process's disposable home inside its session folder: the managed settings, an empty MCP configuration (only the
 * gateway's server, passed in `session/new`, reaches the session), and a 0600 copy of the sign-in. A token the CLI
 * refreshed is carried back when the session ends, unless a newer sign-in replaced the one handed out meanwhile.
 */
export async function provisionAntigravityHome(home: string, directory: string): Promise<AcpProvisioned> {
  const scratch = join(directory, "home");
  await markGeminiScratchOwner(directory); sweepGeminiScratchOnce();
  await mkdir(antigravityCliDir(scratch), { recursive: true, mode: 0o700 });
  await mkdir(antigravityConfigDir(scratch), { recursive: true, mode: 0o700 });
  await chmod(scratch, 0o700);
  await writeFile(join(antigravityCliDir(scratch), "settings.json"), antigravityManagedSettings(), { mode: 0o600, flag: "wx" });
  await writeFile(join(antigravityConfigDir(scratch), "mcp_config.json"), `${JSON.stringify({ mcpServers: {} })}\n`, { mode: 0o600, flag: "wx" });
  const before: Partial<Record<typeof carried[number], string>> = {};
  for (const name of carried) {
    const text = await readText(join(antigravityCliDir(home), name));
    if (text === undefined) continue;
    before[name] = text;
    await writeFile(join(antigravityCliDir(scratch), name), text, { mode: 0o600, flag: "wx" });
  }
  if (!before["antigravity-oauth-token"] || !usableAntigravityToken(before["antigravity-oauth-token"])) {
    throw new ProviderError("authentication", signInMessage, 401, { code: "authentication_failed", event: "gemini.result" });
  }
  return {
    env: antigravityEnv(scratch),
    release: async () => {
      const after = await readText(antigravityTokenFile(scratch));
      if (after === undefined || after === before["antigravity-oauth-token"] || !usableAntigravityToken(after)) return;
      await withPrivateFileLock(antigravityTokenFile(home), async () => {
        if (await readText(antigravityTokenFile(home)) === before["antigravity-oauth-token"]) await writeGeminiPrivateFile(antigravityTokenFile(home), after);
      });
    },
  };
}

/**
 * Signs the gateway's home in with `agy acp --login`: it prints a Google sign-in link, and the user pastes back the code
 * the browser shows, so it works over SSH and needs a terminal. Only a usable token written afterwards proves success.
 */
export async function antigravityLogin(home: string): Promise<void> {
  await ensureAntigravityHome(home, { requireLogin: false });
  const child = spawn(await antigravityCommand(), ["acp", "--login", "--disable-telemetry"], { cwd: home, env: antigravityEnv(home), stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Antigravity sign-in did not complete")));
  });
  if (!await hasAntigravityLogin(home)) throw new Error("Antigravity sign-in did not save a usable token");
}
