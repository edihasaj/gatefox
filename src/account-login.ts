import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonLines, object, type Message } from "./app-server-connection.js";
import { loadConfig, writePrivateJson, type GatewayConfig } from "./config.js";
import { readServicePlan, serviceExecutionPaths } from "./service-plan.js";
import { accountDirectory, accountEnvironment, accountPinnedArgs, assertAccountId, defaultNativeHome, ensureAccountHome, inspectAccountHome, writeLoginConfig } from "./account-engine-home.js";
import { acquireAccountLease } from "./account-lease.js";

/** Login, logout and identity checks for one account home. Output never contains an email, token or env value. */
export const appBundleCodex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const gatewaySdkExecutable = fileURLToPath(new URL("../gateway-sdk/gateway-codex", import.meta.url));
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const ignoreMissing = (error: unknown): void => { if (!missing(error)) throw error; };

export interface SignedCodex { codex: string; nativeHome: string; source: "flag" | "service" | "app" }
/** --codex, then the service plan's codex, then the app bundle. Never a PATH lookup or the gateway's own build. */
export async function resolveSignedCodex(configPath: string, flag?: string, options: { app?: string; config?: GatewayConfig } = {}): Promise<SignedCodex> {
  const config = options.config ?? await loadConfig(configPath);
  let planned: { codex: string; nativeHome: string } | undefined;
  try { const plan = await readServicePlan(config.stateDirectory); planned = plan ? serviceExecutionPaths(plan) : undefined; } catch { planned = undefined; }
  const nativeHome = planned?.nativeHome ?? defaultNativeHome();
  if (flag !== undefined) return { codex: await checkSignedCodex(flag), nativeHome, source: "flag" };
  if (planned) return { codex: await checkSignedCodex(planned.codex), nativeHome, source: "service" };
  return { codex: await checkSignedCodex(options.app ? resolve(options.app, "Contents/Resources/codex-cli/bin/codex") : appBundleCodex), nativeHome, source: "app" };
}

export async function checkSignedCodex(path: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("--codex must be the absolute path of the desktop's signed codex; PATH is never searched");
  let real: string; try { real = await realpath(path); } catch { throw new Error("The desktop's signed codex was not found; pass its absolute path with --codex"); }
  if (!(await stat(real)).isFile()) throw new Error("--codex must name an executable file");
  await access(real, constants.X_OK).catch(() => { throw new Error("--codex must name an executable file"); });
  const sdk = await realpath(gatewaySdkExecutable).catch(() => resolve(gatewaySdkExecutable));
  if (real === sdk || basename(real) === "gateway-codex" || real.split(sep).includes("gateway-sdk")) throw new Error("The gateway's own Codex build never logs in an account; use the desktop's signed codex");
  const file = await open(real, constants.O_RDONLY); const head = Buffer.alloc(256);
  try { await file.read(head, 0, head.length, 0); } finally { await file.close(); }
  if (/^#!\/bin\/sh\n# Managed by [^\n]* SSH adapter\n/.test(head.toString("latin1"))) throw new Error("That codex is the gateway's SSH command; pass the desktop's signed codex with --codex");
  return resolve(path);
}

/** Every spawn gets an explicit, real, absolute CODEX_HOME that is not the native home. */
async function guardedSpawn(codex: string, home: string, nativeHome: string, args: string[], stdio: StdioOptions): Promise<ChildProcess> {
  const native = await realpath(nativeHome).catch(() => resolve(nativeHome));
  if (!isAbsolute(home) || await realpath(home) !== home || home === native) throw new Error("Refusing to run codex outside a separate account home");
  return spawn(codex, args, { env: accountEnvironment(home), stdio });
}
const finished = (child: ChildProcess): Promise<number | null> => new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });

/** Output is kept in memory for parsing only: login status can print part of an API key. */
async function captured(codex: string, home: string, nativeHome: string, args: string[], timeoutMs = 30000): Promise<{ code: number | null; output: string }> {
  const child = await guardedSpawn(codex, home, nativeHome, args, ["ignore", "pipe", "pipe"]); let output = "";
  const take = (chunk: Buffer) => { if (output.length < 65536) output += chunk.toString("utf8"); };
  child.stdout!.on("data", take); child.stderr!.on("data", take);
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs); timer.unref();
  try { return { code: await finished(child).catch(() => { throw new Error("The signed codex could not be started"); }), output }; } finally { clearTimeout(timer); }
}

/** True when this home holds any login, false when Codex reports none. Anything else fails closed. */
export async function loginStatus(codex: string, home: string, nativeHome: string, workspaceId?: string): Promise<boolean> {
  const { code, output } = await captured(codex, home, nativeHome, [...accountPinnedArgs(workspaceId), "login", "status"]);
  if (/^Not logged in\s*$/m.test(output)) return false;
  if (code === 0 && /^Logged in using /m.test(output)) return true;
  throw new Error("Could not read this account's login status; nothing was changed");
}

