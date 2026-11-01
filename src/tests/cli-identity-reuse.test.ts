import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { ProviderError } from "../providers/provider.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import { adapter, harness, turn, user } from "./copilot-live-harness.js";

const history = [user("First"), { type: "message" as const, role: "assistant" as const, content: "Answer" }, user("Next")];
const refused = (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable";

test("Claude defaults to live and refuses unidentified history while explicit replay remains opt-in", async () => {
  const fixture = await installClaudeFixture({ replies: [{ text: "First" }, { text: "Explicit replay" }] });
  try {
    const provider = new ClaudeSubscription({ id: "identity-claude", type: "claude-subscription", models: { fixture: "fixture" } });
    const run = async (selected: ClaudeSubscription, input: typeof history | string) => { for await (const _ of selected.infer({ model: "fixture", input }, new AbortController().signal)) {} };
    await run(provider, "Standalone");
    await assert.rejects(run(provider, history), refused);
    assert.equal((await fixture.capture()).filter(row => row.start).length, 1);
    await run(new ClaudeSubscription({ id: "identity-claude", type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "replay" } }), history);
    assert.equal((await fixture.capture()).filter(row => row.start).length, 2);
  } finally { await fixture.restore(); }
});

test("Copilot refuses unidentified history while independent questions and explicit replay remain usable", async () => {
  const h = await harness();
  try {
    await turn(adapter(), [user("Standalone")], { context: {} });
    await assert.rejects(turn(adapter(), history, { context: {} }), refused);
    assert.equal((await h.log()).filter(row => row.op === "create").length, 1);
    await turn(adapter({ mode: "replay" }), history, { context: {} });
    assert.equal((await h.log()).filter(row => row.op === "create").length, 2);
  } finally { await h.restore(); }
});
