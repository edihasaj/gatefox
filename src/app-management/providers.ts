import { access, constants, lstat, realpath } from "node:fs/promises";
import { delimiter, dirname, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { hasPlanLogin } from "../auth/chatgpt.js";
import type { ProviderConfig, ProviderKind } from "../config.js";
import type { CatalogEntry, ManagementDependencies, ManagedModel, ManagedProvider, Prerequisite } from "./types.js";
import { ManagementError } from "./errors.js";
import { providerCommand, type ProviderTool } from "../provider-tool-runtime.js";
import { pickerHidden } from "../model-auto-latest/metadata.js";

const apiKinds = new Set<ProviderKind>(["responses-api", "anthropic-api", "chat-completions-api"]);
const cliFor: Partial<Record<ProviderKind, string>> = { "claude-subscription": "claude", "copilot-subscription": "copilot" };
/** Grok signs in through its own CLI and has no verified catalog route: it is listed, never probed or signed in here. */
const existingCliFor: Partial<Record<ProviderKind, string>> = { "grok-subscription": "grok" };
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export const isApiKind = (type: ProviderKind): boolean => apiKinds.has(type);
export const validModelId = (value: unknown): value is string => typeof value === "string" && modelId.test(value);

function inside(root: string, value: string): boolean {
  const rest = relative(root, value); return rest !== "" && !rest.startsWith("..") && !rest.includes("/../");
}
function nativeAuthRoot(path: string): boolean {
  const home = resolve(homedir()); return [".codex", ".claude", ".copilot", ".config/gh"].some(name => {
    const root = resolve(home, name); return path === root || path.startsWith(`${root}/`);
  });
}
async function privateFile(path: string): Promise<boolean> {
  try { const info = await lstat(path); return !info.isSymbolicLink() && info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o600; }
  catch { return false; }
}
async function privateDirectoryTree(state: string, parent: string): Promise<boolean> {
  const segments = relative(state, parent).split("/").filter(Boolean); let current = state;
  for (const segment of ["", ...segments]) {
    if (segment) current = resolve(current, segment);
    try {
      const info = await lstat(current);
      const stateRoot = !segment;
      if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (stateRoot ? (info.mode & 0o022) !== 0 : (info.mode & 0o777) !== 0o700)) return false;
    } catch { return false; }
  }
  return true;
}
/** The management reconnect contract: private existing file, realpath containment, never native auth. */
export async function managedCredentialFile(stateDirectory: string, credentialFile: string): Promise<boolean> {
  const state = resolve(stateDirectory); const file = resolve(credentialFile);
  if (!inside(state, file) || nativeAuthRoot(state) || !await privateFile(file) || !await privateDirectoryTree(state, dirname(file))) return false;
  try {
    const [realState, realParent, realFile] = await Promise.all([realpath(state), realpath(dirname(file)), realpath(file)]);
    return (realParent === realState || inside(realState, realParent)) && inside(realState, realFile);
  } catch { return false; }
}