async function interactiveLogin(codex: string, home: string, nativeHome: string, workspaceId: string | undefined, browser: boolean, stdio: "inherit" | "ignore"): Promise<void> {
  // stdin stays closed: token logins over stdin (--with-api-key, --with-access-token) are never offered.
  const child = await guardedSpawn(codex, home, nativeHome, [...accountPinnedArgs(workspaceId), "login", ...(browser ? [] : ["--device-auth"])], ["ignore", stdio, stdio]);
  const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
  const timer = setTimeout(() => child.kill("SIGTERM"), 20 * 60000); timer.unref();
  process.on("SIGINT", forward); process.on("SIGTERM", forward);
  try { if (await finished(child) !== 0) throw new Error("Sign-in did not finish; nothing was recorded. Run the command again to retry"); }
  finally { clearTimeout(timer); process.off("SIGINT", forward); process.off("SIGTERM", forward); }
}

export const emailHash = (email: string): string => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

/** A bounded app-server check: account/read only, memories off, the pinned keys, never the native state DB. */
export async function readAccountIdentity(codex: string, home: string, nativeHome: string, workspaceId?: string, timeoutMs = 20000): Promise<{ emailSha256: string; planType: string }> {
  const child = await guardedSpawn(codex, home, nativeHome, [...accountPinnedArgs(workspaceId), "-c", "features.memories=false", "app-server", "--listen", "stdio://"], ["pipe", "pipe", "ignore"]);
  const pending = new Map<number, (message: Message) => void>(); let sequence = 0; let killTimer: NodeJS.Timeout | undefined;
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  const stop = () => { if (killTimer) return; child.stdin!.end(); child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 1500); killTimer.unref(); };
  const send = (message: Message) => { if (!killTimer) child.stdin!.write(JSON.stringify(message) + "\n"); };
  child.stdin!.on("error", stop);
  const reader = (async () => {
    try {
      for await (const line of jsonLines(child.stdout!)) {
        let message: Message; try { message = object(JSON.parse(line)); } catch { break; }
        if (typeof message.id === "number" && message.method === undefined) { pending.get(message.id)?.(message); pending.delete(message.id); }
        else if (message.id !== undefined && typeof message.method === "string") send({ id: message.id, error: { code: -32601, message: "The account check answers no server requests" } });
      }
    } catch { /* bounded by the deadline */ } finally { stop(); }
  })();
  const rpc = (method: string, params: Message) => new Promise<Message>(resolve => { const id = ++sequence; pending.set(id, resolve); send({ id, method, params }); });
  let deadline: NodeJS.Timeout | undefined;
  const failure = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error("The account check timed out; nothing was recorded")), timeoutMs); deadline.unref();
    void closed.then(() => reject(new Error("The account check stopped early; nothing was recorded")));
  });
  failure.catch(() => {});
  try {
    const response = await Promise.race([(async () => {
      const init = await rpc("initialize", { clientInfo: { name: "gateway_account", title: "Gateway account check", version: "0.1.0" } });
      if (init.error) throw new Error("The account check could not start the signed codex");
      send({ method: "initialized", params: {} });
      return rpc("account/read", { refreshToken: false });
    })(), failure]);
    if (response.error) throw new Error("The account check failed; nothing was recorded");
    const account = object(object(response.result).account);
    if (account.type !== "chatgpt") throw new Error("This home is not signed in with ChatGPT; nothing was recorded");
    if (typeof account.email !== "string" || !account.email.trim()) throw new Error("The signed-in account has no email to verify; nothing was recorded");
    const planType = typeof account.planType === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(account.planType) ? account.planType : "unknown";
    return { emailSha256: emailHash(account.email), planType };
  } finally { clearTimeout(deadline); stop(); await closed; clearTimeout(killTimer); await reader; }
}

export interface AccountIdentity { version: 1; emailSha256: string; planType?: string; verifiedAt?: string; workspaceId?: string }
export const identityPath = (state: string, id: string): string => join(accountDirectory(state, id), "identity.json");
export const nativeIdentityPath = (state: string): string => resolve(state, "native-identity.json");
/** A private identity record (hashes only), or undefined when absent. Invalid records fail closed. */
export async function readIdentity(path: string): Promise<AccountIdentity | undefined> {
  const info = await lstat(path).catch(error => { ignoreMissing(error); return undefined; });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 4096) throw new Error("An identity record is not a private file owned by this user");
  let value: AccountIdentity; try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("An identity record is unreadable"); }
  if (value?.version !== 1 || typeof value.emailSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.emailSha256)
    || value.workspaceId !== undefined && (typeof value.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.workspaceId))) throw new Error("An identity record is invalid");
  return value;
}
/** The same email is a different account only when this account pins a workspace the other one does not share. */
export const sameIdentity = (emailSha256: string, workspaceId: string | undefined, other: AccountIdentity): boolean =>
  other.emailSha256 === emailSha256 && !(workspaceId && workspaceId !== other.workspaceId);

