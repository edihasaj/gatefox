import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { sessionRegistry } from "../providers/claude-session-registry.js";
import { ProviderError } from "../providers/provider.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import type { InferenceEvent, ResponsesInputItem } from "../protocol/types.js";
import { rejectedClaudeTool } from "../providers/claude-calls.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const user = (text: string): ResponsesInputItem => ({ role: "user", content: text });
const tools = [{ type: "function" as const, name: "read", parameters: { type: "object", properties: {} } }];
const provider = () => new ClaudeSubscription({ id: `tool-rejection-${process.pid}`, type: "claude-subscription",
  models: { fixture: "fixture" }, claudeSessions: { warmup: 0 } });

test("older error classes normalize fixed tool-name failures without trusting prose or getters", () => {
  const legacy = Object.assign(new Error("private old error text"), { code: "invalid_tool_call", status: 502,
    upstream: { code: "unknown_tool", event: "claude.tool_use" } });
  const normalized = rejectedClaudeTool(legacy);
  assert.ok(normalized instanceof ProviderError);
  assert.equal(normalized.upstream?.code, "unknown_tool");
  assert.equal(normalized.message.includes("private"), false);
  assert.equal(rejectedClaudeTool(Object.assign(new Error("crash"), { code: "cli_failed" })), undefined);
  assert.equal(rejectedClaudeTool(Object.assign(new Error("other"), { code: "invalid_tool_call", upstream: { code: "unknown_tool", event: "other" } })), undefined);
  let reads = 0;
  const getter = Object.defineProperty(new Error("private"), "upstream", { get() { reads++; throw Error("must not read"); } });
  assert.equal(rejectedClaudeTool(getter), undefined);
  assert.equal(reads, 0);
});

async function turn(subscription: ClaudeSubscription, input: ResponsesInputItem[], events: InferenceEvent[] = []) {
  const writer = new ResponsesWriter("fixture", () => {});
  for await (const event of subscription.infer({ model: "fixture", input, tools }, new AbortController().signal, { threadId: "same-chat" })) {
    events.push(event); writer.accept(event);
  }
  return writer.result().output as ResponsesInputItem[];
}

for (const [foreign, reason] of [["unregistered-private-tool", "unknown_tool"], ["mcp__gateway__missing", "unavailable_gateway_tool"], ["Bash", "native_builtin_tool"]]) {
  test(`a controlled ${reason} stop permits only a later caller request`, { timeout: 30000 }, async () => {
    const fixture = await installClaudeFixture({ replies: [{ foreign }, { text: "RECOVERED" }] });
    try {
      const subscription = provider(), events: InferenceEvent[] = [];
      await assert.rejects(turn(subscription, [user("first")], events),
        (error: unknown) => error instanceof ProviderError && error.code === "invalid_tool_call" && error.upstream?.code === reason);
      assert.equal(events.some(event => event.type === "tool"), false);
      assert.equal((await fixture.capture()).filter(entry => entry.start).length, 1, "the failed request never replays itself");
      assert.equal(sessionRegistry().sessions.size, 0);
      assert.equal(sessionRegistry().replayUntil.size, 0, "a deliberate confinement stop is not a CLI crash");
      const recovered = await turn(subscription, [user("first"), user("try again")]);
      assert.ok(JSON.stringify(recovered).includes("RECOVERED"));
      assert.equal((await fixture.capture()).filter(entry => entry.start).length, 2);
    } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
  });
}

test("recovery after a rejected tool does not repeat an earlier caller tool result", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "read", input: {} }] },
    { foreign: "unregistered-private-tool" }, { text: "RECOVERED" }] });
  try {
    const subscription = provider(), first = [user("read")];
    const output = await turn(subscription, first);
    const results: ResponsesInputItem[] = output.flatMap(item => item.type === "function_call"
      ? [{ type: "function_call_output", call_id: item.call_id, output: "caller already executed this once" }] : []);
    const history = [...first, ...output, ...results], events: InferenceEvent[] = [];
    await assert.rejects(turn(subscription, history, events), (error: unknown) => error instanceof ProviderError && error.upstream?.code === "unknown_tool");
    assert.equal(events.some(event => event.type === "tool"), false);
    await turn(subscription, [...history, user("continue")]);
    const capture = await fixture.capture();
    assert.equal(capture.filter(entry => entry.toolResult !== undefined).length, 1);
    assert.equal(capture.filter(entry => entry.start).length, 2);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
});

