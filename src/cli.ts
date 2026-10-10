#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import { readFile, writeFile, stat, realpath } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadConfig, gatewayToken, writePrivateJson, type GatewayConfig } from "./config.js";
import { signIn } from "./auth/chatgpt.js";
import { startGateway } from "./server.js";
import { modelCatalog, discoverModels, loadDiscoveredModels } from "./catalog.js";
import { codexSettings, remoteCodexSettings, readClientToken } from "./codex-config.js";
import { codexShim } from "./codex-shim.js";
import { LiveConfig } from "./live-config.js";
import { macService } from "./mac-service.js";
import { openCopilot, copilotEnvironment } from "./providers/copilot-client.js";

const help = `gateway — local subscription and API inference

  gateway init [--config PATH]
  gateway serve [--config PATH] [--port NUMBER]
  gateway service install|status|restart|uninstall [--config PATH]
  gateway providers [--config PATH] [--json]
  gateway discover PROVIDER [--select ID,ID] [--load] [--config PATH]
  gateway catalog [--config PATH] [--model ALIAS]
  gateway login PROVIDER [--config PATH] [--no-browser]
  gateway doctor [--config PATH] [--json]
  gateway codex-config --model ALIAS [--config PATH]
  gateway codex-config --model ALIAS --endpoint URL --token-file PATH [--catalog PATH]
  gateway codex-shim --config PATH --codex PATH -- CODEX_ARGUMENTS
  gateway token [--config PATH]   Credential helper; prints the local client token.
  gateway token --file PATH      Credential helper for a trusted remote gateway.

Defaults: --config ./gateway.local.json (or GATEWAY_CONFIG).
Help/version require no configuration. API keys are referenced by environment name.
Serve runs in the foreground; Ctrl-C stops requests and children. macOS service setup is explicit.
`;
const defaults: GatewayConfig = { version: 1, port: 3457, stateDirectory: ".state", providers: [
  { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude-sonnet-4-6": "claude-sonnet-4-6" }, modelMetadata: { "claude-sonnet-4-6": { displayName: "Sonnet 4.6", contextWindow: 200000, reasoningEfforts: ["low", "medium", "high"] } } },
  { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: ".state/codex.json", agentName: "Subscription Gateway", models: { "codex/gpt-6.1-sol": "gpt-6.1-sol" } },
] };

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "codex-shim") return codexShim(argv.slice(1));
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(help); return; }
  if (argv.includes("--version")) { process.stdout.write("0.1.0\n"); return; }
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    config: { type: "string" }, port: { type: "string" }, json: { type: "boolean" }, model: { type: "string" }, "no-browser": { type: "boolean" }, select: { type: "string" }, load: { type: "boolean" },
    endpoint: { type: "string" }, "token-file": { type: "string" }, catalog: { type: "string" }, file: { type: "string" },
  } });
  const [command, id, ...extra] = positionals;
  if (!command || extra.length || (id && !["login", "discover", "service"].includes(command))) throw new Error("Choose one command; run gateway --help");
  if (!["init", "serve", "providers", "login", "doctor", "codex-config", "token", "catalog", "discover", "service"].includes(command)) throw new Error("Unknown command; run gateway --help");
  if (values.port && command !== "serve") throw new Error("--port is only valid for serve");
  if (values.model && !["codex-config", "catalog"].includes(command)) throw new Error("--model is only valid for codex-config or catalog");
  if ((values.select || values.load) && command !== "discover") throw new Error("--select and --load are only valid for discover");
  if (values["no-browser"] && command !== "login") throw new Error("--no-browser is only valid for login");
  if (values.file) {
    if (command !== "token" || values.config) throw new Error("--file is only valid for token without --config");
    process.stdout.write(await readClientToken(resolve(values.file)) + "\n"); return;
  }
  if (values.endpoint || values["token-file"] || values.catalog) {
    if (command !== "codex-config" || !values.model || !values.endpoint || !values["token-file"] || values.config) throw new Error("Remote codex-config requires --model, --endpoint and --token-file, without --config");
    const tokenFile = resolve(values["token-file"]);
    process.stdout.write(await remoteCodexSettings(values.model, values.endpoint, tokenFile, resolve(values.catalog || `${dirname(tokenFile)}/codex-models.json`))); return;
  }
  const path = resolve(values.config || process.env.GATEWAY_CONFIG || "gateway.local.json");
  if (command === "service") { process.stdout.write(JSON.stringify(await macService(id, path), null, 2) + "\n"); return; }
  if (command === "init") {
    await writeFile(path, JSON.stringify(defaults, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(`${path}\n`); return;
  }
  const config = await loadConfig(path);
  if (command === "catalog") {
    const catalog = modelCatalog(config);
    if (values.model) catalog.models = catalog.models.filter(model => model.slug === values.model);
    if (!catalog.models.length) throw new Error("No configured model matches the selection");
    process.stdout.write(JSON.stringify(catalog, null, 2) + "\n"); return;
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
      process.stderr.write("Model routes saved. The daemon reloads them on the next request.\n");
    }
    process.stdout.write(JSON.stringify({ provider: provider.id, models }, null, 2) + "\n"); return;
  }
  if (command === "token") { process.stdout.write(await gatewayToken(config.stateDirectory) + "\n"); return; }
  if (command === "providers") {
    const providers = config.providers.map(provider => ({ id: provider.id, type: provider.type, models: Object.keys(provider.models) }));
    process.stdout.write(values.json ? JSON.stringify({ providers }, null, 2) + "\n" : providers.map(p => `${p.id}\t${p.type}\t${p.models.join(", ")}`).join("\n") + "\n"); return;
  }
  if (command === "doctor") {
    const exec = promisify(execFile);
    const providers = await Promise.all(config.providers.map(async provider => {
      if (provider.type === "copilot-subscription") {
        try { const client = await openCopilot(provider); await client.close(); return { id: provider.id, ready: true, detail: "Copilot subscription login and SDK protocol 3" }; }
        catch { return { id: provider.id, ready: false, detail: "Copilot CLI, subscription login, or SDK protocol 3 unavailable" }; }
      }
      if (provider.type === "claude-subscription") {
        try {
          const { stdout } = await exec("claude", ["auth", "status", "--json"], { timeout: 10000, env: { ...process.env, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ...(provider.authDirectory ? { CLAUDE_CONFIG_DIR: provider.authDirectory } : {}) } });
          const status = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
          return { id: provider.id, ready: status.loggedIn === true && status.authMethod === "claude.ai", detail: "Claude subscription login" };
        } catch { return { id: provider.id, ready: false, detail: "Claude CLI or subscription login unavailable" }; }
      }
      const api = provider.type === "responses-api" || provider.type === "anthropic-api";
      const ready = api ? Boolean(process.env[provider.apiKeyEnv!]) : await stat(provider.credentialFile!).then(() => true, () => false);
      return { id: provider.id, ready, detail: api ? "API credential presence" : "Login file presence; inference verifies access" };
    }));
    process.stdout.write(values.json ? JSON.stringify({ providers }, null, 2) + "\n" : providers.map(p => `${p.id}\t${p.ready ? "ready" : "login needed"}\t${p.detail}`).join("\n") + "\n"); return;
  }
  if (command === "codex-config") {
    if (!values.model || !config.providers.some(p => Object.hasOwn(p.models, values.model!))) throw new Error("--model must name a configured alias");
    if (!config.port) throw new Error("Use a fixed port before generating Codex configuration");
    const catalogPath = resolve(config.stateDirectory, "codex-models.json");
    await writePrivateJson(catalogPath, modelCatalog(config));
    process.stdout.write(codexSettings(values.model, catalogPath, `http://127.0.0.1:${config.port}/v1`, ["--config", path], config.timeoutMs)); return;
  }
  if (command === "login") {
    const provider = config.providers.find(p => p.id === id);
    if (!provider) throw new Error("login requires a configured provider ID");
    if (provider.type === "claude-subscription" || provider.type === "copilot-subscription") {
      const copilot = provider.type === "copilot-subscription";
      const child = spawn(copilot ? "copilot" : "claude", copilot ? ["login"] : ["auth", "login"], { stdio: "inherit", env: copilot ? copilotEnvironment(provider.authDirectory) : { ...process.env, ...(provider.authDirectory ? { CLAUDE_CONFIG_DIR: provider.authDirectory } : {}) } });
      await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${copilot ? "Copilot" : "Claude"} login failed`))); });
    } else if (provider.type === "codex-subscription") {
      const control = new AbortController(); const interrupt = () => control.abort(); process.once("SIGINT", interrupt);
      try { await signIn(provider.credentialFile!, provider.agentName || "Subscription Gateway", async url => {
        if (values["no-browser"]) process.stdout.write(`Continue with ChatGPT:\n${url}\n`);
        else {
          process.stderr.write("Continue with ChatGPT in the browser. Waiting for authorization...\n");
          const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
          const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
          await promisify(execFile)(opener, args, { timeout: 10000 });
        }
      }, control.signal); } finally { process.off("SIGINT", interrupt); }
    } else throw new Error(`Configure the ${provider.apiKeyEnv} environment variable for this API provider`);
    process.stdout.write(`${provider.id}: signed in\n`); return;
  }
  if (values.port) { const port = Number(values.port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1 through 65535"); config.port = port; }
  const live = new LiveConfig(path, config, values.port ? config.port : undefined);
  const server = await startGateway(config, undefined, () => live.current());
  process.stderr.write(`Listening on http://127.0.0.1:${(server.address() as { port: number }).port}\n`);
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true;
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 2000).unref();
    server.close(() => { clearTimeout(deadline); process.exit(0); });
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  if (process.platform !== "win32") process.on("SIGUSR2", () => {
    if (closing) return;
    if (server.restartWhenIdle(() => process.exit(0))) closing = true;
  });
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { const message = error instanceof SyntaxError ? "Invalid JSON data" : error instanceof Error ? error.message : "Command failed"; process.stderr.write(`gateway: ${message}\n`); process.exitCode = 2; });
}
