import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GrokSubscription } from "../providers/grok.js";
import { mergeGrokConfig } from "../providers/grok-home.js";
import { grokFailure } from "../providers/grok-stream.js";
import { ProviderError } from "../providers/provider.js";
import type { InferenceEvent } from "../protocol/types.js";
import { cacheGuardedInference } from "../cache-guarded-inference.js";

type Line = Record<string, unknown>;
const ev = (event: Line): Line => ({ type: "stream_event", event });
const init = (tools: string[] = ["search_tool", "use_tool"], mcp = ["gateway"]): Line => ({ type: "system", subtype: "init", tools, mcp_servers: mcp.map(name => ({ name, status: "pending" })) });
const textTurn = (text: string): Line[] => [init(), ev({ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 40 } } }),
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
  ev({ type: "content_block_stop", index: 0 }), ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
  { type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.02, usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 5 } }];
const useTool = (index: number, id: string, name: string, input: Line): Line[] => [
  ev({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "use_tool", input: {} } }),
  ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ tool_name: name, tool_input: input }) } }),
  ev({ type: "content_block_stop", index })];

const fixture = `#!${process.execPath}
const fs = require("node:fs");
const scenario = JSON.parse(fs.readFileSync(process.env.GATEWAY_TEST_GROK_SCENARIO, "utf8"));
const args = process.argv.slice(2); const prompt = fs.readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8");
fs.appendFileSync(process.env.GATEWAY_TEST_GROK_CAPTURE, JSON.stringify({ pid: process.pid, args, prompt, keys: Object.keys(process.env).filter(k => /^(XAI_|GROK_|GATEWAY_GROK_)/.test(k)).sort(), home: process.env.GROK_HOME, backend: process.env.GROK_BACKEND_SEARCH }) + "\\n");
for (const line of scenario.lines) process.stdout.write(JSON.stringify(line) + "\\n");
if (scenario.hang) setInterval(() => {}, 1000); else process.exit(0);
`;

