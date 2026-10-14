import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedWebSearch, normalizeResponsesTools, responsesInputToMessages, responsesToChatRequest, ResponsesTranslationError } from "../protocol/request.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { modelCatalog } from "../catalog.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { webSearchBackend } from "../web-search.js";
import type { ResponsesRequest, ResponsesTool, WireEvent } from "../protocol/types.js";

const hosted = { type: "web_search", external_web_access: true, search_content_types: ["text", "image"] } as const;
const reason = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof ResponsesTranslationError ? [error.reason, error.itemType] : ["other"]; } return ["accepted"]; };
const request = (extra: Record<string, unknown>) => ({ model: "m", input: "hi", ...extra }) as unknown as ResponsesRequest;

test("the hosted web_search tool is carried verbatim and never joins the function catalog", () => {
  const search = { type: "web_search", external_web_access: false, indexed_web_access: true, filters: { allowed_domains: ["nodejs.org"] },
    user_location: { type: "approximate", country: "US", region: "CA", city: "SF", timezone: "America/Los_Angeles" }, search_context_size: "high", search_content_types: ["text"] };
  const chat = responsesToChatRequest(request({ tools: [{ type: "function", name: "inspect" }, search] }));
  assert.deepEqual(chat.tools!.map(tool => tool.function.name), ["inspect"]);
  assert.equal(hostedWebSearch(request({ tools: [search] })), search, "the caller's own object, not a copy");
  assert.equal(hostedWebSearch(request({ tools: [{ type: "function", name: "inspect" }] })), undefined);
  assert.equal(hostedWebSearch(request({ input: [{ type: "additional_tools", tools: [hosted] }] })), hosted);
  assert.deepEqual(normalizeResponsesTools([hosted as unknown as ResponsesTool]), []);
});

test("hosted tools other than a well-formed web_search still fail before inference", () => {
  assert.deepEqual(reason(() => responsesToChatRequest(request({ tools: [{ type: "web_search_preview" }] }))), ["unsupported_tool", "web_search_preview"]);
  assert.deepEqual(reason(() => responsesToChatRequest(request({ tools: [{ type: "file_search" }] }))), ["unsupported_tool", "file_search"]);
  assert.deepEqual(reason(() => responsesToChatRequest(request({ tools: [{ type: "namespace", name: "g", tools: [hosted] }] }))), ["unsupported_tool", "web_search"]);
  assert.deepEqual(reason(() => responsesToChatRequest(request({ tools: [hosted, hosted] }))), ["duplicate_tool", "web_search"]);
  assert.deepEqual(reason(() => responsesToChatRequest(request({ tool_choice: { type: "web_search" }, tools: [hosted] }))), ["unsupported_tool_choice", "web_search"]);
  for (const bad of [{ extra: 1 }, { external_web_access: "yes" }, { search_context_size: "huge" }, { search_content_types: ["video"] }, { search_content_types: "text" },
    { filters: { blocked_domains: ["a"] } }, { filters: { allowed_domains: [1] } }, { filters: [] }, { user_location: { type: "exact" } }, { user_location: { country: 5 } }, { user_location: "US" }]) {
    assert.deepEqual(reason(() => responsesToChatRequest(request({ tools: [{ ...hosted, ...bad }] }))), ["unsupported_tool", "web_search"], JSON.stringify(bad));
  }
});

test("replayed web_search_call items are validated and skipped unless a route asks for them", () => {
  const call = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "node release", queries: ["node release"] } };
  const input = [{ role: "user", content: "hi" }, call, { role: "user", content: "again" }] as ResponsesRequest["input"];
  assert.deepEqual(responsesInputToMessages(input).map(message => message.role), ["user", "user"]);
  assert.deepEqual(responsesToChatRequest(request({ input })).messages.map(message => message.role), ["user", "user"]);
  assert.deepEqual(responsesInputToMessages(input, { hostedReplay: true })[1], { role: "assistant", content: null, webSearch: { id: "ws_1", status: "completed", action: call.action } });
  assert.deepEqual(responsesInputToMessages([{ type: "web_search_call", id: "ws_2", status: "in_progress" }] as never, { hostedReplay: true })[0].webSearch, { id: "ws_2", status: "in_progress" });
  for (const bad of [{ id: "ws" }, { status: "completed" }, { id: "", status: "completed" }, { id: "a\0b", status: "completed" }, { id: "x".repeat(1025), status: "completed" },
    { id: "ws", status: 1 }, { id: "ws", status: "completed", action: "search" }, { id: "ws", status: "completed", action: [] }, { id: "ws", status: "completed", action: { query: "q".repeat(20000) } }]) {
    assert.deepEqual(reason(() => responsesInputToMessages([{ type: "web_search_call", ...bad }] as never)), ["unsupported_input_item", "web_search_call"], JSON.stringify(bad).slice(0, 60));
  }
});

