import test from "node:test";
import assert from "node:assert/strict";
import { claudeRequestRejection } from "../providers/claude-request-rejection.js";
import { claudeFailure } from "../providers/claude-errors.js";
import { ClaudeMessageStream, claudeResultFailure } from "../providers/claude-stream.js";
import { ProviderError } from "../providers/provider.js";
import { providerFailureDiagnostic, streamFailureCode } from "../provider-failure.js";

const privateMarker = "private-request-and-account-details";
const diagnostic = `API Error: Opus refused the request. ${privateMarker}\n\nDetails: \`[reasoning_extraction]\`\n\nRequest ID: private-request-id`;
const assistant = (text: unknown = diagnostic) => ({ type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text }] } });

test("the native reasoning-extraction marker becomes a safe final refusal on assistant and result paths", () => {
  for (const message of [assistant(), { ...assistant(), message: { content: diagnostic } },
    { type: "result", is_error: true, subtype: "error_during_execution", error_code: "invalid_request", result: diagnostic },
    { type: "result", is_error: true, subtype: "error_during_execution", errors: [diagnostic] }]) {
    const failure = claudeFailure(message)!;
    assert.equal(failure.code, "invalid_request"); assert.equal(failure.status, 400);
    assert.equal(failure.upstream?.reason, "reasoning_extraction");
    assert.equal(streamFailureCode(failure), "invalid_prompt");
    assert.match(failure.message, /Retrying the same request will not help/);
    assert.ok(!JSON.stringify(failure).includes(privateMarker));
    assert.equal(providerFailureDiagnostic({ requestId: "00000000-0000-4000-8000-000000000000", failure, durationMs: 0 }).upstreamReason, "reasoning_extraction");
    assert.ok(!JSON.stringify(providerFailureDiagnostic({ requestId: "00000000-0000-4000-8000-000000000000", failure, durationMs: 0 })).includes(privateMarker));
    for (const endTurn of [false, true]) {
      assert.throws(() => new ClaudeMessageStream({ tools: [], summaryVisible: true, endTurn }).accept(message),
        error => error instanceof ProviderError && error.upstream?.reason === "reasoning_extraction");
    }
    if (message.type === "result") assert.equal(claudeResultFailure(message).upstream?.reason, "reasoning_extraction");
  }
});

test("normal prose, conflicting native codes, oversized diagnostics and unrecognized markers never acquire a policy reason", () => {
  for (const message of [
    { ...assistant(), error: undefined },
    { type: "result", is_error: false, result: diagnostic },
    { type: "result", is_error: true, error_code: "server_error", result: diagnostic },
    { ...assistant(), error: "server_error" },
    assistant(`Quoted example\n${diagnostic}`), assistant(diagnostic.replace("reasoning_extraction", "invented_reason")),
    assistant(diagnostic + "x".repeat(16 * 1024)),
    { ...assistant(), message: { content: [{ type: "tool_use", text: diagnostic }] } },
    { ...assistant(), message: { content: [...Array.from({ length: 8 }, () => ({ type: "text", text: "ordinary" })), { type: "text", text: diagnostic }] } },
  ]) assert.equal(claudeRequestRejection(message), undefined);
});
