#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import { readFile, writeFile, stat, realpath, mkdir } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { macSsh } from "./mac-ssh.js";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadConfig, gatewayToken, writePrivateJson, type GatewayConfig } from "./config.js";
import { signIn } from "./auth/chatgpt.js";
import { modelCatalog, discoverModels, loadDiscoveredModels } from "./catalog.js";
import { codexSettings, remoteCodexSettings, readClientToken } from "./codex-config.js";
import { claudeSettings, remoteClaudeSettings } from "./claude-config.js";
import { codexShim } from "./codex-shim.js";
import { readTelemetry, telemetry } from "./telemetry.js";
import { stopServing } from "./serve-shutdown.js";
import { summarizeTelemetry } from "./diagnostics.js";
import { startServeRuntime } from "./serve-runtime.js";
import { macService } from "./mac-service.js";
import { openCopilot, copilotEnvironment } from "./providers/copilot-client.js";
import { configPath } from "./paths.js";
import { setupGateway, setupClient } from "./setup.js";
import { readClientToken as readPrivateClientToken } from "./config.js";
import { launchDesktop } from "./desktop-launch.js";
import { macTunnel } from "./mac-tunnel.js";
import { uninstallGateway } from "./uninstall.js";
import { macDesktop } from "./mac-desktop.js";
import { macNative } from "./mac-native.js";
import { consolidateService } from "./mac-consolidate.js";
import { stageLoginConsolidation } from "./mac-login-consolidate.js";
import { runServiceDaemon } from "./service-daemon.js";
import { enableSharedExecutors } from "./mac-shared-executors.js";
import { enableSharedNative } from "./mac-shared-native.js";
import { stageNativeSharing } from "./service-native-staging.js";
import { previewClaudeConsolidation, stageClaudeConsolidation } from "./service-claude-staging.js";
import { disableSharing } from "./mac-shared-disable.js";
import { runExecutionHostCommand } from "./execution-host-command.js";
import { safeErrorMessage } from "./error-message.js";
import { versionsCommand } from "./versions.js";
import { healthCommand } from "./health.js";
import { rolloutCommand } from "./rollout.js";
import { daemonConfigStatus } from "./config-rejection.js";
import { toolSearchCommand } from "./tool-search-command.js";
import { runClaudeDesktopCommand } from "./claude-desktop-cli.js";
import { providerCommand } from "./provider-tool-runtime.js";
import { retainCliEntryPoint } from "./release-retention.js";
import { runAutoLatestCli } from "./auto-latest-cli.js";

// This happens before command dispatch. A managed release remains visible to the
// installer even when an app-owned Node executes this file through `current`.
retainCliEntryPoint(import.meta.url);

