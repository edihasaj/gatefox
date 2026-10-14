import { spawn, type StdioOptions } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { accountDirectory, ensureAccountDirectory } from "./account-engine-home.js";
import { emailHash, identityPath, readIdentity, sameIdentity, type AccountIdentity } from "./account-login.js";
import { writePrivateJson } from "./config.js";

/** Claude accounts: the official CLI signs in under its own CLAUDE_CONFIG_DIR; only a hashed identity is kept. Output never holds an email or token. */
export const claudeAuthDirectory = (state: string, id: string): string => join(accountDirectory(state, id), "claude");
export const claudeTokenPath = (state: string, id: string): string => join(claudeAuthDirectory(state, id), "oauth-token");
const credentialVariables = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];

/** The caller's environment without Claude credentials, then this account's directory and (token profiles) its token. */
export function claudeAccountEnvironment(base: NodeJS.ProcessEnv, directory?: string, token?: string): NodeJS.ProcessEnv {
  const env = { ...base }; for (const key of credentialVariables) delete env[key];
  if (directory) env.CLAUDE_CONFIG_DIR = directory;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

export async function ensureClaudeDirectory(state: string, id: string): Promise<string> {
  await ensureAccountDirectory(state, id); const directory = claudeAuthDirectory(state, id);
  await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("The Claude account directory must be private, owned by this user and not a link");
  return directory;
}

/** Stores a token read from the caller's environment; it is never printed. */
export async function storeClaudeToken(state: string, id: string, token: string): Promise<void> {
  await ensureClaudeDirectory(state, id); const path = claudeTokenPath(state, id); const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(token + "\n"); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
export async function readClaudeToken(state: string, id: string): Promise<string | undefined> {
  const path = claudeTokenPath(state, id);
  const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("The Claude token is not a private file owned by this user");
  return (await readFile(path, "utf8")).trim() || undefined;
}
export const removeClaudeToken = (state: string, id: string): Promise<void> => unlink(claudeTokenPath(state, id)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });

function run(claude: string, args: string[], env: NodeJS.ProcessEnv, stdio: StdioOptions, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(claude, args, { env, stdio }); let output = "";
    const take = (chunk: Buffer) => { if (output.length < 65536) output += chunk.toString("utf8"); };
    child.stdout?.on("data", take); child.stderr?.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs); timer.unref();
    child.once("error", () => { clearTimeout(timer); reject(new Error("The claude command could not be started")); });
    child.once("close", code => { clearTimeout(timer); resolveRun({ code, output }); });
  });
}

export interface ClaudeStatus { loggedIn: boolean; emailSha256?: string; planType?: string }
/** `claude auth status --json`, kept in memory: only a boolean, a hash and a plan label leave this function. */
export async function claudeStatus(claude: string, env: NodeJS.ProcessEnv): Promise<ClaudeStatus> {
  const { code, output } = await run(claude, ["auth", "status", "--json"], env, ["ignore", "pipe", "pipe"], 15000);
  let value: Record<string, unknown>; try { value = JSON.parse(output); } catch { value = {}; }
  if (typeof value.loggedIn !== "boolean") { if (code === 0) throw new Error("Could not read the Claude login status; nothing was changed"); return { loggedIn: false }; }
  if (!value.loggedIn) return { loggedIn: false };
  const plan = typeof value.subscriptionType === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value.subscriptionType) ? value.subscriptionType : "unknown";
  return { loggedIn: true, planType: plan, ...(typeof value.email === "string" && value.email.trim() ? { emailSha256: emailHash(value.email) } : {}) };
}

export interface ClaudeLoginOptions { state: string; id: string; label: string; claude: string; env: NodeJS.ProcessEnv; tokenEnv?: string; stdio?: "inherit" | "ignore"; write: (text: string) => void; otherIds: string[] }
/** Signs in under the account's own directory, then refuses an identity equal to the default login or another configured account. */
export async function loginClaude(options: ClaudeLoginOptions): Promise<{ planType: string }> {
  const { state, id, label, claude, env, write } = options; const directory = await ensureClaudeDirectory(state, id);
  const forget = async () => { await removeClaudeToken(state, id); await run(claude, ["auth", "logout"], claudeAccountEnvironment(env, directory), ["ignore", "pipe", "pipe"], 30000).catch(() => {}); };
  await unlink(identityPath(state, id)).catch(() => {});
  let token: string | undefined;
  if (options.tokenEnv) {
    token = env[options.tokenEnv]?.trim();
    if (!token) throw new Error(`${options.tokenEnv} is not set in this environment; nothing was changed`);
    await storeClaudeToken(state, id, token);
  } else {
    if ((await claudeStatus(claude, claudeAccountEnvironment(env, directory))).loggedIn) throw new Error(`${id} is already logged in; run gateway account logout ${id} first`);
    write(`${id}: sign in as the ${label} Claude user, never the default login. Use a private window or that user's browser profile.\n`);
    const result = await run(claude, ["auth", "login", "--claudeai"], claudeAccountEnvironment(env, directory), ["ignore", options.stdio ?? "inherit", options.stdio ?? "inherit"], 20 * 60000);
    if (result.code !== 0) throw new Error("Sign-in did not finish; nothing was recorded. Run the command again to retry");
  }
  try {
    const status = await claudeStatus(claude, claudeAccountEnvironment(env, directory, token));
    if (!status.loggedIn) throw new Error("Claude reports no login for this account; nothing was recorded");
    if (!status.emailSha256) throw new Error("The signed-in Claude account has no email to verify; nothing was recorded");
    const others: Array<[string, AccountIdentity | undefined]> = [];
    const fallback = await claudeStatus(claude, claudeAccountEnvironment(env));
    if (fallback.loggedIn && fallback.emailSha256) others.push(["the default Claude login", { version: 1, emailSha256: fallback.emailSha256 }]);
    for (const other of options.otherIds) others.push([`account ${other}`, await readIdentity(identityPath(state, other))]);
    const clash = others.find(([, other]) => other && sameIdentity(status.emailSha256!, undefined, other));
    if (clash) throw new Error(`This sign-in is the same Claude user as ${clash[0]}, so nothing was recorded. Sign in as the ${label} user instead`);
    await writePrivateJson(identityPath(state, id), { version: 1, emailSha256: status.emailSha256, planType: status.planType, verifiedAt: new Date().toISOString() } satisfies AccountIdentity);
    write(`${id}: signed in (plan: ${status.planType})\n`);
    return { planType: status.planType! };
  } catch (error) { await forget(); throw error; }
}

/** Official logout in the account's directory; a token profile just loses its token file. */
export async function logoutClaude(state: string, id: string, claude: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const directory = claudeAuthDirectory(state, id); const had = !!await readClaudeToken(state, id);
  if (!await lstat(directory).then(() => true, () => false)) return false;
  await removeClaudeToken(state, id);
  const { code } = await run(claude, ["auth", "logout"], claudeAccountEnvironment(env, directory), ["ignore", "pipe", "pipe"], 30000);
  if (code !== 0 && !had) throw new Error(`Sign-out failed; retry gateway account logout ${id}`);
  await unlink(identityPath(state, id)).catch(() => {});
  return true;
}
