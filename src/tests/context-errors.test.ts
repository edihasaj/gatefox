import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { anthropicContextFailure, claudeContextFailure, copilotContextFailure } from "../providers/context-errors.js";
import { AnthropicAPI } from "../providers/anthropic-api.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { ClaudeSubscription } from "../providers/claude.js";
import { ProviderError } from "../providers/provider.js";
import type { InferenceEvent } from "../protocol/types.js";
const collect = async (events: AsyncIterable<InferenceEvent>) => { const result = []; for await (const event of events) result.push(event); return result; };
const context = (error: unknown) => error instanceof ProviderError && error.code === "context_length_exceeded" && error.status === 400 && !error.message.includes("private-token");

test("only authoritative native error envelopes identify context overflow", () => {
  assert.ok(anthropicContextFailure({ error: { type: "invalid_request_error", message: "prompt is too long: 200001 tokens > 200000 maximum" } }));
  assert.equal(anthropicContextFailure({ error: { type: "authentication_error", message: "prompt is too long" } }), undefined);
  assert.equal(anthropicContextFailure({ error: { type: "invalid_request_error", message: "The caller quoted prompt is too long in its code" } }), undefined);
  assert.ok(claudeContextFailure({ type: "result", is_error: true, terminal_reason: "prompt_too_long" }));
  assert.ok(claudeContextFailure({ type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: "Prompt is too long" }] } }));
  assert.equal(claudeContextFailure({ type: "result", subtype: "success", is_error: false, result: "Prompt is too long" }), undefined);
  assert.equal(claudeContextFailure({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "Prompt is too long" }), undefined);
  assert.equal(claudeContextFailure({ type: "assistant", message: { content: [{ type: "text", text: "Prompt is too long" }] } }), undefined);
  // The CLI's longer form for a conversation it cannot compact is still an overflow inside a native error envelope, without counts.
  const long = claudeContextFailure({ type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: "Prompt is too long · Run /compact or start a new chat" }] } });
  assert.equal(long?.code, "context_length_exceeded"); assert.equal(long?.upstream?.contextTokens, undefined);
  assert.equal(claudeContextFailure({ type: "assistant", message: { content: [{ type: "text", text: "Prompt is too long · Run /compact" }] } }), undefined);
  assert.equal(anthropicContextFailure({ error: { type: "invalid_request_error", message: "Prompt is too long · Run /compact" } }), undefined);
  assert.ok(copilotContextFailure({ errorType: "context_length_exceeded", message: "private-token" }));
  assert.equal(copilotContextFailure({ errorType: "notification", message: "context_length_exceeded prompt is too long" }), undefined);
});

test("chat and Anthropic wire errors retain context codes without exposing upstream messages", async () => {
  const key = "GATEWAY_CONTEXT_FIXTURE_KEY"; const before = process.env[key]; process.env[key] = "fixture";
  let mode = "http"; let kind = "chat";
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the private fixture request. */ }
    const error = kind === "chat" ? { code: mode === "other" ? "invalid_request" : "context_length_exceeded", message: "private-token prompt is too long" }
      : { type: "invalid_request_error", message: mode === "other" ? "The user quoted prompt is too long" : "prompt is too long: 200001 tokens > 200000 maximum" };
    if (mode === "http" || mode === "other" || mode === "auth") { response.writeHead(mode === "auth" ? 401 : 400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error })); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "stop") response.end('data: {"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"}}\n\ndata: {"type":"message_stop"}\n\n');
    else response.end(`data: ${JSON.stringify({ type: "error", error })}\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  try {
    for (kind of ["chat", "anthropic"]) {
      const config = { id: "fixture", models: { alias: "fixture" }, baseUrl, apiKeyEnv: key };
      const adapter = kind === "chat" ? new ChatCompletionsAPI({ ...config, type: "chat-completions-api" }) : new AnthropicAPI({ ...config, type: "anthropic-api" });
      for (mode of ["http", "stream", ...(kind === "anthropic" ? ["stop"] : [])]) await assert.rejects(collect(adapter.infer({ model: "fixture", input: "compact fixture" }, new AbortController().signal)), context);
      mode = "other"; await assert.rejects(collect(adapter.infer({ model: "fixture", input: "fixture" }, new AbortController().signal)), error => error instanceof ProviderError && error.code !== "context_length_exceeded" && !error.message.includes("private-token"));
      mode = "auth"; await assert.rejects(collect(adapter.infer({ model: "fixture", input: "fixture" }, new AbortController().signal)), error => error instanceof ProviderError && error.code === "authentication");
    }
  } finally { if (before === undefined) delete process.env[key]; else process.env[key] = before; upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test("Claude CLI context failures propagate while normal prose remains a successful answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-context-"));
  const script = `#!${process.execPath}\nlet input='';for await(const chunk of process.stdin)input+=chunk;const mode=process.env.GATEWAY_CLAUDE_CONTEXT_FIXTURE;
const error=mode==='assistant';if(error)console.log(JSON.stringify({type:'assistant',error:'invalid_request',message:{content:[{type:'text',text:'Prompt is too long'}]}}));
console.log(JSON.stringify(mode==='result'?{type:'result',is_error:true,subtype:'error_during_execution',terminal_reason:'prompt_too_long',errors:['private-token']}:{type:'result',is_error:false,subtype:'success',result:'Prompt is too long',usage:{input_tokens:1,output_tokens:1}}));\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = { path: process.env.PATH, mode: process.env.GATEWAY_CLAUDE_CONTEXT_FIXTURE }; process.env.PATH = directory + delimiter + process.env.PATH;
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" } });
    for (const mode of ["result", "assistant"]) { process.env.GATEWAY_CLAUDE_CONTEXT_FIXTURE = mode; await assert.rejects(collect(adapter.infer({ model: "fixture", input: "fixture" }, new AbortController().signal)), context); }
    process.env.GATEWAY_CLAUDE_CONTEXT_FIXTURE = "normal";
    const events = await collect(adapter.infer({ model: "fixture", input: "fixture" }, new AbortController().signal)); assert.equal(events.at(-1)?.type, "done"); assert.ok(events.some(event => event.type === "text" && event.text === "Prompt is too long"));
  } finally { if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path; if (previous.mode === undefined) delete process.env.GATEWAY_CLAUDE_CONTEXT_FIXTURE; else process.env.GATEWAY_CLAUDE_CONTEXT_FIXTURE = previous.mode; await rm(directory, { recursive: true, force: true }); }
});
