import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMeasuredUsage } from "../compaction-rollout.js";
import { catalogFamilies, switchFactor, switchOverflow, switchOverflowMessage, tokenFamily } from "../compaction-switch-guard.js";
import { GatewayCompaction } from "../gateway-compaction.js";
import { CompactionRecoveryError } from "../compaction-recovery.js";

const terra = "codex-main/gpt-6.1-terra"; const sonnet = "claude-secondary/claude-sonnet-5-5"; const sol = "codex/gpt-6.1-sol";
const at = (second: number) => `2026-10-30T08:12:${String(second).padStart(2, "0")}.000Z`;
const session = { timestamp: at(0), type: "session_meta", payload: { id: "chat" } };
const turn = (model: string, second = 1) => ({ timestamp: at(second), type: "turn_context", payload: { model } });
const counts = (last: number, second = 2) => ({ timestamp: at(second), type: "event_msg", payload: { type: "token_count", info: {
  total_token_usage: { total_tokens: 581479942 }, last_token_usage: { total_tokens: last }, model_context_window: 828400 } } });
// The incident: Terra measured the chat, then the switched Sonnet turn repeated those counters and recorded the overflow as zero.
const incident = [session, turn(terra, 1), counts(591583, 2), turn(sonnet, 3), counts(591583, 4), counts(0, 5)];

