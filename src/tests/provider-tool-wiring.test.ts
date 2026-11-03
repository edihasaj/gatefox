import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runSubscriptionLogin, cliAvailable } from "../app-management/providers.js";
import { openCopilot } from "../providers/copilot-client.js";
import { discoverClaudeModels } from "../providers/claude-models.js";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeEnvironment } from "../providers/claude-environment.js";
import { providerToolContract, providerToolTree, providerToolsRoot, type ProviderTool } from "../provider-tool-runtime.js";

const run = promisify(execFile);
const cli = new URL("../cli.js", import.meta.url);

const claudeFixture = `#!${process.execPath}
import { appendFileSync } from "node:fs";
const note = value => appendFileSync(process.env.GATEWAY_PROVIDER_TOOL_LOG, JSON.stringify(value) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") { note({ kind: "claude-status", updater: process.env.DISABLE_AUTOUPDATER }); process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
if (args[0] === "auth" && args[1] === "login") { note({ kind: "claude-login", updater: process.env.DISABLE_AUTOUPDATER }); process.exit(0); }
let input = "";
process.stdin.on("data", chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf("\\n")) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      note({ kind: "claude-discovery", updater: process.env.DISABLE_AUTOUPDATER });
      process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { models: [{ value: "managed-claude", resolvedModel: "managed-claude", displayName: "Managed Claude", supportsVision: true, supportsEffort: false }] } } }) + "\\n");
      continue;
    }
    if (message.type !== "user") continue;
    note({ kind: "claude-infer", updater: process.env.DISABLE_AUTOUPDATER });
    for (const event of [
      { type: "stream_event", event: { type: "message_start", message: { id: "managed", usage: { input_tokens: 1 } } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "managed" } } },
      { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "result", subtype: "success", is_error: false, result: "managed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]) process.stdout.write(JSON.stringify(event) + "\\n");
    if (process.env.DISABLE_AUTO_COMPACT !== "1") process.exit(0);
  }
});
`;

const copilotFixture = `#!${process.execPath}
import { appendFileSync } from "node:fs";
const note = value => appendFileSync(process.env.GATEWAY_PROVIDER_TOOL_LOG, JSON.stringify(value) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "login") { note({ kind: "copilot-login", args }); process.exit(0); }
note({ kind: "copilot-open", args });
let input = "";
const reply = (id, result) => { const body = JSON.stringify({ jsonrpc: "2.0", id, result }); process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body); };
process.stdin.on("data", chunk => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\\r\\n\\r\\n"); if (end < 0) return;
    const size = Number(/^Content-Length:\\s*(\\d+)$/mi.exec(input.slice(0, end))?.[1]); if (!Number.isSafeInteger(size) || input.length < end + 4 + size) return;
    const message = JSON.parse(input.slice(end + 4, end + 4 + size)); input = input.slice(end + 4 + size);
    if (message.method === "connect") reply(message.id, { protocolVersion: 3 });
    else if (message.method === "auth.getStatus") reply(message.id, { isAuthenticated: true });
    else reply(message.id, {});
  }
});
`;

interface ManagedTools {
  root: string;
  log: string;
  executable(kind: ProviderTool): string;
  cleanup(): Promise<void>;
}

async function managedTools(): Promise<ManagedTools> {
  const home = await mkdtemp(join(tmpdir(), "gateway-provider-tool-home-")); const previousHome = process.env.HOME; process.env.HOME = home;
  const root = providerToolsRoot(); const expectedRoot = join(home, ".local/share/harness-gateway/provider-tools", providerToolContract);
  const logDirectory = await mkdtemp(join(tmpdir(), "gateway-provider-tool-wiring-")); const log = join(logDirectory, "calls.jsonl");
  try {
    if (root !== expectedRoot) throw new Error("Provider tool fixture did not isolate HOME");
    await mkdir(join(root, "installs"), { recursive: true, mode: 0o700 }); await chmod(root, 0o700); await chmod(join(root, "installs"), 0o700);
    const providers: Record<string, unknown> = {}; const commands = new Map<ProviderTool, string>();
    for (const [kind, source] of [["claude", claudeFixture], ["copilot", copilotFixture]] as const) {
      const installation = `${kind}-1.2.3-${"a".repeat(64)}`; const directory = join(root, "installs", installation); const modules = join(directory, "node_modules"); const executable = join(modules, kind);
      await mkdir(modules, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); await chmod(modules, 0o700);
      await writeFile(executable, source, { mode: 0o700 }); await chmod(executable, 0o700);
      providers[kind] = { version: "1.2.3", installation, executable: `node_modules/${kind}`, treeSha256: await providerToolTree(modules) };
      commands.set(kind, executable);
    }
    await writeFile(join(root, "current.json"), JSON.stringify({ schemaVersion: 1, contract: providerToolContract, providers }), { mode: 0o600 });
    return {
      root, log, executable: kind => commands.get(kind)!,
      cleanup: async () => {
        try { await rm(home, { recursive: true, force: true }); await rm(logDirectory, { recursive: true, force: true }); }
        finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
      },
    };
  } catch (error) {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true }); await rm(logDirectory, { recursive: true, force: true });
    throw error;
  }
}