const help = `gateway — local subscription and API inference

  gateway init [--config PATH]
  gateway setup --from-config PATH [--config DESTINATION]
  gateway setup --client --port PORT --token-file PATH [--config DESTINATION]
  gateway desktop [--config PATH] [--native-home PATH]
  gateway desktop register|unregister|status
  gateway ssh register|unregister|status [--codex ORIGINAL_CLI_PATH]
  gateway native install|status|uninstall [--codex MATCHING_CLI_PATH]
  gateway uninstall
  gateway tunnel install|status|uninstall --tunnel-id NAME [--host HOST --port PORT --remote-port PORT] [--reverse] [--ssh-config PATH]
  gateway serve [--config PATH] [--port NUMBER]
  gateway service install|status|restart|uninstall [--config PATH]
  gateway service consolidate [--apply | --next-login] [--config PATH]
  gateway service claude-desktop [--on-restart [--force]] [--config PATH]
  gateway service shared-executors [--apply] [--disable] [--config PATH]
  gateway service shared-native [--apply] [--disable] [--on-restart [--with-gateway]] [--config PATH]
  gateway executor-host --config PATH --codex PATH --native-home PATH
  gateway providers [--config PATH] [--json]
  gateway discover PROVIDER [--select ID,ID] [--load] [--config PATH]
  gateway catalog [--config PATH] [--model ALIAS]
  gateway tool-search [on|off|status] [--config PATH]   Codex tool search through the gateway (opt-in bridge; default off)
  gateway diagnostics [--since HOURS] [--config PATH]   Summarize local telemetry: turns, failures, cache hits, restarts
  gateway versions [--json] [--check]   Real release of each running gateway process; --check exits 1 if any lags, 2 with no release to compare.
  gateway health [--json] [--push] [--smoke]   Watchdog verdict: app update, releases, service, inference, failures. --push alerts a monitor; exit 0 ok, 1 warn, 2 fail, 3 push failed.
  gateway rollout [--json] [--verify] [--config PATH]   Release readiness from loaded process, service, inference, execution-host and tool-canary evidence.
  gateway login PROVIDER [--config PATH] [--account-email EMAIL] [--no-browser]
  gateway doctor [--config PATH] [--json]
  gateway codex-config --model ALIAS [--config PATH]
  gateway codex-config --model ALIAS --endpoint URL --token-file PATH [--catalog PATH]
  gateway claude-config --model ALIAS [--config PATH]
  gateway claude-config --model ALIAS --endpoint URL --token-file PATH
  gateway claude-desktop configure|serve|install|status [--help]
  gateway codex-shim --config PATH --codex PATH -- CODEX_ARGUMENTS
  gateway token [--config PATH]   Credential helper; prints the local client token.
  gateway token --file PATH      Credential helper for a trusted remote gateway.

Defaults: GATEWAY_CONFIG, ./gateway.local.json, then the installed user configuration.
Help/version require no configuration. API keys are referenced by environment name.
Serve runs in the foreground; Ctrl-C stops requests and children. macOS service setup is explicit.
`;
const defaults: GatewayConfig = { version: 1, port: 3457, stateDirectory: ".state", providers: [
  { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude-sonnet-4-6": "claude-sonnet-4-6" }, modelMetadata: { "claude-sonnet-4-6": { displayName: "Sonnet 4.6", contextWindow: 200000, reasoningEfforts: ["low", "medium", "high"] } } },
  { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: ".state/codex.json", agentName: "Harness Gateway", models: { "codex/gpt-6.1-sol": "gpt-6.1-sol" } },
] };

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "codex-shim") return codexShim(argv.slice(1));
  if (argv[0] === "claude-desktop") return runClaudeDesktopCommand(argv.slice(1));
  if (argv[0] === "versions") { process.exitCode = await versionsCommand(argv.slice(1)); return; }
  if (argv[0] === "health") { process.exitCode = await healthCommand(argv.slice(1)); return; }
  if (argv[0] === "auto-latest") { process.exitCode = await runAutoLatestCli(argv.slice(1)); return; }
  if (argv[0] === "rollout") { process.exitCode = await rolloutCommand(argv.slice(1)); return; }
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(help); return; }
  if (argv.includes("--version")) { process.stdout.write(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version + "\n"); return; }
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    config: { type: "string" }, port: { type: "string" }, json: { type: "boolean" }, since: { type: "string" }, disable: { type: "boolean" }, model: { type: "string" }, "no-browser": { type: "boolean" }, "account-email": { type: "string" }, select: { type: "string" }, load: { type: "boolean" },
    endpoint: { type: "string" }, "token-file": { type: "string" }, catalog: { type: "string" }, file: { type: "string" },
    "from-config": { type: "string" }, "native-home": { type: "string" }, app: { type: "string" }, codex: { type: "string" },
    client: { type: "boolean" },
    "tunnel-id": { type: "string" }, host: { type: "string" }, "remote-port": { type: "string" }, reverse: { type: "boolean" }, "ssh-config": { type: "string" },
    apply: { type: "boolean" }, "next-login": { type: "boolean" }, "on-restart": { type: "boolean" }, "with-gateway": { type: "boolean" }, force: { type: "boolean" },
  } });
  const [command, id, ...extra] = positionals;
  if (!command || extra.length || (id && !["login", "discover", "service", "tunnel", "desktop", "ssh", "native", "tool-search"].includes(command))) throw new Error("Choose one command; run gateway --help");
  if (!["init", "setup", "desktop", "desktop-restore", "daemon", "executor-host", "ssh", "native", "uninstall", "tunnel", "serve", "providers", "login", "doctor", "codex-config", "claude-config", "token", "catalog", "discover", "service", "diagnostics", "tool-search"].includes(command)) throw new Error("Unknown command; run gateway --help");
  if (values.apply && (command !== "service" || !["consolidate", "shared-executors", "shared-native"].includes(id))) throw new Error("--apply is only valid for service consolidate, shared-executors, or shared-native");
  if (values.disable && (command !== "service" || !["shared-executors", "shared-native"].includes(id))) throw new Error("--disable is only valid for service shared-executors or shared-native");
  if (values["on-restart"] && (command !== "service" || !["shared-native", "claude-desktop"].includes(id))) throw new Error("--on-restart is only valid for service shared-native or claude-desktop");
  if (values["on-restart"] && (values.apply || values.disable)) throw new Error("--on-restart cannot be combined with --apply or --disable");
  if (values.force && !(command === "service" && id === "claude-desktop" && values["on-restart"])) throw new Error("--force is only valid with service claude-desktop --on-restart");
  if (values["with-gateway"] && !(command === "service" && id === "shared-native" && values["on-restart"])) throw new Error("--with-gateway is only valid with service shared-native --on-restart");
  if (values["next-login"] && (command !== "service" || id !== "consolidate" || values.apply)) throw new Error("--next-login is only valid for service consolidate and cannot be combined with --apply");
  if (values.codex && !["ssh", "native", "executor-host"].includes(command)) throw new Error("--codex is only valid for ssh, native, or executor-host");
  if (values["from-config"] && command !== "setup") throw new Error("--from-config is only valid for setup");
  if (values["native-home"] && !["desktop", "native", "executor-host"].includes(command)) throw new Error("--native-home is only valid for desktop, native, or executor-host");
  if (values.app && !["desktop", "desktop-restore"].includes(command)) throw new Error("--app is only valid for desktop");
  if (values.port && !["serve", "tunnel", "setup"].includes(command)) throw new Error("--port is only valid for serve, setup or tunnel");
  if (values.client && command !== "setup") throw new Error("--client is only valid for setup");
  if (command !== "tunnel" && [values["tunnel-id"], values.host, values["remote-port"], values.reverse, values["ssh-config"]].some(Boolean)) throw new Error("Tunnel options are only valid for tunnel");
  if (values.model && !["codex-config", "claude-config", "catalog"].includes(command)) throw new Error("--model is only valid for codex-config, claude-config or catalog");
  if ((values.select || values.load) && command !== "discover") throw new Error("--select and --load are only valid for discover");
  if (values["no-browser"] && command !== "login") throw new Error("--no-browser is only valid for login");
  if (values["account-email"] !== undefined && command !== "login") throw new Error("--account-email is only valid for Codex subscription login");
  if (values.file) {
    if (command !== "token" || values.config) throw new Error("--file is only valid for token without --config");
    process.stdout.write(await readClientToken(resolve(values.file)) + "\n"); return;
  }
  if (command === "setup" && values.client && values["token-file"]) {
    if (!values.port || values["from-config"] || values.endpoint || values.catalog) throw new Error("Client setup requires --port and --token-file");
    process.stdout.write(JSON.stringify(await setupClient(await configPath(values.config), Number(values.port), resolve(values["token-file"])), null, 2) + "\n"); return;
  }
  if (values.endpoint || values["token-file"] || values.catalog) {
    if (command === "claude-config") {
      if (!values.model || !values.endpoint || !values["token-file"] || values.config || values.catalog) throw new Error("Remote claude-config requires --model, --endpoint and --token-file, without --config or --catalog");
      process.stdout.write(await remoteClaudeSettings(values.model, values.endpoint, resolve(values["token-file"]))); return;
    }
    if (command !== "codex-config" || !values.model || !values.endpoint || !values["token-file"] || values.config) throw new Error("Remote codex-config requires --model, --endpoint and --token-file, without --config");
    const tokenFile = resolve(values["token-file"]);
    process.stdout.write(await remoteCodexSettings(values.model, values.endpoint, tokenFile, resolve(values.catalog || `${dirname(tokenFile)}/codex-models.json`))); return;
  }
  const path = await configPath(values.config);
  if (command === "desktop-restore") { await macDesktop("register", path, values.app, true); return; }
  if (command === "executor-host") { await runExecutionHostCommand(path, values.codex, values["native-home"]); return; }
  if (command === "daemon") {
    await runServiceDaemon(path); return;
  }
  if (command === "native") { process.stdout.write(JSON.stringify(await macNative(id, path, { codex: values.codex, nativeHome: values["native-home"] }), null, 2) + "\n"); return; }
  if (command === "ssh") { process.stdout.write(JSON.stringify(await macSsh(id, path, values.codex)) + "\n"); return; }
  if (command === "uninstall") { process.stdout.write(JSON.stringify(await uninstallGateway(path), null, 2) + "\n"); return; }
  if (command === "setup") {
    if (!values["from-config"]) throw new Error("setup requires --from-config; use gateway init for a new registration");
    process.stdout.write(JSON.stringify(await setupGateway(resolve(values["from-config"]), path, values.client), null, 2) + "\n"); return;
  }
  if (command === "desktop") {
    if (id && values["native-home"]) throw new Error("Persistent desktop registration uses the original native home; --native-home is only for a test launch");
    if (id) process.stdout.write(JSON.stringify(await macDesktop(id, path, values.app)) + "\n");
    else process.stdout.write(JSON.stringify(await launchDesktop(path, values["native-home"], values.app)) + "\n");
    return;
  }
  if (command === "service") {
    const result = id === "claude-desktop" ? values["on-restart"] ? await stageClaudeConsolidation(path, {}, values.force) : await previewClaudeConsolidation(path)
      : id === "consolidate" ? values["next-login"] ? await stageLoginConsolidation(path) : await consolidateService(path, values.apply)
      : values.disable && (id === "shared-executors" || id === "shared-native") ? await disableSharing(path, id, values.apply)
      : id === "shared-native" && values["on-restart"] ? await stageNativeSharing(path, values["with-gateway"])
      : id === "shared-executors" ? await enableSharedExecutors(path, values.apply) : id === "shared-native" ? await enableSharedNative(path, values.apply) : await macService(id, path);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n"); return;
  }
  if (command === "init") {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(defaults, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(`${path}\n`); return;
  }
  const config = await loadConfig(path);
  if (command === "tunnel") { process.stdout.write(JSON.stringify(await macTunnel(id, { id: values["tunnel-id"] || "", host: values.host, port: Number(values.port), remotePort: Number(values["remote-port"]), reverse: values.reverse, sshConfig: values["ssh-config"] }, config.stateDirectory), null, 2) + "\n"); return; }
  if (command === "catalog") {
    const catalog = config.clientOnly ? await remoteCatalog(config) : modelCatalog(config);
    if (values.model) catalog.models = catalog.models.filter(model => model.slug === values.model);
    if (!catalog.models.length) throw new Error("No configured model matches the selection");
    process.stdout.write(JSON.stringify(catalog, null, 2) + "\n"); return;
  }
  if (command === "tool-search") {
    const action = id ?? "status";
    if (action !== "on" && action !== "off" && action !== "status") throw new Error("tool-search takes on, off or status");
    const result = await toolSearchCommand(action, path, config);
    if (result.daemon) process.stderr.write(result.daemon.rejection ? `Saved, but the daemon did not apply it (${result.daemon.rejection}); fix gateway.json or restart the service.\n`
      : `Saved. ${result.daemon.reachable ? "The daemon has loaded it" : "The daemon loads it on the next request"}; chats Codex loads after this use the new catalog.\n`);
    else if (action !== "status") process.stderr.write("Already set; nothing changed.\n");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n"); return;
  }
  if (command === "discover") {
    const provider = config.providers.find(provider => provider.id === id);
    if (!provider) throw new Error("discover requires a configured provider ID");
    const discovered = await discoverModels(provider);
    const selected = values.select?.split(",").filter(Boolean);
    if (selected?.some(model => !discovered.some(entry => entry.model === model))) throw new Error("A selected model is absent from the provider catalog");
    const models = selected ? discovered.filter(entry => selected.includes(entry.model)) : discovered;
    if (!models.length) throw new Error("Provider returned no selected models");
    if (values.load) {
      loadDiscoveredModels(provider, models);
      const source = JSON.parse(await readFile(path, "utf8")) as GatewayConfig;
      const target = source.providers.find(entry => entry.id === provider.id)!;
      target.models = provider.models; target.modelMetadata = provider.modelMetadata;
      await writePrivateJson(path, source);
      // The daemon reads the file when it answers /health, so asking also tells whether it took the change or held it back.
      const daemon = config.clientOnly ? { reachable: false } : await daemonConfigStatus(config.port);
      process.stderr.write(daemon.rejection ? `Model routes saved, but the daemon did not apply them (${daemon.rejection}); fix gateway.json or restart the service to apply them.\n`
        : daemon.reachable ? "Model routes saved. The daemon has loaded them.\n" : "Model routes saved. The daemon reloads them on the next request.\n");
    }
    process.stdout.write(JSON.stringify({ provider: provider.id, models }, null, 2) + "\n"); return;
  }
  if (command === "diagnostics") {
    const hours = Number(values.since || "24");
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 14) throw new Error("--since takes hours from 1 to 336");
    const since = new Date(Date.now() - hours * 3600000);
    process.stdout.write(JSON.stringify(summarizeTelemetry(await readTelemetry(config.stateDirectory, since.getTime()), since), null, 2) + "\n"); return;
  }
  if (command === "token") { process.stdout.write(await gatewayToken(config.stateDirectory) + "\n"); return; }
  if (command === "providers") {
    const providers = config.providers.map(provider => ({ id: provider.id, type: provider.type, models: Object.keys(provider.models) }));
    process.stdout.write(values.json ? JSON.stringify({ providers }, null, 2) + "\n" : providers.map(p => `${p.id}\t${p.type}\t${p.models.join(", ")}`).join("\n") + "\n"); return;
  }
  if (command === "doctor") {
    if (config.clientOnly) { const catalog = await remoteCatalog(config); process.stdout.write(JSON.stringify({ ready: true, clientOnly: true, models: catalog.models.length, providerCredentialsCopied: false }, null, 2) + "\n"); return; }
    const exec = promisify(execFile);
    const providers = await Promise.all(config.providers.map(async provider => {
      if (provider.type === "copilot-subscription") {
        try { const client = await openCopilot(provider); await client.close(); return { id: provider.id, ready: true, detail: "Copilot subscription login and SDK protocol 3" }; }
        catch { return { id: provider.id, ready: false, detail: "Copilot CLI, subscription login, or SDK protocol 3 unavailable" }; }
      }
      if (provider.type === "claude-subscription") {
        try {
          const command = await providerCommand("claude");
          const { stdout } = await exec(command, ["auth", "status", "--json"], { timeout: 10000, env: { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, DISABLE_AUTOUPDATER: "1", ...(provider.authDirectory ? { CLAUDE_CONFIG_DIR: provider.authDirectory } : {}) } });
          const status = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
          return { id: provider.id, ready: status.loggedIn === true && status.authMethod === "claude.ai", detail: "Claude subscription login" };
        } catch { return { id: provider.id, ready: false, detail: "Claude CLI or subscription login unavailable" }; }
      }
      const api = ["responses-api", "anthropic-api", "chat-completions-api"].includes(provider.type);
      const ready = provider.credentialFile ? await stat(provider.credentialFile).then(() => true, () => false) : Boolean(process.env[provider.apiKeyEnv!]);
      return { id: provider.id, ready, detail: api ? "API credential presence" : "Login file presence; inference verifies access" };
    }));
    process.stdout.write(values.json ? JSON.stringify({ providers }, null, 2) + "\n" : providers.map(p => `${p.id}\t${p.ready ? "ready" : "login needed"}\t${p.detail}`).join("\n") + "\n"); return;
  }
  if (command === "codex-config" || command === "claude-config") {
    const catalog = config.clientOnly ? await remoteCatalog(config) : modelCatalog(config);
    if (!values.model || !catalog.models.some(model => model.slug === values.model)) throw new Error("--model must name a configured alias");
    if (!config.port) throw new Error("Use a fixed port before generating client configuration");
    if (command === "claude-config") {
      process.stdout.write(claudeSettings(values.model, `http://127.0.0.1:${config.port}/v1`, config.clientOnly ? ["--file", resolve(config.stateDirectory, "client-token")] : ["--config", path])); return;
    }
    const catalogPath = resolve(config.stateDirectory, "codex-models.json");
    await writePrivateJson(catalogPath, catalog);
    process.stdout.write(codexSettings(values.model, catalogPath, `http://127.0.0.1:${config.port}/v1`, config.clientOnly ? ["--file", resolve(config.stateDirectory, "client-token")] : ["--config", path])); return;
  }
  if (command === "login") {
    const provider = config.providers.find(p => p.id === id);
    if (!provider) throw new Error("login requires a configured provider ID");
    if (values["account-email"] !== undefined && provider.type !== "codex-subscription") throw new Error("--account-email is only valid for Codex subscription login");
    if (provider.type === "claude-subscription" || provider.type === "copilot-subscription") {
      const copilot = provider.type === "copilot-subscription";
      const command = await providerCommand(copilot ? "copilot" : "claude");
      const child = spawn(command, copilot ? ["login", "--no-auto-update"] : ["auth", "login"], { stdio: "inherit", env: copilot ? copilotEnvironment(provider.authDirectory) : { ...process.env, DISABLE_AUTOUPDATER: "1", ...(provider.authDirectory ? { CLAUDE_CONFIG_DIR: provider.authDirectory } : {}) } });
      await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${copilot ? "Copilot" : "Claude"} login failed`))); });
    } else if (provider.type === "codex-subscription") {
      const control = new AbortController(); const interrupt = () => control.abort(); process.once("SIGINT", interrupt);
      try { await signIn(provider.credentialFile!, provider.agentName || "Harness Gateway", async url => {
        if (values["no-browser"]) process.stdout.write(`Continue with ChatGPT:\n${url}\n`);
        else {
          process.stderr.write("Continue with ChatGPT in the browser. Waiting for authorization...\n");
          const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
          const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
          await promisify(execFile)(opener, args, { timeout: 10000 });
        }
      }, control.signal, values["account-email"]); } finally { process.off("SIGINT", interrupt); }
    } else throw new Error("Configure this API provider's credentialFile or apiKeyEnv instead of subscription login");
    process.stdout.write(`${provider.id}: signed in\n`); return;
  }
  if (values.port) { const port = Number(values.port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1 through 65535"); config.port = port; }
  // Request handling, timers and in-place upgrades live in the serve runtime; signal
  // handlers below reach whichever generation currently owns the socket.
  const { server } = await startServeRuntime(path, values.port ? config.port : undefined);
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return; closing = true;
    telemetry("server_shutdown_signal", { signal });
    // Takes effect after an inference process restart; a hot swap keeps the old handler.
    stopServing(server);
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  if (process.platform !== "win32") process.on("SIGUSR2", () => {
    if (closing) return;
    if (server.restartWhenIdle(() => process.exit(0))) closing = true;
  });
  if (process.platform === "darwin") process.on("SIGUSR1", () => {
    if (closing) return;
    // Only the service that owns this process can unload itself for an upgrade.
    const target = `gui/${process.getuid!()}/com.edihasaj.subscription-gateway`;
    void promisify(execFile)("/bin/launchctl", ["print", target], { timeout: 3000 }).then(({ stdout }) => {
      if (Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) !== process.pid) return;
      if (server.restartWhenIdle(() => {
        void promisify(execFile)("/bin/launchctl", ["bootout", target], { timeout: 10000 }).catch(() => { process.exit(0); });
      })) closing = true;
    }).catch(() => undefined);
  });
  // The line that says the server is up comes after its signal handlers: whoever waits for it may stop the server at once.
  process.stderr.write(`Listening on http://127.0.0.1:${(server.address() as { port: number }).port}\n`);
}

/** What `gateway` prints when a command fails: SyntaxError becomes a fixed string so no file content leaks. */
export function cliFailureMessage(error: unknown): string {
  return safeErrorMessage(error, "Command failed");
}

async function remoteCatalog(config: GatewayConfig): Promise<{ models: Array<Record<string, unknown>> }> {
  const token = await readPrivateClientToken(resolve(config.stateDirectory, "client-token"));
  const response = await fetch(`http://127.0.0.1:${config.port}/v1/model-catalog`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Remote gateway returned HTTP ${response.status}; check its tunnel`);
  const text = await response.text(); if (text.length > 1024 * 1024) throw new Error("Remote catalog exceeds 1 MiB");
  const catalog = JSON.parse(text) as { models: Array<Record<string, unknown>> };
  if (!Array.isArray(catalog.models)) throw new Error("Remote gateway returned an invalid catalog");
  return catalog;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`gateway: ${cliFailureMessage(error)}\n`); process.exitCode = 2; });
}
