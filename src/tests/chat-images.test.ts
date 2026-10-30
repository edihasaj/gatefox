import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../config.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import type { ResponsesRequest } from "../protocol/types.js";

const key = "GATEWAY_CHAT_IMAGE_FIXTURE";
const png = "data:image/png;base64," + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64");
const config = (modalities: Array<"text" | "image">): ProviderConfig => ({ id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key,
  models: { "qwen/flash": "fixture" }, modelMetadata: { "qwen/flash": { inputModalities: modalities } } } as ProviderConfig);
const tools = [{ type: "function" as const, name: "view_image", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { type: "function" as const, name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }];

async function outbound(t: test.TestContext, provider: ChatCompletionsAPI, request: ResponsesRequest): Promise<Record<string, unknown>> {
  const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  let body: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => { body = JSON.parse(init.body); return new Response("fixture stop", { status: 500 }); });
  await assert.rejects(async () => { for await (const _ of provider.infer(request, new AbortController().signal)) { /* stops at the upstream */ } });
  assert.ok(body, "the request reached the upstream");
  return body!;
}

type Message = { role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] };

test("an image-capable chat model gets user images as image_url parts in their original order", async t => {
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is this?" }, { type: "input_image", image_url: png }, { type: "input_text", text: "Be brief." }] }];
  const body = await outbound(t, new ChatCompletionsAPI(config(["text", "image"])), { model: "fixture", input } as unknown as ResponsesRequest);
  const user = (body.messages as Message[]).find(message => message.role === "user")!;
  assert.deepEqual(user.content, [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: png } }, { type: "text", text: "Be brief." }]);
});

test("tool-result images follow the run of tool results in one user message, keeping tool results contiguous", async t => {
  const input = [
    { type: "message", role: "user", content: "Look at the screenshot and the log." },
    { type: "function_call", call_id: "c1", name: "view_image", arguments: "{\"path\":\"/a.png\"}" },
    { type: "function_call", call_id: "c2", name: "exec_command", arguments: "{\"cmd\":\"tail log\"}" },
    { type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: png }] },
    { type: "function_call_output", call_id: "c2", output: "ok" },
    { type: "message", role: "user", content: "Now explain." },
  ];
  const body = await outbound(t, new ChatCompletionsAPI(config(["text", "image"])), { model: "fixture", input, tools } as unknown as ResponsesRequest);
  const messages = (body.messages as Message[]).filter(message => message.role !== "system");
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "tool", "tool", "user", "user"]);
  assert.equal(typeof messages[2]!.content, "string", "a tool message carries text only");
  const images = messages[4]!.content as Array<{ type: string; image_url?: { url: string } }>;
  assert.equal(images[0]!.type, "text");
  assert.deepEqual(images.slice(1), [{ type: "image_url", image_url: { url: png } }]);
});

test("a text-only chat model still refuses images with a clear reason", async t => {
  const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const input = [{ type: "message", role: "user", content: [{ type: "input_image", image_url: png }] }];
  await assert.rejects(async () => { for await (const _ of new ChatCompletionsAPI(config(["text"])).infer({ model: "fixture", input } as unknown as ResponsesRequest, new AbortController().signal)) { /* refused */ } },
    (error: unknown) => (error as { code?: string }).code === "unsupported_input" && /does not accept images/.test((error as Error).message));
});

test("an image from an undeclared historical tool stays with that tool's text note", async t => {
  const input = [
    { type: "function_call", call_id: "c9", name: "mcp__screens__capture", arguments: "{}" },
    { type: "function_call_output", call_id: "c9", output: [{ type: "input_image", image_url: png }] },
    { type: "message", role: "user", content: "Summarize." },
  ];
  const body = await outbound(t, new ChatCompletionsAPI(config(["text", "image"])), { model: "fixture", input } as unknown as ResponsesRequest);
  const note = (body.messages as Message[]).find(message => Array.isArray(message.content) && JSON.stringify(message.content).includes("Result of earlier tool call mcp__screens__capture"))!;
  assert.ok(note, "the converted result keeps its image");
  assert.deepEqual((note.content as unknown[]).at(-1), { type: "image_url", image_url: { url: png } });
});
