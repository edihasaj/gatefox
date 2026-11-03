import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { grokBuiltinTools } from "../providers/grok.js";
import { gatewaySystemPrompt } from "../providers/claude-control.js";
import { ProviderError } from "../providers/provider.js";
import { adapter, alive, callIds, harness, kind, live, lookupName, outputFor, tools, turn, until, user } from "./grok-live-harness.js";

const rejected = (promise: Promise<unknown>) => promise.then(() => undefined, error => error as ProviderError);
const continuityRefusal = (error: ProviderError | undefined) => { assert.ok(error instanceof ProviderError); assert.equal(error.status, 400); assert.equal(error.upstream?.code, "session_continuity_unavailable"); return error; };

test("a tool loop keeps one Grok process: the held call is answered by the next request and a new user turn reuses the session", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [tool]")];
    const a = await turn(provider, first);
    assert.deepEqual(a.events.map(kind), ["reasoning", "text", "tool:lookup", "done"]);
    const call = a.events.find(event => event.type === "tool");
    assert.ok(call?.type === "tool" && call.call.function.arguments === JSON.stringify({ id: "7" }));
    assert.equal(callIds(a.output).length, 1);
    const second = [...first, ...a.output, ...outputFor(a.output, "weather-ok")];
    const b = await turn(provider, second);
    assert.match(b.text, /got:weather-ok$/);
    assert.deepEqual(b.events.map(kind), ["text", "done"]);
    const c = await turn(provider, [...second, ...b.output, user("follow up [plain]")]);
    assert.equal(c.text, "answer to plain");
    assert.equal((await h.pids()).length, 1, "one process served all three requests");
    assert.equal((await h.log()).filter(entry => entry.op === "result")[0].text, "weather-ok");
    assert.deepEqual((await h.sessions()).filter(entry => entry.outcome === "spawned" || entry.outcome === "continued").map(entry => entry.outcome), ["spawned", "continued", "continued"]);
  } finally { await h.restore(); }
});

test("two tool loops in a row and parallel calls continue through the ledger", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("go [twice]")];
    const a = await turn(provider, first); const second = [...first, ...a.output, ...outputFor(a.output, "one")];
    const b = await turn(provider, second); assert.equal(callIds(b.output).length, 1);
    const third = [...second, ...b.output, ...outputFor(b.output, "two")];
    const c = await turn(provider, third);
    assert.match(b.text, /first:one\|$/); assert.match(c.text, /second:two$/);
    assert.equal((await h.pids()).length, 1);
    const parallel = { threadId: "parallel-thread" }; const start = [user("go [parallel]")];
    const d = await turn(provider, start, { context: parallel });
    assert.equal(callIds(d.output).length, 2, "both parallel calls were handed over together");
    const e = await turn(provider, [...start, ...d.output, ...outputFor(d.output, id => `r-${id.slice(-4)}`)], { context: parallel });
    assert.match(e.text, /both:r-\w{4},r-\w{4}/);
  } finally { await h.restore(); }
});

test("the profile is always passed with every built-in tool disallowed, --always-approve never is, and the CLI environment is scrubbed", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter();
    await turn(provider, [user("start [tool]")], { extra: { reasoning: { effort: "high" } } });
    const spawn = (await h.log()).find(entry => entry.op === "spawn")!;
    assert.deepEqual(spawn.args.slice(0, 3), ["agent", "--no-leader", "--agent-profile"]);
    assert.ok(!spawn.args.includes("--always-approve"));
    assert.deepEqual(spawn.args.slice(4), ["-m", "grok-4.7", "--reasoning-effort", "high", "stdio"]);
    assert.match(spawn.profile, /^---\n/); assert.ok(spawn.profile.includes("tools:\n  - search_tool\n  - use_tool\ndisallowedTools:\n"));
    for (const name of grokBuiltinTools) assert.ok(spawn.profile.includes(`\n  - ${name}\n`), name);
    assert.ok(spawn.profile.includes(gatewaySystemPrompt));
    assert.equal(spawn.home, h.home); assert.equal(spawn.summary, "false"); assert.equal(spawn.title, "false"); assert.equal(spawn.xai, undefined);
    const created = (await h.log()).find(entry => entry.op === "new")!;
    assert.deepEqual(created.servers, [{ type: "http", name: "gateway" }]);
    const listed = (await h.log()).find(entry => entry.op === "listed")!;
    assert.deepEqual(listed.names, [lookupName]); assert.equal(listed.discover, -32601, "server/discover is answered, not hung");
  } finally { await h.restore(); }
});

