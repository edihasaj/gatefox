import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "../providers/provider.js";
import { sessionParams } from "../providers/copilot-create.js";
import { CopilotLiveSession } from "../providers/copilot-live-session.js";
import { CopilotTurn } from "../providers/copilot-turn.js";
import type { Prompt } from "../providers/copilot-render.js";
import { adapter, alive, callIds, harness, outputFor, providerId, turn, until, user, type Entry } from "./copilot-live-harness.js";

// A request that is cancelled hands the CLI nothing more: the session is being aborted, and a message or a tool result sent now
// starts a model call that nobody waits for and that is billed all the same.
const count = (entries: Entry[], op: string) => entries.filter(entry => entry.op === op).length;

test("a live request cancelled while its tool results are being delivered sends no further batch", { timeout: 30000 }, async () => {
  // The CLI accepts no result until it is told to abort (so the cancellation comes while the first batch is with it), and answers
  // session.abort only after 1.5 s, so its connection is still open when the first batch is accepted and a second could go out.
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_DELIVER_AFTER_ABORT = "1"; process.env.GATEWAY_COPILOT_LIVE_SLOW_ABORT = "1500";
  try {
    const provider = adapter(); const first = [user("go [tools:20]")];
    const a = await turn(provider, first); assert.equal(callIds(a.output).length, 20);
    const controller = new AbortController();
    const running = turn(provider, [...first, ...a.output, ...outputFor(a.output, "x")], { controller }).then(() => undefined, error => error as unknown);
    // The first batch of 16 is with the CLI, which has not accepted any of it yet.
    assert.ok(await until(async () => count(await h.log(), "deliver") === 16));
    controller.abort();
    const error = await running; assert.ok(error instanceof ProviderError && error.code === "cancelled", String(error));
    const [pid] = await h.pids(); assert.ok(await until(() => !alive(pid)), "the CLI is gone");
    assert.equal(count(await h.log(), "deliver"), 16, "the four results of the second batch were not delivered");
  } finally { await h.restore(); }
});

test("a live request cancelled while its messages are being rendered sends nothing to the CLI", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SLOW_ABORT = "1500";
  try {
    const abort = new AbortController(); const create = sessionParams({ model: "fixture", summary: undefined, catalog: [], system: "" });
    const session = await CopilotLiveSession.start({ key: "key", fingerprint: "fingerprint", window: "", config: { id: providerId, type: "copilot-subscription", models: { alias: "fixture" } },
      create, toolNames: new Set(), onClose: () => {} }, abort.signal);
    const controller = new AbortController(); let render!: (prompts: Prompt[]) => void; const rendered = new Promise<Prompt[]>(resolve => { render = resolve; });
    let called!: () => void; const rendering = new Promise<void>(resolve => { called = resolve; });
    const events = session.run({ begin: { prompts: () => { called(); return rendered; } }, prefix: [], signal: controller.signal, onEnd: () => {},
      turn: new CopilotTurn({ model: "fixture", offered: ["fixture"], tools: [], choice: undefined, summary: undefined }) });
    const reading = (async () => { try { for await (const event of events) void event; return undefined; } catch (error) { return error; } })();
    await rendering; controller.abort(); render([{ prompt: "hello" }]);
    const error = await reading; assert.ok(error instanceof ProviderError && error.code === "cancelled", String(error));
    const [pid] = await h.pids(); assert.ok(await until(() => !alive(pid)), "the CLI is gone");
    assert.equal(count(await h.log(), "session.sendMessages"), 0, "the rendered messages were not sent");
  } finally { await h.restore(); }
});