export async function providerPrerequisites(lookup: ManagementDependencies["lookupCli"] = cliAvailable, kinds: Iterable<ProviderKind> = []): Promise<Prerequisite[]> {
  const required = new Set(kinds); const result: Prerequisite[] = [];
  if (required.has("claude-subscription")) result.push({ id: "claude", label: "Claude Code", downloadURL: "https://docs.anthropic.com/en/docs/claude-code", available: await lookup("claude") });
  if (required.has("copilot-subscription")) result.push({ id: "copilot", label: "GitHub Copilot CLI", downloadURL: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli", available: await lookup("copilot") });
  if (required.has("codex-subscription")) result.push({ id: "codex-desktop", label: "Codex desktop app", downloadURL: "https://chatgpt.com/codex", available: await codexDesktopAvailable() });
  return result;
}
async function codexDesktopAvailable(): Promise<boolean> {
  for (const path of ["/Applications/Codex.app", "/Applications/ChatGPT.app", resolve(homedir(), "Applications/Codex.app"), resolve(homedir(), "Applications/ChatGPT.app")]) try { await access(path, constants.R_OK); return true; } catch { /* next */ }
  return false;
}
export async function cliAvailable(command: string): Promise<boolean> {
  let executable = command;
  if (command === "claude" || command === "copilot") {
    try { executable = await providerCommand(command as ProviderTool); } catch { return false; }
  }
  if (executable.includes("/")) return access(executable, constants.X_OK).then(() => true, () => false);
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) try { await access(`${directory}/${executable}`, constants.X_OK); return true; } catch { /* next */ }
  return false;
}

const releasedSeconds = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

export function managedModels(provider: ProviderConfig, catalog: CatalogEntry[] = [], newDraft = false): ManagedModel[] {
  const configured = new Map<string, string[]>(); const visible = new Map<string, string[]>();
  for (const [alias, id] of Object.entries(provider.models || {})) {
    configured.set(id, [...(configured.get(id) || []), alias]);
    // A model whose every alias automatic upkeep hid is listed, but not enabled: the picker no longer offers it.
    if (!pickerHidden(provider.modelMetadata?.[alias])) visible.set(id, [...(visible.get(id) || []), alias]);
  }
  const dated = (id: string, entry?: CatalogEntry): { releasedAt?: number } => {
    const at = releasedSeconds(entry?.metadata?.releasedAt) ?? (configured.get(id) || []).map(alias => releasedSeconds(provider.modelMetadata?.[alias]?.releasedAt)).find(value => value !== undefined);
    return at === undefined ? {} : { releasedAt: at };
  };
  const seen = new Set<string>(); const models: ManagedModel[] = [];
  for (const entry of catalog) {
    if (seen.has(entry.id)) continue; seen.add(entry.id); const aliases = configured.get(entry.id) || []; const shown = visible.get(entry.id) || [];
    const alias = shown[0] ?? aliases[0];
    models.push({ id: entry.id, ...(alias ? { alias } : {}), label: entry.label || entry.id, enabled: newDraft || shown.length > 0, ...dated(entry.id, entry) });
  }
  // A route with no catalog row still shows its saved display name, so a connection without discovery is not blank.
  for (const [id, aliases] of configured) if (!seen.has(id)) {
    const named = aliases.map(alias => provider.modelMetadata?.[alias]?.displayName).find(Boolean); const shown = visible.get(id) || [];
    const alias = shown[0] ?? aliases[0];
    models.push({ id, ...(alias ? { alias } : {}), label: named || id, enabled: shown.length > 0, ...dated(id) });
  }
  return models;
}

export async function managedProvider(provider: ProviderConfig, lookup: ManagementDependencies["lookupCli"] = cliAvailable, catalog: CatalogEntry[] = [], newDraft = false, stateDirectory?: string): Promise<ManagedProvider> {
  const cli = cliFor[provider.type]; const available = cli ? await lookup(cli) : true;
  const state = stateDirectory || (provider.credentialFile ? dirname(dirname(provider.credentialFile)) : undefined);
  const managed = provider.credentialFile && state ? await managedCredentialFile(state, provider.credentialFile) : false;
  const external = isApiKind(provider.type) && (Boolean(provider.apiKeyEnv) || Boolean(provider.credentialFile) && !managed);
  const saved = provider.type === "codex-subscription" ? managed && await hasPlanLogin(provider.credentialFile!) : isApiKind(provider.type) ? managed : false;
  const existing = existingCliFor[provider.type];
  const unchecked = Boolean(cli && available && !newDraft);
  const authState = external ? "external-credential" : !available && cli ? "missing-cli" : saved ? "saved" : existing || unchecked ? "unchecked" : "needs-sign-in";
  const authDetail = external ? "Credential is managed outside Harness Gateway." : !available && cli ? `${cli} is not installed.`
    : saved ? "Saved credentials have not been checked."
    : existing ? "Grok sign-in has not been checked. Manage it with the Grok CLI in this gateway's private home."
    : unchecked ? "Provider sign-in has not been checked. Check connection to verify." : "Sign in is required.";
  return { id: provider.id, label: provider.label || provider.id, type: provider.type, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), authState, authDetail,
    models: managedModels(provider, catalog, newDraft), canDiscover: existing === undefined,
    canReconnect: existing !== undefined ? false : !external && (isApiKind(provider.type) || provider.type === "codex-subscription" ? managed : Boolean(cli && available)) };
}

function loginEnvironment(type: ProviderKind, authDirectory?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  scrubAuthOverrides(env);
  if (type === "claude-subscription") env.DISABLE_AUTOUPDATER = "1";
  if (authDirectory) {
    if (type === "claude-subscription") env.CLAUDE_CONFIG_DIR = authDirectory;
    if (type === "copilot-subscription") env.COPILOT_HOME = authDirectory;
  }
  return env;
}
function scrubAuthOverrides(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_") || key.startsWith("COPILOT_PROVIDER_") || key.startsWith("COPILOT_") || ["CLAUDE_CONFIG_DIR", "CLAUDE_MODEL", "GH_TOKEN", "GITHUB_TOKEN", "NODE_DEBUG"].includes(key)) delete env[key];
}

export async function runSubscriptionLogin(provider: ProviderConfig, deps: ManagementDependencies, expectedEmail?: string): Promise<void> {
  if (deps.signal?.aborted) throw new ManagementError("authentication_failed");
  if (provider.type === "codex-subscription") {
    if (!provider.credentialFile || !deps.signIn) throw new ManagementError("authentication_failed");
    await deps.signIn(provider.credentialFile, provider.agentName || "Harness Gateway", deps.openBrowser || openBrowser, deps.signal, expectedEmail); return;
  }
  const command = cliFor[provider.type]; if (!command) throw new ManagementError("authentication_failed");
  if (!await (deps.lookupCli || cliAvailable)(command)) throw new ManagementError("missing_cli");
  const env = loginEnvironment(provider.type, provider.authDirectory);
  const args = provider.type === "claude-subscription"
    ? ["auth", "login", "--claudeai", ...(expectedEmail ? ["--email", expectedEmail] : [])]
    : ["login", "--web-flow", "--no-auto-update"];
  const executable = await providerCommand(command as ProviderTool);
  await (deps.runLogin || childLogin)(executable, args, env, deps.signal);
}
async function openBrowser(url: string): Promise<void> { await childLogin("/usr/bin/open", [url], process.env); }
export async function childLogin(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("cancelled");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore", detached: false, windowsHide: true }); let done = false; let timer: NodeJS.Timeout | undefined;
    const cancel = () => {
      if (done || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      timer = setTimeout(() => {
        if (!done && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 150);
    };
    const finish = (error?: Error) => { if (done) return; done = true; if (timer) clearTimeout(timer); signal?.removeEventListener("abort", cancel); error ? reject(error) : resolve(); };
    signal?.addEventListener("abort", cancel, { once: true }); child.once("error", error => finish(error));
    child.once("exit", code => finish(signal?.aborted ? new Error("cancelled") : code === 0 ? undefined : new Error("login failed")));
    if (signal?.aborted) cancel();
  });
}