test("permissions: only the caller's own gateway tool is allowed; native tools and unknown gateway tools are rejected and never run", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter();
    const native = await turn(provider, [user("go [native]")], { context: { threadId: "native" } });
    assert.equal(native.text, "native:r");
    await assert.rejects(access(join(h.scratch, "native-ran")));
    const unknown = await turn(provider, [user("go [unknown]")], { context: { threadId: "unknown" } });
    assert.equal(unknown.text, "unknown:denied:r");
    const search = await turn(provider, [user("go [search]")], { context: { threadId: "search" } });
    assert.equal(search.text, "search:a");
    const allowed = await turn(provider, [user("go [tool]")], { context: { threadId: "allowed" } });
    assert.equal(callIds(allowed.output).length, 1);
    const outcomes = (await h.log()).filter(entry => entry.op === "permission").map(entry => `${entry.variant}:${entry.outcome}`);
    assert.deepEqual(outcomes, ["RunTerminalCommand:r", "UseTool:r", "SearchTool:a", "UseTool:a"]);
    assert.ok(!outcomes.some(outcome => outcome.endsWith(":aa")), "allow_always is never selected");
    const telemetry = await h.sessions();
    assert.ok(telemetry.some(entry => entry.permissionsDenied === 1) && telemetry.some(entry => entry.permissionsAllowed === 1));
  } finally { await h.restore(); }
});

test("history that does not extend the session is refused with 400 session_continuity_unavailable and the session survives", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [tool]")];
    const a = await turn(provider, first);
    const good = [...first, ...a.output, ...outputFor(a.output, "ok")];
    // An edited earlier message, a missing result, an unknown call id, a duplicated result and a changed catalog are all refused.
    continuityRefusal(await rejected(turn(provider, [user("start [tool] edited"), ...a.output, ...outputFor(a.output, "ok")])));
    continuityRefusal(await rejected(turn(provider, [...first, ...a.output])));
    continuityRefusal(await rejected(turn(provider, [...first, ...a.output, ...outputFor(a.output, "ok").map(item => ({ ...item, call_id: "call_unknown" }))])));
    continuityRefusal(await rejected(turn(provider, [...good, ...outputFor(a.output, "again")])));
    continuityRefusal(await rejected(turn(provider, good, { extra: { tools: [...tools, { type: "function", name: "other", description: "Other", parameters: { type: "object", properties: {} } }] } })));
    continuityRefusal(await rejected(turn(provider, [...good, user("steer [plain]")])));
    // A conversation with history and no session is refused too: nothing is ever replayed into a new process.
    continuityRefusal(await rejected(turn(provider, good, { context: { threadId: "other-thread" } })));
    // Tool outputs and an interleaved user message cannot continue a held prompt, and a request without a conversation id cannot carry history.
    continuityRefusal(await rejected(turn(provider, good, { context: {} })));
    assert.equal((await h.pids()).length, 1, "no refusal started a process");
    const b = await turn(provider, good);
    assert.match(b.text, /got:ok$/, "the session still held the call after every refusal");
    assert.equal((await h.pids()).length, 1);
    const reasons = (await h.sessions()).filter(entry => entry.outcome === "refused").map(entry => entry.missReason);
    assert.deepEqual(reasons.slice(0, 7), ["prefix_diverged", "unexpected_tail", "unexpected_tail", "unexpected_tail", "fingerprint_changed", "unexpected_tail", "session_missing"]);
  } finally { await h.restore(); }
});

test("one-shot mode and live mode without a conversation id still refuse history before any CLI starts", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const history = [user("a [plain]"), { type: "message" as const, role: "assistant" as const, content: [{ type: "output_text" as const, text: "earlier" }] }, user("b [plain]")];
    const oneshot = continuityRefusal(await rejected(turn(adapter({ mode: "oneshot" }), history)));
    assert.match(oneshot.message, /standalone requests only/);
    continuityRefusal(await rejected(turn(adapter(), history, { context: {} })));
    assert.deepEqual(await h.log(), []);
    live().sessions().forEach(session => assert.fail(`unexpected session ${session.key}`));
    assert.ok(await until(async () => (await h.liveDirs()).length === 0));
    assert.ok((await h.pids()).every(pid => !alive(pid)));
  } finally { await h.restore(); }
});

test("a client that keeps reasoning summaries (instead of replaying them as assistant text) continues the same session", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const options = { preserveSummaries: true }; const first = [user("start [think]")];
    const a = await turn(provider, first, options);
    assert.equal(a.output[0].type, "reasoning");
    const second = [...first, ...a.output, ...outputFor(a.output, "kept")];
    const b = await turn(provider, second, options);
    assert.match(b.text, /got:kept$/);
    const c = await turn(provider, [...second, ...b.output, user("more [plain]")], options);
    assert.equal(c.text, "answer to plain");
    assert.equal((await h.pids()).length, 1);
  } finally { await h.restore(); }
});