const calls = async (log: string): Promise<Array<Record<string, unknown>>> => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);

test("new Claude and Copilot processes use verified provider tools without changing their arguments or authentication homes", { timeout: 30000 }, async () => {
  const tools = await managedTools(); const previousLog = process.env.GATEWAY_PROVIDER_TOOL_LOG; process.env.GATEWAY_PROVIDER_TOOL_LOG = tools.log;
  try {
    assert.equal(claudeEnvironment().DISABLE_AUTOUPDATER, "1");
    const claude = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "managed-claude" } });
    const events = []; for await (const event of claude.infer({ model: "managed-claude", input: "hello" }, new AbortController().signal)) events.push(event);
    assert.deepEqual(events.map(event => event.type), ["text", "done"]);
    assert.deepEqual((await discoverClaudeModels({ id: "claude", type: "claude-subscription", models: {} })).map(model => model.model), ["managed-claude"]);
    const copilot = await openCopilot({ id: "copilot", type: "copilot-subscription", models: {} }); await copilot.close();
    assert.equal(await cliAvailable("claude"), true);
    for (const kind of ["claude", "copilot"] as const) {
      let command = "";
      await runSubscriptionLogin({ id: kind, type: `${kind}-subscription` as "claude-subscription" | "copilot-subscription", models: {} }, {
        lookupCli: async () => true, runLogin: async executable => { command = executable; },
      });
      assert.equal(await realpath(command), await realpath(tools.executable(kind)));
    }
    const seen = await calls(tools.log);
    assert.ok(seen.some(entry => entry.kind === "claude-infer" && entry.updater === "1"));
    assert.ok(seen.some(entry => entry.kind === "claude-discovery" && entry.updater === "1"));
    assert.ok(seen.some(entry => entry.kind === "copilot-open" && Array.isArray(entry.args) && entry.args.includes("--no-auto-update")));
    // The managed installation's verified version (1.2.3) reaches the command line: no retired --no-remote, export still off.
    assert.ok(seen.some(entry => entry.kind === "copilot-open" && Array.isArray(entry.args) && !entry.args.includes("--no-remote") && entry.args.includes("--no-remote-export")));
  } finally {
    if (previousLog === undefined) delete process.env.GATEWAY_PROVIDER_TOOL_LOG; else process.env.GATEWAY_PROVIDER_TOOL_LOG = previousLog;
    await tools.cleanup();
  }
});

test("doctor and login start their managed provider commands", { timeout: 30000 }, async () => {
  const tools = await managedTools(); const directory = await mkdtemp(join(tmpdir(), "gateway-provider-tool-cli-")); const config = join(directory, "gateway.json");
  try {
    await writeFile(config, JSON.stringify({ version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [
      { id: "claude", type: "claude-subscription", models: { "claude/alias": "managed-claude" } },
      { id: "copilot", type: "copilot-subscription", models: { "copilot/alias": "managed-copilot" } },
    ] }), { mode: 0o600 });
    const env = { ...process.env, GATEWAY_PROVIDER_TOOL_LOG: tools.log };
    const doctor = JSON.parse((await run(process.execPath, [cli.pathname, "doctor", "--json", "--config", config], { env })).stdout);
    assert.ok(doctor.providers.every((provider: { ready: boolean }) => provider.ready));
    await run(process.execPath, [cli.pathname, "login", "claude", "--config", config], { env });
    await run(process.execPath, [cli.pathname, "login", "copilot", "--config", config], { env });
    const seen = await calls(tools.log);
    assert.ok(seen.some(entry => entry.kind === "claude-status" && entry.updater === "1"));
    assert.ok(seen.some(entry => entry.kind === "claude-login" && entry.updater === "1"));
    assert.ok(seen.some(entry => entry.kind === "copilot-login" && Array.isArray(entry.args) && entry.args.includes("--no-auto-update")));
  } finally { await rm(directory, { recursive: true, force: true }); await tools.cleanup(); }
});