async function setup(lines: Line[], hang = false) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-grok-test-"));
  const home = join(directory, "home"); const bin = join(directory, "bin");
  await (await import("node:fs/promises")).mkdir(bin, { recursive: true }); await (await import("node:fs/promises")).mkdir(home, { mode: 0o700 });
  await writeFile(join(home, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(home, "config.toml"), "[marketplace]\ndefault_skills_installs_purged = true\n", { mode: 0o600 });
  await writeFile(join(bin, "grok"), fixture, { mode: 0o700 });
  const scenario = join(directory, "scenario.json"); const capture = join(directory, "capture.jsonl");
  await writeFile(scenario, JSON.stringify({ lines, hang })); await writeFile(capture, "");
  const saved = { PATH: process.env.PATH, s: process.env.GATEWAY_TEST_GROK_SCENARIO, c: process.env.GATEWAY_TEST_GROK_CAPTURE, x: process.env.XAI_API_KEY };
  Object.assign(process.env, { PATH: bin + delimiter + (saved.PATH ?? ""), GATEWAY_TEST_GROK_SCENARIO: scenario, GATEWAY_TEST_GROK_CAPTURE: capture, XAI_API_KEY: "must-not-reach-grok" });
  const provider = new GrokSubscription({ id: "grok", type: "grok-subscription", grokHome: home, models: { "grok/main": "grok-4.7" }, modelMetadata: { "grok/main": { reasoningEfforts: ["low", "high"] } }, grokSessions: { mode: "oneshot" } });
  const captured = async () => (await readFile(capture, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
  const restore = async () => {
    for (const [key, value] of [["PATH", saved.PATH], ["GATEWAY_TEST_GROK_SCENARIO", saved.s], ["GATEWAY_TEST_GROK_CAPTURE", saved.c], ["XAI_API_KEY", saved.x]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  };
  return { provider, home, captured, restore };
}
const tools = [{ type: "function" as const, name: "lookup_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } }];
// The same normalized tool the provider builds, so the catalog name matches what Grok would call.
const gatewayName = async () => {
  const { claudeToolName } = await import("../providers/claude-tool-names.js");
  const { responsesToChatRequest } = await import("../protocol/request.js");
  return `gateway__${claudeToolName(responsesToChatRequest({ model: "grok-4.7", input: "x", tools }).tools![0])}`;
};
async function collect(provider: GrokSubscription, request: Record<string, unknown>, signal = new AbortController().signal) {
  const events: InferenceEvent[] = [];
  for await (const event of provider.infer({ model: "grok-4.7", input: "hello", ...request }, signal)) events.push(event);
  return events;
}
async function collectThread(provider: GrokSubscription, threadId: string) {
  const events: InferenceEvent[] = [];
  for await (const event of provider.infer({ model: "grok-4.7", input: "hello" }, new AbortController().signal, { threadId })) events.push(event);
  return events;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("charged Grok failure is retained and repeating the conversation stops before another CLI", async () => {
  const f = await setup([init(), ev({ type: "message_start", message: { usage: { input_tokens: 200000, cache_read_input_tokens: 10000 } } }),
    ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "bad", name: "run_terminal_command" } })], true);
  const turn = async () => {
    for await (const _ of cacheGuardedInference(f.provider, { model: "grok-4.7", input: "history" }, new AbortController().signal,
      { threadId: "grok-failure" }, "grok-native-failure")) {}
  };
  try {
    await assert.rejects(turn(), { code: "invalid_tool_call" });
    await assert.rejects(turn(), { code: "invalid_request", status: 400 });
    await assert.rejects(turn(), { code: "invalid_request", status: 400 });
    assert.equal((await f.captured()).length, 1);
  } finally { await f.restore(); }
});
async function gone(pid: number) { for (let i = 0; i < 300 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 10)); return !alive(pid); }

test("a text turn streams text and usage with a scrubbed environment and a managed Grok home", async () => {
  const f = await setup(textTurn("OK"));
  try {
    const events = await collect(f.provider, { reasoning: { effort: "high" } });
    assert.deepEqual(events.map(event => event.type), ["text", "done"]);
    const done = events.at(-1); assert.ok(done?.type === "done" && done.usage.input_tokens === 100 && done.usage.input_tokens_details?.cached_tokens === 40);
    const [run] = await f.captured();
    assert.equal(run.home, f.home); assert.equal(run.backend, "0");
    assert.ok(!run.keys.includes("XAI_API_KEY"), "API keys never reach the subscription CLI");
    assert.ok(run.args.includes("--disallowed-tools") && run.args[run.args.indexOf("--disallowed-tools") + 1].includes("run_terminal_command"));
    assert.equal(run.args[run.args.indexOf("--reasoning-effort") + 1], "high");
    const config = await readFile(join(f.home, "config.toml"), "utf8");
    assert.match(config, /\[marketplace\]/); assert.match(config, /\[mcp_servers\.gateway\]/); assert.match(config, /backend_tools = false/);
  } finally { await f.restore(); }
});

test("Grok rejects conversation replay before starting a CLI or touching its private home", async () => {
  const f = await setup(textTurn("OK"));
  const ask = async (input: string | Array<{ role: "user" | "assistant"; content: string }>, threadId?: string) => {
    for await (const _ of f.provider.infer({ model: "grok-4.7", input }, new AbortController().signal, { threadId })) {}
  };
  try {
    await assert.rejects(ask([{ role: "user", content: "First" }, { role: "assistant", content: "Answer" }, { role: "user", content: "Next" }]),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable");
    assert.equal((await f.captured()).length, 0);
    await ask("First", "identified");
    await assert.rejects(ask("A second request", "identified"), { code: "invalid_request", status: 400 });
    assert.equal((await f.captured()).length, 1, "the second standalone request did not replay a known conversation");
    await ask("Independent question", "another");
    assert.equal((await f.captured()).length, 2, "independent standalone requests remain usable");
  } finally { await f.restore(); }
});

test("a use_tool call becomes one caller tool call and the CLI is stopped before anything answers it", async () => {
  const name = await gatewayName();
  const lines = [init(["search_tool", "use_tool", name]), ev({ type: "message_start", message: {} }),
    ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "s1", name: "search_tool", input: {} } }), ev({ type: "content_block_stop", index: 0 }),
    ev({ type: "message_delta", delta: { stop_reason: "tool_use" } }), { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "s1" }] } },
    ev({ type: "message_start", message: {} }), ...useTool(0, "u1", name, { city: "Belgrade" })];
  const f = await setup(lines, true);
  try {
    const events = await collect(f.provider, { tools });
    assert.deepEqual(events.map(event => event.type), ["tool", "done"]);
    const call = events[0]; assert.ok(call.type === "tool");
    assert.equal(call.call.function.name, "lookup_weather"); assert.deepEqual(JSON.parse(call.call.function.arguments), { city: "Belgrade" });
    const [run] = await f.captured(); assert.ok(await gone(run.pid), "the CLI is killed");
  } finally { await f.restore(); }
});