test("hosted items stream as announced then finished output items and reach the completed snapshot", () => {
  const wire: WireEvent[] = []; const writer = new ResponsesWriter("alias", event => wire.push(event)); writer.begin();
  writer.accept({ type: "text", text: "Looking. " });
  const finalItem = { type: "web_search_call" as const, id: "ws_1", status: "completed", action: { type: "search", query: "q", queries: ["q"] }, extra_field: { keep: true } };
  writer.accept({ type: "hosted-item", item: { type: "web_search_call", id: "ws_1", status: "in_progress" }, done: false });
  writer.accept({ type: "hosted-item", item: finalItem, done: true });
  writer.accept({ type: "hosted-item", item: { type: "web_search_call", id: "ws_2", status: "completed" }, done: true });
  writer.accept({ type: "text", text: "Answer." });
  writer.accept({ type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  const types = wire.map(event => event.type);
  assert.ok(types.indexOf("response.output_item.done") < types.indexOf("response.output_item.added", types.indexOf("response.output_item.added") + 1), "the open message closes before the search item");
  const added = wire.filter(event => event.type === "response.output_item.added" && (event.item as { type: string }).type === "web_search_call");
  assert.deepEqual(added.map(event => event.item), [{ type: "web_search_call", id: "ws_1", status: "in_progress" }, { type: "web_search_call", id: "ws_2", status: "in_progress" }]);
  const done = wire.filter(event => event.type === "response.output_item.done" && (event.item as { type: string }).type === "web_search_call");
  assert.deepEqual(done.map(event => event.item), [finalItem, { type: "web_search_call", id: "ws_2", status: "completed" }]);
  assert.equal(done[0].item === finalItem, false, "published items are copies");
  assert.ok(!types.some(type => type.startsWith("response.web_search_call")), "no synthetic progress events");
  const output = (wire.at(-1)!.response as { output: Array<{ type: string; id?: string }> }).output;
  assert.deepEqual(output.map(item => item.type), ["message", "web_search_call", "web_search_call", "message"]);
  assert.deepEqual(output[1], finalItem);
  assert.equal((wire.at(-1)!.response as { output_text: string }).output_text, "Looking. Answer.");
  assert.throws(() => { const again = new ResponsesWriter("a", () => {}); again.accept({ type: "hosted-item", item: finalItem as never, done: true }); again.accept({ type: "hosted-item", item: finalItem as never, done: true }); }, /twice/);
});

const config = (): GatewayConfig => ({ version: 1, port: 0, stateDirectory: ".", providers: [
  { id: "codex", type: "codex-subscription", credentialFile: "unused", models: { "codex/sol": "sol" } },
  { id: "claude", type: "claude-subscription", models: { "claude/opus": "opus" } },
  { id: "copilot", type: "copilot-subscription", models: { "copilot/sol": "sol" } },
  { id: "api", type: "chat-completions-api", baseUrl: "https://example.test", apiKeyEnv: "UNUSED", models: { "api/model": "model" } },
] });

test("only Codex 2 and Claude rows are marked for web search, and supports_search_tool stays off", () => {
  const rows = new Map(modelCatalog(config()).models.map(row => [row.slug as string, row]));
  assert.equal(rows.get("codex/sol")!.gateway_web_search, true); assert.equal(Object.hasOwn(rows.get("codex/sol")!, "web_search_tool_type"), false);
  assert.equal(rows.get("claude/opus")!.gateway_web_search, true); assert.equal(rows.get("claude/opus")!.web_search_tool_type, "text");
  for (const slug of ["copilot/sol", "api/model"]) { assert.equal(Object.hasOwn(rows.get(slug)!, "gateway_web_search"), false, slug); assert.equal(Object.hasOwn(rows.get(slug)!, "web_search_tool_type"), false, slug); }
  for (const row of rows.values()) assert.equal(row.supports_search_tool, false, "deferred tool_search is unrelated to web search");
  assert.deepEqual(["codex-subscription", "claude-subscription", "copilot-subscription", "responses-api", "anthropic-api", "chat-completions-api"].map(webSearchBackend), ["openai", "anthropic", undefined, undefined, undefined, undefined]);
});

test("the desktop catalog keeps the search fields and drops malformed values", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-search-catalog-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const token = await gatewayToken(directory);
  const row = (slug: string, fields: Record<string, unknown>) => ({ ...modelCatalog({ ...config(), providers: [{ id: "claude", type: "claude-subscription", models: { [slug]: "opus" } }] }).models[0], ...fields });
  const served = [row("ok", {}), row("bad-flag", { gateway_web_search: "yes", web_search_tool_type: "video" }), row("image", { web_search_tool_type: "text_and_image" })];
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ models: served }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const catalog = new DesktopCatalog({ ...config(), port: (server.address() as { port: number }).port, stateDirectory: directory, providers: [] }, [{ slug: "native", priority: 1 }], join(directory, "combined.json"));
  const { models } = await catalog.refresh(true);
  const by = new Map(models.map(model => [model.slug as string, model]));
  assert.equal(by.get("ok")!.gateway_web_search, true); assert.equal(by.get("ok")!.web_search_tool_type, "text");
  assert.equal(Object.hasOwn(by.get("bad-flag")!, "gateway_web_search"), false); assert.equal(Object.hasOwn(by.get("bad-flag")!, "web_search_tool_type"), false);
  assert.equal(by.get("image")!.web_search_tool_type, "text_and_image");
  const reloaded = new DesktopCatalog({ ...config(), port: (server.address() as { port: number }).port, stateDirectory: directory, providers: [] }, [{ slug: "native", priority: 1 }], join(directory, "combined.json"));
  await reloaded.initialize();
  assert.equal(reloaded.current().models.find(model => model.slug === "ok")!.gateway_web_search, true, "the offline cache keeps the flag");
});