async function fixture(records: unknown[]) {
  const home = await mkdtemp(join(tmpdir(), "gateway-switch-")); const directory = join(home, "sessions", "2026");
  await mkdir(directory, { recursive: true }); const path = join(directory, "rollout.jsonl");
  await writeFile(path, records.map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  return { home, path };
}

test("token families separate Claude, OpenAI and other tokenizers by upstream model", () => {
  assert.equal(tokenFamily(sonnet), "anthropic");
  assert.equal(tokenFamily("openrouter/anthropic/claude-opus-5-5"), "anthropic");
  assert.equal(tokenFamily(terra), "openai");
  assert.equal(tokenFamily("qwen/qwen3.8-flash-next"), "qwen3");
  assert.equal(switchFactor("openai", "openai"), undefined);
  assert.equal(switchFactor("anthropic", "openai"), undefined, "Claude already counts the larger number");
  assert.equal(switchFactor("openai", "anthropic"), 1.7);
  assert.equal(switchFactor("qwen3", "openai"), 1.25);
});

test("the incident's measurement would not fit Sonnet, and the message names the way out", () => {
  const overflow = switchOverflow({ lastTokens: 591583, model: terra, emittedAtMs: 0 }, sonnet, 900000)!;
  assert.equal(overflow.estimatedTokens, 1005692);
  assert.match(switchOverflowMessage(overflow), /Switch back to codex-main\/gpt-6\.1-terra, run \/compact, then switch to claude-secondary\/claude-sonnet-5-5 again/);
  assert.equal(switchOverflow({ lastTokens: 400000, model: terra, emittedAtMs: 0 }, sonnet, 900000), undefined);
  assert.equal(switchOverflow({ lastTokens: 800000, model: terra, emittedAtMs: 0 }, sol, 900000), undefined, "same tokenizer is the SDK's own decision");
});

test("measured usage keeps the model that measured it across repeated and zero overflow counters", async () => {
  const f = await fixture(incident);
  assert.deepEqual(await readMeasuredUsage(f.home, "chat", f.path), { lastTokens: 591583, model: terra, emittedAtMs: Date.parse(at(2)) });
  const fresh = await fixture([...incident, turn(sonnet, 6), counts(70000, 7)]);
  assert.equal((await readMeasuredUsage(fresh.home, "chat", fresh.path))!.model, sonnet, "a new measurement belongs to the model that made it");
});

test("compaction, rollback and an unreadable turn record clear the measurement", async () => {
  for (const reset of [{ timestamp: at(6), type: "compacted", payload: { message: "summary" } },
    { timestamp: at(6), type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
    { timestamp: at(6), type: "turn_context", payload: { model: sonnet, padding: "x".repeat(70000) } }]) {
    const f = await fixture([...incident, reset]);
    assert.equal(await readMeasuredUsage(f.home, "chat", f.path), undefined);
  }
  const compacted = await fixture([...incident, { timestamp: at(6), type: "compacted", payload: {} }, turn(terra, 7), counts(33000, 8)]);
  assert.deepEqual(await readMeasuredUsage(compacted.home, "chat", compacted.path), { lastTokens: 33000, model: terra, emittedAtMs: Date.parse(at(8)) });
});

async function guard(records: unknown[], model: string | undefined, threadModel = sonnet, method = "turn/start", active = false) {
  const f = await fixture(records); const state = await mkdtemp(join(tmpdir(), "gateway-switch-state-"));
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = f.home;
  try {
    const reads: string[] = [];
    const session = new GatewayCompaction(state).session({
      models: [{ slug: terra, context_window: 872000, effective_context_window_percent: 95 }, { slug: sonnet, context_window: 1000000, effective_context_window_percent: 90 },
        { slug: sol, context_window: 872000, effective_context_window_percent: 95 }],
      settings: {}, args: [], aliases: new Set([terra, sonnet, sol]), shared: true, selectedModelCompaction: true,
      isGatewayThread: () => true, isActive: () => active,
      request: async (method, params) => { reads.push(method); return { thread: { id: params.threadId, model: threadModel, path: f.path, status: { type: "idle" } } }; },
    });
    try { return { result: await session.before(method, { threadId: "chat", ...(method === "turn/settings/update" ? { turnId: "running" } : {}), ...(model ? { model } : {}) }), reads }; }
    finally { await session.close(); }
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
}

test("a switch to Claude that the measured history would overflow is refused before anything is sent", async () => {
  for (const model of [sonnet, undefined]) {
    await assert.rejects(guard(incident, model), (error: unknown) => error instanceof CompactionRecoveryError && error.reason === "switch"
      && /run \/compact/.test(error.message));
  }
});

test("small histories, same-tokenizer switches and compacted chats start normally", async () => {
  assert.deepEqual((await guard([session, turn(terra), counts(300000)], sonnet)).result, { intercepted: false });
  assert.deepEqual((await guard(incident, sol, sol)).result, { intercepted: false });
  assert.deepEqual((await guard([...incident, { timestamp: at(6), type: "compacted", payload: {} }, turn(terra, 7), counts(33000, 8)], sonnet)).result, { intercepted: false });
});

test("a running turn's model change gets the same recount, because it reaches the next inference step without a user turn", async () => {
  await assert.rejects(guard(incident, sonnet, terra, "turn/settings/update", true), (error: unknown) => error instanceof CompactionRecoveryError && error.reason === "switch");
  assert.deepEqual((await guard([session, turn(terra), counts(300000)], sonnet, terra, "turn/settings/update", true)).result, { intercepted: false });
  assert.deepEqual((await guard(incident, sol, sol, "turn/settings/update", true)).result, { intercepted: false });
  // A settings change without a model, such as the desktop's reviewer update, reads nothing.
  const reviewer = await guard(incident, undefined, terra, "turn/settings/update", true);
  assert.deepEqual(reviewer.result, { intercepted: false }); assert.deepEqual(reviewer.reads, []);
});

test("a catalog's published families decide the switch, not the alias text", () => {
  // Regression: `fixture/large` -> `fixture/small` read as families "large" and "small" and refused a same-family switch.
  const measured = { lastTokens: 40_010, model: "fixture/large", emittedAtMs: 0 };
  const rows = [{ slug: "fixture/large", tokenizer_family: "mock" }, { slug: "fixture/small", tokenizer_family: "mock" }];
  assert.equal(switchOverflow(measured, "fixture/small", 45_000, catalogFamilies(rows)), undefined, "one family needs no recount");
  assert.ok(switchOverflow(measured, "fixture/small", 45_000), "without published families the alias text still decides");
  const cross = [{ slug: "fixture/large", tokenizer_family: "qwen3" }, { slug: "fixture/small", tokenizer_family: "anthropic" }];
  assert.equal(switchOverflow(measured, "fixture/small", 45_000, catalogFamilies(cross))?.estimatedTokens, Math.ceil(40_010 * 1.7));
});

test("a row without a usable published family falls back to the alias text", () => {
  const families = catalogFamilies([{ slug: "a/claude-sonnet-5-5" }, { slug: "b/x", tokenizer_family: "Not Valid!" }, { slug: 7, tokenizer_family: "openai" }]);
  assert.equal(families("a/claude-sonnet-5-5"), "anthropic");
  assert.equal(families("b/x"), "x");
  assert.equal(families("missing/gpt-6"), "openai");
});
