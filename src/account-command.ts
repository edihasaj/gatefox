import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertAccountId, inspectAccountHome } from "./account-engine-home.js";
import { inspectAccountLease } from "./account-lease.js";
import { loginAccount, logoutAccount, identityPath, loginStatus, readIdentity, nativeIdentityPath, resolveSignedCodex } from "./account-login.js";
import { claudeAccountEnvironment, claudeAuthDirectory, claudeStatus, loginClaude, logoutClaude, readClaudeToken } from "./account-claude.js";
import { discoverModels, loadDiscoveredModels, type DiscoveredModel } from "./catalog.js";
import { loadConfig, validateConfig, writePrivateJson, type GatewayConfig, type ProviderConfig } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";

/** gateway account add|login|status|logout|list <name>. Not wired into cli.ts yet; output never holds an email, token or env value. */
export type AccountType = "codex" | "claude";
export interface AccountCommandOptions {
  configPath: string; write?: (text: string) => void; env?: NodeJS.ProcessEnv; app?: string; nativeHome?: string; stdio?: "inherit" | "ignore";
  preflightTimeoutMs?: number; discover?: (provider: ProviderConfig) => Promise<DiscoveredModel[]>;
}
export interface AccountView { id: string; type: AccountType; label: string; loggedIn: boolean | "unknown"; identity: "verified" | "missing"; owner?: string; problem?: string }

const usage = "Usage: gateway account add|login|status|logout|list <name> [--type codex|claude] [--label TEXT] [--workspace-id ID] [--codex PATH] [--claude PATH] [--browser] [--token-env VAR] [--remove] [--json]";
const valueFlags = new Set(["--type", "--label", "--workspace-id", "--codex", "--claude", "--token-env"]); const booleanFlags = new Set(["--browser", "--remove", "--json"]);
interface Parsed { action: string; name?: string; flags: Map<string, string | true> }
function parse(args: string[]): Parsed {
  const flags = new Map<string, string | true>(); const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (valueFlags.has(arg)) { const value = args[++index]; if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`); flags.set(arg, value); }
    else if (booleanFlags.has(arg)) flags.set(arg, true);
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}. ${usage}`);
    else positional.push(arg);
  }
  if (flags.has("--with-api-key") || flags.has("--with-access-token")) throw new Error("Token logins are not offered; sign in with the device code");
  return { action: positional[0] ?? "", name: positional[1], flags };
}
const flag = (parsed: Parsed, name: string): string | undefined => typeof parsed.flags.get(name) === "string" ? parsed.flags.get(name) as string : undefined;

/** The stored type: an accountEngines entry is codex; a claude-subscription provider with that ID is claude. */
export function accountType(config: GatewayConfig, name: string): AccountType | undefined {
  const entry = config.accountEngines?.find(account => account.id === name); if (entry) return entry.type ?? "codex";
  const provider = config.providers.find(candidate => candidate.id === name);
  if (!provider || provider.type === "codex-subscription") return;
  if (provider.type === "claude-subscription") return "claude";
  throw new Error(`${name} is already a ${provider.type} provider; choose another account name`);
}
const labelOf = (config: GatewayConfig, name: string): string => config.accountEngines?.find(a => a.id === name)?.label ?? config.providers.find(p => p.id === name)?.label ?? name;