test("a truncated registered tool call fails once without a crash hold, then a new caller message can continue", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "read", input: null as never }] }, { text: "RECOVERED" }] });
  try {
    const events: InferenceEvent[] = [], subscription = provider();
    await assert.rejects(turn(subscription, [user("first")], events), /malformed_tool_call/);
    assert.equal(events.some(event => event.type === "tool"), false);
    assert.equal(sessionRegistry().replayUntil.size, 0);
    assert.equal((await fixture.capture()).filter(entry => entry.start).length, 1);
    const output = await turn(subscription, [user("first"), user("try again")]);
    assert.ok(JSON.stringify(output).includes("RECOVERED"));
    assert.equal((await fixture.capture()).filter(entry => entry.start).length, 2);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
});

test("an upgraded handler keeps an existing hashed catalog and its pending caller output on the same CLI", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "read", input: {} }] }, { text: "CONTINUED" }, { text: "ADOPTED" }] });
  try {
    const modulePath = join(fixture.directory, "legacy-profile.mjs");
    const live = new URL("../providers/claude-live.js", import.meta.url).href;
    const names = new URL("../providers/claude-tool-names.js", import.meta.url).href;
    const control = new URL("../providers/claude-control.js", import.meta.url).href;
    await writeFile(modulePath, `import {createHash} from 'node:crypto';
import {claudeLive as real} from ${JSON.stringify(live)};
import {keepLegacyClaudeToolNames} from ${JSON.stringify(names)};
import {claudeMcpCatalog} from ${JSON.stringify(control)};
export function claudeLive(settings){const delegate=real(settings);return {...delegate,attach(input,signal){
keepLegacyClaudeToolNames(input.tools);input.spawn.mcpCatalog=claudeMcpCatalog(input.tools);
input.toolsDigest=createHash('sha256').update(JSON.stringify(input.spawn.mcpCatalog)).digest('hex');input.toolNameMode='legacy';
return delegate.attach(input,signal);}};}`, { mode: 0o600 });
    const config = { id: `tool-rejection-${process.pid}`, type: "claude-subscription" as const,
      models: { fixture: "fixture" }, claudeSessions: { warmup: 0 } };
    const old = new ClaudeSubscription(config, undefined, undefined, pathToFileURL(modulePath).href);
    const first = [user("read")], output = await turn(old, first);
    const session = [...sessionRegistry().sessions.values()][0], pid = session.pid;
    const results: ResponsesInputItem[] = output.flatMap(item => item.type === "function_call"
      ? [{ type: "function_call_output", call_id: item.call_id, output: "caller executed once" }] : []);
    const history = [...first, ...output, ...results];
    const continued = await turn(provider(), history);
    assert.ok(JSON.stringify(continued).includes("CONTINUED"));
    sessionRegistry().toolNameModes?.delete(session.key); // An adopted older release has no naming-mode field.
    await turn(provider(), [...history, ...continued, user("again")]);
    assert.equal([...sessionRegistry().sessions.values()][0].pid, pid);
    const capture = await fixture.capture();
    assert.equal(capture.filter(entry => entry.start).length, 1);
    assert.equal(capture.filter(entry => entry.toolResult !== undefined).length, 1);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
});

test("an unavailable tool beside a valid sibling forwards neither call", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "read", input: {} }, { tool: "missing", input: {} }] }] });
  try {
    const events: InferenceEvent[] = [];
    await assert.rejects(turn(provider(), [user("read")], events), /unavailable_gateway_tool/);
    assert.equal(events.some(event => event.type === "tool"), false);
    assert.equal((await fixture.capture()).filter(entry => entry.toolResult !== undefined).length, 0);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
});

test("an unsolicited tool between requests remains a protocol crash with a hold", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ text: "FIRST" }, { text: "MUST NOT RUN" }] });
  try {
    const subscription = provider(); await turn(subscription, [user("first")]);
    const session = [...sessionRegistry().sessions.values()][0];
    const reader = session as unknown as { line(line: string): void };
    reader.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_start",
      content_block: { type: "tool_use", id: "unsolicited", name: "unregistered-private-tool", input: {} } } }));
    assert.equal(sessionRegistry().replayUntil.size, 1);
    await assert.rejects(turn(subscription, [user("first"), user("continue")]),
      (error: unknown) => error instanceof ProviderError && error.upstream?.code === "session_continuity_unavailable");
    assert.equal((await fixture.capture()).filter(entry => entry.start).length, 1);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
});