export interface LoginOptions { configPath: string; id: string; codex?: string; browser?: boolean; app?: string; nativeHome?: string; stdio?: "inherit" | "ignore"; write?: (text: string) => void; preflightTimeoutMs?: number }
async function prepare(options: LoginOptions, requireEntry: boolean) {
  assertAccountId(options.id);
  const config = await loadConfig(options.configPath); const entry = config.accountEngines?.find(account => account.id === options.id);
  if (!entry && requireEntry) throw new Error(`Unknown account ${options.id}; run gateway account add ${options.id}`);
  const signed = await resolveSignedCodex(options.configPath, options.codex, { app: options.app, config });
  const nativeHome = options.nativeHome ?? signed.nativeHome; const label = entry?.label || options.id;
  const release = await acquireAccountLease(config.stateDirectory, options.id, "login");
  if (!release) throw new Error(`${label} is in use; finish its chats or quit the app first`);
  return { config, entry, codex: signed.codex, nativeHome, label, release, state: config.stateDirectory, write: options.write ?? ((text: string) => { process.stdout.write(text); }) };
}

/** Device-code sign-in (browser on request) into the account's own home, then a hashed identity check. */
export async function loginAccount(options: LoginOptions): Promise<{ id: string; planType: string; distinctBy: "email" | "workspace" }> {
  const { config, entry, codex, nativeHome, label, release, state, write } = await prepare(options, true);
  const id = entry!.id; const workspaceId = entry!.workspaceId;
  try {
    if (!await readIdentity(nativeIdentityPath(state))) throw new Error("The native account's identity is not recorded yet. Quit the ChatGPT app with Command-Q, reopen it, wait for its model list, then retry");
    const home = await ensureAccountHome(state, id, nativeHome); await writeLoginConfig(home, workspaceId);
    if (await loginStatus(codex, home, nativeHome, workspaceId)) throw new Error(`${id} is already logged in; run gateway account logout ${id} first`);
    await unlink(identityPath(state, id)).catch(ignoreMissing);
    write(`${id}: sign in as the ${label} ChatGPT user, never the native account. Use a private window or that user's browser profile.\n`);
    await interactiveLogin(codex, home, nativeHome, workspaceId, !!options.browser, options.stdio ?? "inherit");
    const identity = await readAccountIdentity(codex, home, nativeHome, workspaceId, options.preflightTimeoutMs);
    const native = await readIdentity(nativeIdentityPath(state));
    const others: Array<[string, Awaited<ReturnType<typeof readIdentity>>]> = [["the native account", native]];
    for (const other of config.accountEngines!.filter(account => account.id !== id)) others.push([`account ${other.id}`, await readIdentity(identityPath(state, other.id))]);
    const clash = others.find(([, other]) => other && sameIdentity(identity.emailSha256, workspaceId, other));
    if (clash) throw new Error(`This sign-in is the same ChatGPT user as ${clash[0]}, so nothing was recorded. Run gateway account logout ${id}, then sign in as the ${label} user${workspaceId ? "" : ", or pin its workspaceId if it is another workspace of the same user"}`);
    await writePrivateJson(identityPath(state, id), { version: 1, emailSha256: identity.emailSha256, planType: identity.planType, verifiedAt: new Date().toISOString(), ...(workspaceId ? { workspaceId } : {}) } satisfies AccountIdentity);
    write(`${id}: signed in (plan: ${identity.planType})\n`);
    return { id, planType: identity.planType, distinctBy: native && native.emailSha256 === identity.emailSha256 ? "workspace" : "email" };
  } finally { await release(); }
}

/** Revokes only this account home's login, then forgets its identity. */
export async function logoutAccount(options: Omit<LoginOptions, "browser">): Promise<{ id: string; loggedOut: boolean }> {
  const { entry, codex, nativeHome, release, state, write } = await prepare(options, false); const id = options.id;
  try {
    const report = await inspectAccountHome(state, id, nativeHome);
    if (report.problem) throw new Error(report.problem);
    if (report.exists) {
      const home = await ensureAccountHome(state, id, nativeHome);
      const { code } = await captured(codex, home, nativeHome, [...accountPinnedArgs(entry?.workspaceId), "logout"]);
      if (code !== 0) throw new Error(`Sign-out failed and the login was kept; retry gateway account logout ${id}`);
      if (await lstat(join(home, "auth.json")).then(() => true, error => { ignoreMissing(error); return false; })) throw new Error(`Sign-out left credentials in the account home; retry gateway account logout ${id}`);
    }
    await unlink(identityPath(state, id)).catch(ignoreMissing);
    write(`${id}: ${report.authPresent ? "signed out" : "was not signed in"}\n`);
    return { id, loggedOut: report.authPresent };
  } finally { await release(); }
}
