import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig, writePrivateJson } from "./config.js";

/**
 * `gatefox setup --from-host HOST`: copy another Mac's accounts, models and routing into this Mac's configuration over
 * SSH, so a new Mac does not rebuild them by hand. Only settings travel. Sign-ins and API keys never do: each account
 * signs in again on this Mac and each API key is copied on purpose by the owner. Host-specific settings (port, state
 * directory, tailnet listener, availability tools) stay local.
 */
export interface RemoteGateway { home: string; config: Record<string, unknown> }
type Provider = Record<string, unknown> & { id: string; type: string };

const run = promisify(execFile);
/** Settings that describe the shared setup rather than the machine. */
const shared = ["providers", "maxConcurrent", "chatIdentity", "nativeModelPicker", "nativeModelPickerPlacement", "autoLatestModels", "trustAllProjects", "managedRouting"];
const remoteScript = 'printf "%s\\n" "$HOME"; for f in "$HOME/Library/Application Support/GateFox/gateway.json" "$HOME/Library/Application Support/Subscription Gateway/gateway.json"; do if [ -f "$f" ]; then exec cat "$f"; fi; done; exit 3';

export async function readRemoteGateway(host: string): Promise<RemoteGateway> {
  if (!/^[A-Za-z0-9._@:-]+$/.test(host) || host.startsWith("-")) throw new Error("--from-host must be an SSH host name or alias");
  let stdout: string;
  try { ({ stdout } = await run("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "RequestTTY=no", "--", host, remoteScript], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })); }
  catch (error) {
    if ((error as { code?: number }).code === 3) throw new Error(`${host} has no GateFox configuration`);
    throw new Error(`Could not read GateFox settings from ${host} over SSH (${(error as Error).message.split("\n")[0]}); check that ssh ${host} works without a password prompt`);
  }
  const newline = stdout.indexOf("\n");
  return { home: stdout.slice(0, newline).trim(), config: JSON.parse(stdout.slice(newline + 1)) as Record<string, unknown> };
}

/** Rewrites one remote provider for this Mac: credentials point into this Mac's state, Claude sign-in folders into this home. */
export function localProvider(provider: Provider, remoteHome: string, state: string, home = homedir()): { provider: Provider; needs?: string } {
  const result: Provider = { ...provider };
  if (provider.type === "codex-subscription") { result.credentialFile = join(state, "credentials", `${provider.id}.json`); return { provider: result, needs: "login" }; }
  if (provider.type === "claude-subscription") {
    const auth = typeof provider.authDirectory === "string" ? provider.authDirectory : undefined;
    if (auth && remoteHome && (auth === remoteHome || auth.startsWith(remoteHome + "/"))) result.authDirectory = home + auth.slice(remoteHome.length);
    return { provider: result, needs: "login" };
  }
  if (typeof provider.credentialFile === "string") { result.credentialFile = join(state, "credentials", `${provider.id}.token`); return { provider: result, needs: "key" }; }
  if (typeof provider.apiKeyEnv === "string") return { provider: result, needs: "env" };
  return { provider: result };
}

export async function setupFromHost(host: string, destination: string, read: (host: string) => Promise<RemoteGateway> = readRemoteGateway): Promise<Record<string, unknown>> {
  const remote = await read(host);
  if (remote.config.clientOnly) throw new Error(`${host} uses another Mac's gateway; copy from the Mac that runs it`);
  if (!Array.isArray(remote.config.providers) || !remote.config.providers.length) throw new Error(`${host} has no accounts to copy`);
  let local: Record<string, unknown>;
  try { local = JSON.parse(await readFile(destination, "utf8")) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; local = { version: 1, port: 3457, stateDirectory: "state", providers: [] }; }
  if (local.clientOnly) throw new Error("This Mac is set up as a client of another gateway; remove that configuration first");
  const state = typeof local.stateDirectory === "string" ? local.stateDirectory : "state";
  const stateAbsolute = isAbsolute(state) ? state : resolve(dirname(destination), state);
  const kept = (Array.isArray(local.providers) ? local.providers as Provider[] : []).filter(provider => !(remote.config.providers as Provider[]).some(other => other.id === provider.id));
  const next: string[] = []; const copied: Provider[] = [];
  for (const provider of remote.config.providers as Provider[]) {
    const { provider: rewritten, needs } = localProvider(provider, remote.home, state);
    copied.push(rewritten);
    if (needs === "login") {
      const signedIn = provider.type === "codex-subscription" ? await present(resolve(stateAbsolute, "credentials", `${provider.id}.json`)) : false;
      if (!signedIn) next.push(`gatefox login ${provider.id} --account-email EMAIL`);
    }
    if (needs === "key" && !await present(resolve(stateAbsolute, "credentials", `${provider.id}.token`))) next.push(`Copy the ${provider.id} API key into ${resolve(stateAbsolute, "credentials", `${provider.id}.token`)} (chmod 600)`);
    if (needs === "env") next.push(`Set ${String(provider.apiKeyEnv)} for ${provider.id} in the service environment`);
  }
  const merged: Record<string, unknown> = { ...local };
  for (const key of shared) if (key !== "providers" && remote.config[key] !== undefined) merged[key] = remote.config[key];
  merged.providers = [...copied, ...kept];
  // Validate before replacing anything: write beside the destination, load it, then move it into place.
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await mkdir(stateAbsolute, { recursive: true, mode: 0o700 });
  const staged = `${destination}.from-host`;
  await writePrivateJson(staged, merged);
  try { await loadConfig(staged); } catch (error) { throw new Error(`The settings copied from ${host} are not valid here: ${(error as Error).message} (left in ${staged})`); }
  await rename(staged, destination);
  next.push("gatefox setup --local");
  return { configured: true, config: destination, from: host, providers: copied.map(provider => provider.id), keptLocal: kept.map(provider => provider.id), credentialsCopied: false, next };
}

const present = (path: string) => access(path).then(() => true, () => false);