test("parallel use_tool calls in one message are all returned", async () => {
  const name = await gatewayName();
  const f = await setup([init(), ev({ type: "message_start", message: {} }), ...useTool(0, "a", name, { city: "A" }), ...useTool(1, "b", name, { city: "B" }),
    ev({ type: "message_delta", delta: { stop_reason: "tool_use" } })], true);
  try {
    const calls = (await collect(f.provider, { tools })).flatMap(event => event.type === "tool" ? [JSON.parse(event.call.function.arguments).city] : []);
    assert.deepEqual(calls, ["A", "B"]);
  } finally { await f.restore(); }
});

test("native tools, xAI-side tools, extra MCP servers and non-gateway use_tool calls fail closed and stop the CLI", async () => {
  const cases: Line[][] = [
    [init(["search_tool", "use_tool", "run_terminal_command"])],
    [init(["search_tool", "use_tool"], ["gateway", "recall"])],
    [init(), ev({ type: "message_start", message: {} }), ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "x", name: "run_terminal_command" } })],
    [init(), ev({ type: "message_start", message: {} }), ev({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "x", name: "web_search" } })],
    [init(), ev({ type: "message_start", message: {} }), ...useTool(0, "u", "recall__search", {})],
  ];
  for (const lines of cases) {
    const f = await setup(lines, true);
    try {
      await assert.rejects(collect(f.provider, { tools }), (error: unknown) => error instanceof ProviderError && error.code === "invalid_tool_call");
      const [run] = await f.captured(); assert.ok(await gone(run.pid));
    } finally { await f.restore(); }
  }
});

test("native failures map to fixed classes without provider prose", async () => {
  for (const [code, expected, status] of [["authentication_failed", "authentication", 401], ["billing_error", "insufficient_quota", 429], ["server_error", "upstream_unavailable", 503], ["rate_limit", "rate_limit_exceeded", 429]] as const) {
    const f = await setup([init(), { type: "assistant", error: code, message: { content: [{ type: "text", text: "private-diagnostic" }] } }]);
    try {
      await assert.rejects(collect(f.provider, {}), (error: unknown) => error instanceof ProviderError && error.code === expected && error.status === status && !error.message.includes("private-diagnostic"));
    } finally { await f.restore(); }
  }
});

test("a signed-out CLI result is reported as authentication, not as an upstream failure", () => {
  const signedOut = { type: "result", subtype: "error_during_execution", is_error: true, result: "",
    errors: ["Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n  see https://x.ai/cli for details"] };
  const error = grokFailure(signedOut, "grok.result");
  assert.equal(error.code, "authentication"); assert.equal(error.status, 401);
  assert.equal(error.upstream?.code, "authentication_failed");
  assert.doesNotMatch(error.message, /device-code|https:/, "the provider's sentence is replaced, not forwarded");
  // Unrelated prose keeps the generic class.
  const unknown = grokFailure({ type: "result", is_error: true, errors: ["something else broke"] }, "grok.result");
  assert.equal(unknown.code, "inference_failed"); assert.equal(unknown.upstream?.code, "unknown");
});

test("an unauthenticated result from the running CLI surfaces as authentication", async () => {
  const f = await setup([init(), { type: "result", subtype: "error_during_execution", is_error: true, result: "",
    errors: ["Not signed in. To authenticate without a browser, run:\n  grok login --device-code"] }]);
  try { await assert.rejects(collect(f.provider, {}), { code: "authentication" }); }
  finally { await f.restore(); }
});