async function updateConfig(path: string, mutate: (source: GatewayConfig) => void): Promise<void> {
  await withPrivateFileLock(path, async () => {
    let source: GatewayConfig; try { source = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Configuration file is unreadable or invalid JSON"); }
    mutate(source); validateConfig(structuredClone(source), dirname(resolve(path)));
    await writePrivateJson(path, source);
  });
}

/** Writes the account entry. A new name needs a type; an existing name keeps its type and may change its label. */
async function addAccount(options: AccountCommandOptions, name: string, type: AccountType | undefined, label: string | undefined, workspaceId: string | undefined): Promise<AccountType> {
  assertAccountId(name); const config = await loadConfig(options.configPath); const stored = accountType(config, name);
  if (stored && type && type !== stored) throw new Error(`${name} is a ${stored} account; it cannot become ${type}`);
  const chosen = stored ?? type; if (!chosen) throw new Error("Choose --type codex or --type claude");
  await updateConfig(options.configPath, source => {
    if (chosen === "codex") {
      const list = source.accountEngines ??= []; const found = list.find(account => account.id === name);
      if (found) { if (label !== undefined) found.label = label; if (workspaceId !== undefined) found.workspaceId = workspaceId; }
      else list.push({ id: name, type: "codex", label: label ?? name, ...(workspaceId ? { workspaceId } : {}) });
    } else {
      const found = source.providers.find(provider => provider.id === name);
      if (found) { if (label !== undefined) found.label = label; }
      // The seed is replaced by the models the CLI reports after sign-in.
      else source.providers.push({ id: name, type: "claude-subscription", label: label ?? name, authDirectory: claudeAuthDirectory(config.stateDirectory, name), models: { [`${name}/sonnet`]: "sonnet" } });
    }
  });
  return chosen;
}

async function viewAccount(config: GatewayConfig, id: string, options: AccountCommandOptions, probe: boolean, codexFlag?: string, claudeFlag?: string): Promise<AccountView> {
  const type = accountType(config, id)!; const state = config.stateDirectory; const nativeHome = options.nativeHome;
  const identity = await readIdentity(identityPath(state, id)).then(found => found ? "verified" as const : "missing" as const, () => "missing" as const);
  const lease = await inspectAccountLease(state, id).catch(() => undefined); const owner = lease ? `${lease.holder} (pid ${lease.pid})` : undefined;
  const base = { id, type, label: labelOf(config, id), identity, ...(owner ? { owner } : {}) };
  if (type === "claude") {
    let loggedIn: boolean | "unknown" = !!await readClaudeToken(state, id).catch(() => undefined) || identity === "verified" ? "unknown" : false;
    if (probe && !lease) {
      const token = await readClaudeToken(state, id).catch(() => undefined);
      loggedIn = await claudeStatus(claudeFlag ?? "claude", claudeAccountEnvironment(options.env ?? process.env, claudeAuthDirectory(state, id), token)).then(status => status.loggedIn, () => "unknown" as const);
    }
    return { ...base, loggedIn };
  }
  const home = await inspectAccountHome(state, id, nativeHome);
  if (home.problem) return { ...base, loggedIn: false, problem: home.problem };
  let loggedIn: boolean | "unknown" = home.authPresent;
  if (probe && !lease && home.exists) {
    try { const signed = await resolveSignedCodex(options.configPath, codexFlag, { app: options.app, config }); loggedIn = await loginStatus(signed.codex, home.home, nativeHome ?? signed.nativeHome, config.accountEngines?.find(a => a.id === id)?.workspaceId); }
    catch { loggedIn = "unknown"; }
  }
  return { ...base, loggedIn };
}
const line = (view: AccountView): string => `${view.id}  ${view.type}  ${view.label}  ${view.loggedIn === "unknown" ? "login unknown" : view.loggedIn ? "logged in" : "not logged in"}  identity ${view.identity}${view.owner ? `  owner ${view.owner}` : ""}${view.problem ? `  problem: ${view.problem}` : ""}`;

/** Runs one subcommand and returns the process exit code. Errors are written as one safe line. */
export async function accountCommand(args: string[], options: AccountCommandOptions): Promise<number> {
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  try {
    const parsed = parse(args); const json = parsed.flags.has("--json"); const env = options.env ?? process.env;
    const type = flag(parsed, "--type"); if (type !== undefined && type !== "codex" && type !== "claude") throw new Error("Choose --type codex or --type claude");
    const label = flag(parsed, "--label"); const workspaceId = flag(parsed, "--workspace-id"); const name = parsed.name;
    if (parsed.action === "list" || (parsed.action === "status" && !name)) {
      const config = await loadConfig(options.configPath); const ids = [...(config.accountEngines ?? []).map(a => a.id), ...config.providers.filter(p => p.type === "claude-subscription" && accountType(config, p.id) && p.authDirectory === claudeAuthDirectory(config.stateDirectory, p.id)).map(p => p.id)];
      const views = await Promise.all(ids.map(id => viewAccount(config, id, options, parsed.action === "status", flag(parsed, "--codex"), flag(parsed, "--claude"))));
      write(json ? JSON.stringify(views) + "\n" : views.length ? views.map(line).join("\n") + "\n" : "No accounts configured\n"); return 0;
    }
    if (!["add", "login", "status", "logout"].includes(parsed.action) || !name) throw new Error(usage);
    assertAccountId(name);
    if (parsed.action === "add") { const added = await addAccount(options, name, type as AccountType | undefined, label, workspaceId); write(`${name}: ${added} account configured\n`); return 0; }
    let config = await loadConfig(options.configPath); let stored = accountType(config, name);
    if (parsed.action === "status") {
      if (!stored) throw new Error(`Unknown account ${name}; run gateway account add ${name} --type codex|claude`);
      const view = await viewAccount(config, name, options, true, flag(parsed, "--codex"), flag(parsed, "--claude"));
      write(json ? JSON.stringify(view) + "\n" : line(view) + "\n"); return 0;
    }
    if (parsed.action === "login") {
      if (!stored) { if (!type) throw new Error("Choose --type codex or --type claude"); }
      stored = await addAccount(options, name, type as AccountType | undefined, stored ? label : label ?? name, workspaceId); config = await loadConfig(options.configPath);
      if (stored === "codex") await loginAccount({ configPath: options.configPath, id: name, codex: flag(parsed, "--codex"), browser: parsed.flags.has("--browser"), app: options.app, nativeHome: options.nativeHome, stdio: options.stdio, write, preflightTimeoutMs: options.preflightTimeoutMs });
      else {
        await loginClaude({ state: config.stateDirectory, id: name, label: labelOf(config, name), claude: flag(parsed, "--claude") ?? "claude", env, tokenEnv: flag(parsed, "--token-env"), stdio: options.stdio, write,
          otherIds: config.providers.filter(p => p.id !== name && accountType(config, p.id) === "claude").map(p => p.id) });
        await refreshClaudeModels(options, name, write);
      }
      return 0;
    }
    if (!stored) throw new Error(`Unknown account ${name}`);
    if (stored === "codex") await logoutAccount({ configPath: options.configPath, id: name, codex: flag(parsed, "--codex"), app: options.app, nativeHome: options.nativeHome, write });
    else write(`${name}: ${await logoutClaude(config.stateDirectory, name, flag(parsed, "--claude") ?? "claude", env) ? "signed out" : "was not signed in"}\n`);
    if (parsed.flags.has("--remove")) {
      await updateConfig(options.configPath, source => { source.accountEngines = source.accountEngines?.filter(a => a.id !== name); if (!source.accountEngines?.length) delete source.accountEngines; if (stored === "claude") source.providers = source.providers.filter(p => p.id !== name); });
      write(`${name}: removed from the configuration\n`);
    }
    return 0;
  } catch (error) { write(`${error instanceof Error ? error.message : "The account command failed"}\n`); return 1; }
}

/** After a Claude sign-in, the picker rows come from the CLI's own model list; a failure keeps the seed row. */
async function refreshClaudeModels(options: AccountCommandOptions, name: string, write: (text: string) => void): Promise<void> {
  try {
    const provider = (await loadConfig(options.configPath)).providers.find(p => p.id === name)!;
    const token = await readClaudeToken((await loadConfig(options.configPath)).stateDirectory, name).catch(() => undefined);
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN; if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    let discovered: DiscoveredModel[]; try { discovered = await (options.discover ?? discoverModels)(provider); } finally { if (token) { if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous; } }
    if (!discovered.length) throw new Error("no models");
    loadDiscoveredModels(provider, discovered);
    await updateConfig(options.configPath, source => { const target = source.providers.find(p => p.id === name)!; target.models = provider.models; target.modelMetadata = provider.modelMetadata; });
    write(`${name}: ${Object.keys(provider.models).length} models available\n`);
  } catch { write(`${name}: model discovery failed; run gateway discover to refresh the model list\n`); }
}

export interface AccountDoctorRow { id: string; type: AccountType; ready: boolean; detail: string }
/** Reads files only and spawns nothing: ready means the home or directory exists with credentials and a recorded identity. */
export async function accountDoctor(configPath: string, nativeHome?: string): Promise<AccountDoctorRow[]> {
  const config = await loadConfig(configPath); const state = config.stateDirectory; const rows: AccountDoctorRow[] = [];
  const native = await readIdentity(nativeIdentityPath(state)).then(found => !!found, () => false);
  for (const entry of config.accountEngines ?? []) {
    const home = await inspectAccountHome(state, entry.id, nativeHome); const identity = await readIdentity(identityPath(state, entry.id)).catch(() => undefined);
    const detail = home.problem ?? (!home.exists ? `not set up; run gateway account login ${entry.id}` : !home.authPresent ? `not logged in; run gateway account login ${entry.id}` : !identity ? "logged in but identity unverified; run login again"
      : !native ? "identity recorded; open the ChatGPT app once to record the native identity" : "logged in, identity verified");
    rows.push({ id: entry.id, type: "codex", ready: !home.problem && home.authPresent && !!identity, detail });
  }
  for (const provider of config.providers) {
    if (accountType(config, provider.id) !== "claude" || provider.authDirectory !== claudeAuthDirectory(state, provider.id)) continue;
    const identity = await readIdentity(identityPath(state, provider.id)).catch(() => undefined);
    rows.push({ id: provider.id, type: "claude", ready: !!identity, detail: identity ? "logged in, identity verified" : `not logged in; run gateway account login ${provider.id}` });
  }
  return rows;
}
