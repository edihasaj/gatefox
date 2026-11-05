import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { startGateway } from "../server.js";

type Protocol = "responses" | "messages";
type Choice = "named" | "auto" | "required" | "none";
type Completion = {
  finish?: string; name?: string; arguments?: string; id?: string;
  missingCall?: boolean; duplicate?: boolean; done?: boolean;
};
type Result = {
  status?: string; stop_reason?: string; error?: unknown;
  output?: Array<{ type: string; name?: string; call_id?: string; arguments?: string; input?: string }>;
  content?: Array<{ type: string; name?: string; id?: string; input?: unknown }>;
};
const parameters = { type: "object", properties: {
  count: { type: "integer" }, enabled: { type: "boolean" }, paths: { type: "array", items: { type: "string" } },
  options: { type: "object", properties: { mode: { type: "string" } } },
} };
const input = { count: 2, enabled: false, paths: ["one", "two"], options: { mode: "read" } };

// Exercise the real HTTP ingress, request normalization, ChatCompletionsAPI and client output.
// The fixture deliberately follows vLLM's named-tool completion: a call, finish_reason stop, [DONE].
for (const protocol of ["responses", "messages"] as const) {
  test(`${protocol}: named Chat Completions tools accept stop without weakening validation`, async t => {
    let completion: Completion = {};
    let received: Record<string, unknown> = {};
    let requests = 0;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      received = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; requests++;
      const catalog = received.tools as Array<{ function: { name: string; description?: string } }>;
      const selected = catalog.find(tool => tool.function.description?.includes("Selected caller tool"))!.function.name;
      const other = catalog.find(tool => tool.function.name !== selected)!.function.name;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({
        model: "fixture", choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      if (!completion.missingCall) {
        const args = completion.arguments ?? JSON.stringify(input);
        const split = Math.floor(args.length / 2);
        emit({ tool_calls: [{ index: 0, id: completion.id ?? "call_selected", function: {
          name: completion.name === "__other__" ? other : completion.name ?? selected, arguments: args.slice(0, split),
        } }] });
        emit({ tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] });
        if (completion.duplicate) emit({ tool_calls: [{ index: 1, id: "call_selected", function: {
          name: selected, arguments: JSON.stringify(input),
        } }] });
      }
      if (completion.finish !== undefined) emit({}, completion.finish);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } })}\n\n`);
      res.end(completion.done === false ? "" : "data: [DONE]\n\n");
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const key = `GATEWAY_NAMED_STOP_${protocol.toUpperCase()}`;
    const previous = process.env[key]; process.env[key] = "fixture-only";
    const directory = await mkdtemp(join(tmpdir(), "gateway-named-stop-"));
    const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, providers: [{
      id: "fixture", type: "chat-completions-api", apiKeyEnv: key,
      baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, models: { alias: "fixture" },
    }] };
    const gateway = await startGateway(config); const token = await gatewayToken(directory);
    t.after(async () => {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
      gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve()));
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    });
    const send = async (choice: Choice = "named", custom = false) => {
      const tools = protocol === "responses" ? [
        custom ? { type: "custom", name: "selected", description: "Selected caller tool" } : { type: "function", name: "selected", description: "Selected caller tool", parameters },
        { type: "function", name: "other", description: "Other caller tool", parameters },
      ] : [{ name: "selected", description: "Selected caller tool", input_schema: parameters }, { name: "other", description: "Other caller tool", input_schema: parameters }];
      const tool_choice = protocol === "responses" ? choice === "named"
        ? { type: custom ? "custom" : "function", name: "selected" } : choice
        : choice === "named" ? { type: "tool", name: "selected" } : { type: choice === "required" ? "any" : choice };
      const body = { model: "alias", tools, tool_choice, ...(protocol === "responses"
        ? { input: "Use the selected tool" } : { max_tokens: 128, messages: [{ role: "user", content: "Use the selected tool" }] }) };
      return fetch(`http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/${protocol}`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      });
    };
    for (const finish of ["stop", "tool_calls"]) {
      await t.test(`named tool with ${finish} preserves selected identity and typed arguments`, async () => {
        completion = { finish }; const before = requests;
        const response = await send(); const result = await response.json() as Result;
        assert.equal(response.status, 200); assert.equal(requests - before, 1, "exactly one upstream request");
        const native = (received.tools as Array<{ function: { name: string; description?: string } }>).find(tool => tool.function.description?.includes("Selected caller tool"))!.function.name;
        assert.deepEqual(received.tool_choice, { type: "function", function: { name: native } });
        if (protocol === "responses") {
          assert.equal(result.status, "completed");
          assert.equal(result.output?.length, 1);
          const call = result.output![0]!;
          assert.equal(call.type, "function_call"); assert.equal(call.name, "selected"); assert.equal(call.call_id, "call_selected");
          assert.deepEqual(JSON.parse(call.arguments!), input);
        } else {
          assert.equal(result.stop_reason, "tool_use"); assert.equal(result.content?.length, 1);
          const call = result.content![0]!;
          assert.equal(call.type, "tool_use"); assert.equal(call.name, "selected"); assert.equal(call.id, "call_selected");
          assert.deepEqual(call.input, input);
        }
      });
    }
    const failures: Array<{ name: string; choice?: Choice; completion: Completion }> = [
      ...(["auto", "required", "none"] as const).map(choice => ({ name: `${choice} cannot return stop with a tool`, choice, completion: { finish: "stop" } })),
      { name: "none cannot return normal tool_calls", choice: "none", completion: { finish: "tool_calls" } },
      { name: "the named tool must match", completion: { finish: "stop", name: "__other__" } },
      { name: "an unknown tool is rejected", completion: { finish: "stop", name: "tool_9" } },
      { name: "malformed JSON is rejected", completion: { finish: "stop", arguments: '{"count":' } },
      { name: "array input is rejected", completion: { finish: "stop", arguments: "[]" } },
      { name: "null input is rejected", completion: { finish: "stop", arguments: "null" } },
      { name: "duplicate call IDs are rejected", completion: { finish: "stop", duplicate: true } },
      { name: "an absent call ID is rejected", completion: { finish: "stop", id: "" } },
      { name: "a missing required call is rejected", choice: "required", completion: { finish: "stop", missingCall: true } },
      { name: "a missing named call is rejected", completion: { finish: "stop", missingCall: true } },
      { name: "length with tools remains a failure", completion: { finish: "length" } },
      { name: "unknown finish remains a failure", completion: { finish: "unexpected" } },
      { name: "no finish remains a failure", completion: {} },
      { name: "no terminal marker remains a failure", completion: { finish: "stop", done: false } },
    ];
    for (const failure of failures) await t.test(failure.name, async () => {
      completion = failure.completion; const before = requests;
      const response = await send(failure.choice); const result = await response.json() as Result;
      const incomplete = !failure.completion.missingCall && (failure.completion.finish === undefined || failure.completion.finish === "length" || failure.completion.finish === "unexpected" || failure.completion.done === false
        || failure.choice !== undefined && failure.choice !== "named" && failure.completion.finish === "stop");
      // A sampled model's garbled call is a retryable 502: only the client may retry, and it re-samples.
      const sampled = ["an unknown tool is rejected", "malformed JSON is rejected", "array input is rejected", "null input is rejected"].includes(failure.name);
      assert.equal(response.status, incomplete || sampled ? 502 : 400); assert.ok(result.error);
      assert.equal(result.output, undefined, "no tool result dispatched to a nonstreaming Responses caller");
      assert.equal(result.content, undefined, "no tool result dispatched to a nonstreaming Messages caller");
      assert.equal(requests - before, 1, "rejected output does not trigger a retry");
    });
    if (protocol === "responses") {
      await t.test("named custom input retains its original string", async () => {
        completion = { finish: "stop", arguments: JSON.stringify({ input: "patch\nproof" }) };
        const response = await send("named", true); const result = await response.json() as Result;
        assert.equal(response.status, 200); assert.equal(result.status, "completed");
        assert.equal(result.output![0]!.type, "custom_tool_call"); assert.equal(result.output![0]!.input, "patch\nproof");
      });
      await t.test("named custom input still requires a string", async () => {
        completion = { finish: "stop", arguments: '{"input":7}' };
        const response = await send("named", true); const result = await response.json() as Result;
        assert.equal(response.status, 502); assert.ok(result.error); assert.equal(result.output, undefined);
      });
    }
  });
}