test("a failed attempt without output does not turn the corrected retry into a replay refusal", async () => {
  const f = await setup([init(), { type: "result", subtype: "error_during_execution", is_error: true, result: "",
    errors: ["Not signed in. To authenticate without a browser, run:\n  grok login --device-code"] }]);
  try {
    // Same thread both times, the way a client retries after reading the 401.
    await assert.rejects(collectThread(f.provider, "retry"), { code: "authentication" });
    await assert.rejects(collectThread(f.provider, "retry"), { code: "authentication" }, "the retry runs again instead of being refused");
    assert.equal((await f.captured()).length, 2, "each attempt started its own CLI");
  } finally { await f.restore(); }
});

test("an answered turn still refuses a second request on the same conversation", async () => {
  const f = await setup(textTurn("done"));
  try {
    await collectThread(f.provider, "once");
    await assert.rejects(collectThread(f.provider, "once"), { code: "invalid_request", status: 400 });
    assert.equal((await f.captured()).length, 1);
  } finally { await f.restore(); }
});

test("images are refused before the CLI starts, and a missing login is reported", async () => {
  const f = await setup(textTurn("no"));
  try {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await assert.rejects(collect(f.provider, { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: png }] }] }), { code: "invalid_request" });
    assert.equal((await f.captured()).length, 0);
    await rm(join(f.home, "auth.json"));
    await assert.rejects(collect(f.provider, {}), { code: "authentication" });
  } finally { await f.restore(); }
});

test("cancelling stops the CLI and reports cancellation", async () => {
  const f = await setup([init(), ev({ type: "message_start", message: {} }), ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })], true);
  try {
    const controller = new AbortController();
    await assert.rejects((async () => { for await (const event of f.provider.infer({ model: "grok-4.7", input: "x" }, controller.signal)) if (event.type === "text") controller.abort(); })(), { code: "cancelled" });
    const [run] = await f.captured(); assert.ok(await gone(run.pid));
  } finally { await f.restore(); }
});

test("the managed config keeps CLI-written sections and is idempotent", () => {
  const once = mergeGrokConfig("[marketplace]\nx = 1\n\n[features]\ntelemetry = \"on\"\n\n[mcp_servers.recall]\ncommand = \"r\"\n");
  assert.match(once, /\[marketplace\]\nx = 1/); assert.doesNotMatch(once, /recall/); assert.doesNotMatch(once, /telemetry = "on"/);
  assert.equal(mergeGrokConfig(once), once);
});

test("the catalog server stops the CLI when the gateway that owns it is gone", async () => {
  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"]);
  const parent = spawn(process.execPath, ["-e", `const c=require("node:child_process").spawn(process.execPath,[${JSON.stringify(fileURLToPath(new URL("../providers/grok-cli-tools.js", import.meta.url)))}],{env:{...process.env,GATEWAY_GROK_OWNER:"${owner.pid}"},stdio:["pipe","ignore","ignore"]});setInterval(()=>{},1000);`], { stdio: "ignore" });
  try { assert.ok(await gone(parent.pid!) || (await new Promise(r => setTimeout(r, 4000)), !alive(parent.pid!)), "the orphaned CLI is stopped"); }
  finally { try { parent.kill("SIGKILL"); } catch {} }
});

test("the catalog server lists caller tools and never answers tools/call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-grok-mcp-")); const catalog = join(directory, "tools.json");
  await writeFile(catalog, JSON.stringify([{ name: "t", description: "d", inputSchema: { type: "object" } }]));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../providers/grok-cli-tools.js", import.meta.url))], { env: { ...process.env, GATEWAY_GROK_CATALOG: catalog }, stdio: ["pipe", "pipe", "ignore"] });
  const replies: Record<string, any>[] = []; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { for (const line of chunk.split("\n").filter(Boolean)) replies.push(JSON.parse(line)); });
  try {
    for (const message of [{ id: 1, method: "initialize", params: {} }, { id: 2, method: "tools/list" }, { id: 3, method: "tools/call", params: { name: "t", arguments: {} } }, { id: 4, method: "ping" }]) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    for (let i = 0; i < 200 && !replies.some(reply => reply.id === 4); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(replies.map(reply => reply.id), [1, 2, 4]);
    assert.equal(replies[1].result.tools[0].name, "t");
  } finally { child.kill(); await rm(directory, { recursive: true, force: true }); }
});
