import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gatewayCommand } from "./command.js";
import { readClientToken } from "./config.js";
import { applyClaudeDesktopProfile, claudeDesktopPaths, readSelectedClaudeDesktopProfile, writeClaudeDesktopCandidate } from "./claude-desktop-files.js";
import { buildClaudeDesktopProfile, type ClaudeDesktopCatalog, type ClaudeDesktopGatewaySource } from "./claude-desktop-profile.js";
import { claudeDesktopServiceStatus, installClaudeDesktopService } from "./claude-desktop-service.js";
import { startClaudeDesktopInference } from "./claude-desktop-inference.js";

const catalogLimitBytes = 1024 * 1024;
const help = `gateway claude-desktop — isolated Claude Desktop aliases

  gateway claude-desktop configure --gateway-config PATH [--home PATH] [--port NUMBER]
    [--primary-claude-provider ID] [--model MODEL] [--endpoint LOOPBACK_URL --token-file PATH] [--apply]
  gateway claude-desktop serve --config ADAPTER_CONFIG.json
  gateway claude-desktop install --config ADAPTER_CONFIG.json [--home PATH]
  gateway claude-desktop status [--config ADAPTER_CONFIG.json] [--home PATH]
  gateway claude-desktop inference --gateway-config PATH --native-config PATH

configure reads the selected Claude Desktop Harness Gateway profile and writes a
candidate under Claude-3p/alias-trial/candidate. --apply requires Claude Desktop
to be quit, writes a recoverable backup, and updates only that selected profile
and the private adapter config. For a separate gateway, use a local http://
loopback SSH forward as --endpoint and pair it with that forward's --token-file.
install is retired: it never creates a separate LaunchAgent. Existing deployments
move under the signed app with gateway service claude-desktop --on-restart.`;

function requireAbsolute(value: string | undefined, name: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function pathsFor(home: string | undefined) {
  const selectedHome = home === undefined ? homedir() : requireAbsolute(home, "--home");
  return claudeDesktopPaths(selectedHome);
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3467");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1 through 65535");
  return port;
}

function readSource(raw: unknown, configPath: string): ClaudeDesktopGatewaySource {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("--gateway-config must contain a JSON object");
  const value = raw as { port?: unknown; stateDirectory?: unknown; providers?: unknown };
  if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) throw new Error("--gateway-config needs a fixed port");
  if (typeof value.stateDirectory !== "string" || !value.stateDirectory) throw new Error("--gateway-config needs stateDirectory");
  if (!Array.isArray(value.providers)) throw new Error("--gateway-config needs a providers array");
  const providers = value.providers.map(provider => {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) throw new Error("Every gateway provider must be an object");
    const item = provider as { id?: unknown; type?: unknown; models?: unknown };
    if (typeof item.id !== "string" || !item.id || typeof item.type !== "string" || !item.type || !item.models || typeof item.models !== "object" || Array.isArray(item.models)) {
      throw new Error("Every gateway provider needs id, type, and models");
    }
    const models: Record<string, string> = {};
    for (const [alias, upstream] of Object.entries(item.models)) {
      if (!alias || typeof upstream !== "string" || !upstream) throw new Error(`Provider ${item.id} has an invalid model mapping`);
      models[alias] = upstream;
    }
    return { id: item.id, type: item.type, models };
  });
  return { port: value.port as number, stateDirectory: resolve(dirname(configPath), value.stateDirectory), providers };
}

async function loadSource(configPath: string): Promise<ClaudeDesktopGatewaySource> {
  let data: unknown;
  try { data = JSON.parse(await readFile(configPath, "utf8")); } catch { throw new Error("--gateway-config is unreadable or invalid JSON"); }
  return readSource(data, configPath);
}

function endpointOrigin(value: string): string {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error("--endpoint must be a valid URL"); }
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const octets = hostname.split(".");
  const loopback = hostname === "localhost" || hostname === "::1"
    || (octets.length === 4 && Number(octets[0]) === 127 && octets.every(octet => /^\d+$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255));
  if (endpoint.protocol !== "http:" || !loopback || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("--endpoint must be an http:// loopback gateway origin");
  }
  const path = endpoint.pathname.replace(/\/+$/, "");
  if (path && path !== "/v1") throw new Error("--endpoint must be a gateway origin or end in /v1");
  endpoint.pathname = ""; endpoint.search = ""; endpoint.hash = "";
  return endpoint.href.replace(/\/$/, "");
}

