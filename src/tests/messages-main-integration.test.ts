import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { createGatewayHandler } from "../server.js";
import { flushRecords } from "../usage-ledger.js";
import type { InferenceContext, Provider } from "../providers/provider.js";
import { readEvents } from "../protocol/sse.js";
import type { WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const input = { model: "alias", max_tokens: 128, stream: true, messages: [{ role: "user", content: "hello" }] };
async function fixture(provider: Provider) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-messages-main-"));
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, maxConcurrent: 1,
    providers: [{ id: "fixture", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TEST_UNUSED_KEY", models: { alias: "upstream" } }] };
  const handler = await createGatewayHandler(config, () => provider, undefined, { onFailure() {} });
  const server = createServer(handler.handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const token = await gatewayToken(directory);
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/messages`;
  return { handler,
    post: (body: unknown = input, headers: Record<string, string> = {}) => fetch(endpoint, { method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": token, ...headers }, body: JSON.stringify(body) }),
    close: async () => {
      handler.abortAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      // A request writes its usage row and telemetry after its stream ends, so the folder goes only once the handler is idle
      // and those writes are flushed; removing it earlier raced a late row into the usage folder (ENOTEMPTY).
      for (const until = Date.now() + 5000; !handler.isIdle() && Date.now() < until;) await delay(10);
      await flushRecords(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
async function collect(response: Response): Promise<WireEvent[]> {
  const events: WireEvent[] = []; for await (const event of readEvents(response.body!)) events.push(event); return events;
}

test("Messages retains routing context and upstream transport headers without leaking transport events", async () => {
  let context: InferenceContext | undefined;
  const gateway = await fixture({ emitsTransport: true, async *infer(_request, _signal, seen) {
    context = seen;
    yield { type: "transport", turnState: "gts1:provider-route" };
    yield { type: "text", text: "answer" }; yield { type: "done", usage };
  } });
  try {
    const response = await gateway.post({ ...input, thinking: { type: "adaptive" } }, {
      "session-id": "fixture-session", "thread-id": "fixture-thread", "x-codex-turn-state": "gts1:caller-route",
    });
    assert.equal(response.headers.get("x-codex-turn-state"), "gts1:provider-route");
    const events = await collect(response);
    assert.equal(events[0].type, "message_start"); assert.equal(events.at(-1)!.type, "message_stop");
    assert.equal(events.some(event => event.type === "transport" || event.type.startsWith("response.")), false);
    assert.deepEqual(context, { sessionId: "fixture-session", threadId: "fixture-thread", turnState: "gts1:caller-route", clientProtocol: "messages", adaptiveThinking: true });
  } finally { await gateway.close(); }
});

test("Messages arriving after drain starts receive native retryable errors before inference", async () => {
  let calls = 0;
  const gateway = await fixture({ async *infer() { calls++; yield { type: "done", usage }; } });
  try {
    assert.equal(gateway.handler.beginDrain!(), 0);
    const response = await gateway.post();
    assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "1");
    const error = await response.json() as { type: string; error: { type: string }; request_id: string };
    assert.equal(error.type, "error"); assert.equal(error.error.type, "api_error");
    assert.equal(error.request_id, response.headers.get("request-id")); assert.equal(calls, 0);
  } finally { await gateway.close(); }
});

test("Messages drain rejects queued work while the admitted native stream finishes", { timeout: 10000 }, async () => {
  let calls = 0; let release!: () => void; let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gateway = await fixture({ async *infer() { calls++; started(); await held; yield { type: "text", text: "done" }; yield { type: "done", usage }; } });
  try {
    const admitted = await gateway.post(); await entered;
    const queued = await gateway.post();
    assert.equal(gateway.handler.beginDrain!(), 1);
    const rejected = await collect(queued);
    assert.equal(rejected.at(-1)!.type, "error");
    assert.equal((rejected.at(-1)!.error as { type: string }).type, "api_error");
    assert.equal(rejected.some(event => event.type === "message_stop"), false);
    release(); assert.equal((await collect(admitted)).at(-1)!.type, "message_stop");
    assert.equal(calls, 1);
  } finally { release(); await gateway.close(); }
});