async function fetchedCatalog(endpoint: string, tokenFile: string): Promise<ClaudeDesktopCatalog> {
  const token = await readClientToken(tokenFile);
  const response = await fetch(`${endpoint}/v1/model-catalog`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Gateway model catalog returned HTTP ${response.status}`);
  const length = response.headers.get("content-length");
  if (length && Number(length) > catalogLimitBytes) throw new Error("Gateway model catalog exceeds 1 MiB");
  const body = await response.text();
  if (Buffer.byteLength(body) > catalogLimitBytes) throw new Error("Gateway model catalog exceeds 1 MiB");
  try { return JSON.parse(body) as ClaudeDesktopCatalog; } catch { throw new Error("Gateway model catalog is invalid JSON"); }
}

async function claudeNotRunning(): Promise<boolean> {
  try {
    await new Promise<void>((resolveResult, reject) => execFile("/usr/bin/pgrep", ["-x", "Claude"], error => error ? reject(error) : resolveResult()));
    return false;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return true;
    throw new Error("Cannot determine whether Claude Desktop is running", { cause: error });
  }
}

async function configure(values: Record<string, string | boolean | undefined>): Promise<void> {
  const gatewayConfig = requireAbsolute(typeof values["gateway-config"] === "string" ? values["gateway-config"] : undefined, "--gateway-config");
  const remoteToken = typeof values["token-file"] === "string" ? requireAbsolute(values["token-file"], "--token-file") : undefined;
  const remoteEndpoint = typeof values.endpoint === "string" ? endpointOrigin(values.endpoint) : undefined;
  if (Boolean(remoteToken) !== Boolean(remoteEndpoint)) throw new Error("--token-file and --endpoint must be provided together");
  const source = await loadSource(gatewayConfig);
  const paths = pathsFor(typeof values.home === "string" ? values.home : undefined);
  const tokenFile = remoteToken ?? resolve(source.stateDirectory, "client-token");
  const endpoint = remoteEndpoint ?? `http://127.0.0.1:${source.port}`;
  const catalog = await fetchedCatalog(endpoint, tokenFile);
  const existing = await readSelectedClaudeDesktopProfile(paths.library);
  const helper = gatewayCommand();
  const built = buildClaudeDesktopProfile(source, catalog, existing.profile, {
    tokenFile, adapterRoot: paths.adapterRoot, adapterPort: parsePort(typeof values.port === "string" ? values.port : undefined),
    primaryClaudeProvider: typeof values["primary-claude-provider"] === "string" ? values["primary-claude-provider"] : undefined,
    defaultModel: typeof values.model === "string" ? values.model : undefined, upstream: endpoint,
    credentialHelper: { command: helper.command, args: [...helper.args, "token"] },
  });
  const candidate = await writeClaudeDesktopCandidate(paths.candidateRoot, built.profile, built.adapterConfig);
  if (values.apply !== true) {
    process.stdout.write(JSON.stringify({ candidate, applied: false }, null, 2) + "\n");
    return;
  }
  const applied = await applyClaudeDesktopProfile({
    library: paths.library, adapterRoot: paths.adapterRoot, backupRoot: paths.backupRoot,
    profile: built.profile, expectedProfile: existing, adapterConfig: built.adapterConfig, protectedPaths: [gatewayConfig],
    appNotRunning: claudeNotRunning,
  });
  process.stdout.write(JSON.stringify({ candidate, applied: true, ...applied }, null, 2) + "\n");
}

async function serve(configPath: string): Promise<void> {
  const config = requireAbsolute(configPath, "--config");
  const adapterModule = new URL("../scripts/claude-desktop-adapter.mjs", import.meta.url).href;
  const adapter = await import(adapterModule) as { startAdapter?: (options: { configPath: string }) => Promise<{ port: number; close: () => Promise<void> }> };
  if (typeof adapter.startAdapter !== "function") throw new Error("Claude Desktop adapter runtime is unavailable");
  const started = await adapter.startAdapter({ configPath: config });
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    void started.close().then(() => { process.exitCode = 0; });
  };
  process.once("SIGINT", close); process.once("SIGTERM", close);
  process.stderr.write(`Claude Desktop adapter listening on http://127.0.0.1:${started.port}\n`);
}

async function inference(gatewayConfig: string, nativeConfig: string): Promise<void> {
  const started = await startClaudeDesktopInference(gatewayConfig, nativeConfig);
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    void started.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 2; });
  };
  process.once("SIGINT", close); process.once("SIGTERM", close);
  process.stderr.write(`Private Claude Desktop inference listening on http://127.0.0.1:${started.port}\n`);
}

export async function runClaudeDesktopCommand(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) { process.stdout.write(help + "\n"); return; }
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      config: { type: "string" }, "gateway-config": { type: "string" }, home: { type: "string" }, port: { type: "string" },
      "primary-claude-provider": { type: "string" }, model: { type: "string" }, apply: { type: "boolean" },
      "token-file": { type: "string" }, endpoint: { type: "string" }, "native-config": { type: "string" },
    },
  });
  const [command, ...extra] = positionals;
  if (extra.length || !["configure", "serve", "install", "status", "inference"].includes(command || "")) throw new Error("Choose claude-desktop configure, serve, install, status, or inference");
  if (command === "configure") {
    if (values.config || values["native-config"]) throw new Error("--config and --native-config are only valid for their matching Claude Desktop command");
    await configure(values); return;
  }
  if (command === "inference") {
    if ([values.config, values.home, values.port, values["primary-claude-provider"], values.model, values.apply, values["token-file"], values.endpoint].some(value => value !== undefined)) {
      throw new Error("Inference accepts only --gateway-config and --native-config");
    }
    await inference(requireAbsolute(values["gateway-config"], "--gateway-config"), requireAbsolute(values["native-config"], "--native-config"));
    return;
  }
  if ([values["gateway-config"], values.port, values["primary-claude-provider"], values.model, values.apply, values["token-file"], values.endpoint, values["native-config"]].some(value => value !== undefined)) {
    throw new Error("Configure options are only valid for claude-desktop configure");
  }
  if (command === "serve") {
    if (values.home) throw new Error("--home is only valid for claude-desktop configure, install, or status");
    await serve(requireAbsolute(values.config, "--config")); return;
  }
  if (command === "install") {
    process.stdout.write(JSON.stringify(await installClaudeDesktopService(requireAbsolute(values.config, "--config"), { home: values.home }), null, 2) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(await claudeDesktopServiceStatus(values.config ? requireAbsolute(values.config, "--config") : undefined, { home: values.home }), null, 2) + "\n");
}
