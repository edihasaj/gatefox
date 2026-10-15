import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { gatewayToken, validateConfig, type GatewayConfig } from "../config.js";
import { createGatewayHandler, startGateway } from "../server.js";
import { CopilotSubscription } from "../providers/copilot.js";
import type { Provider } from "../providers/provider.js";
import { alive, harness, live, providerId, sleep, until, type Harness } from "./copilot-live-harness.js";

// A provider that a configuration no longer serves must not keep a live session, which holds a CLI process and the
// conversation log: whether the configuration is reloaded while the session is still starting, or an in-place upgrade
// adopts a session the new release's configuration does not serve.
const provider = () => ({ id: providerId, type: "copilot-subscription", models: { alias: "fixture" } });
const other = { id: "other", type: "claude-subscription", models: { other: "x" } };
const config = (h: Harness, providers: unknown[]): GatewayConfig => validateConfig({ version: 1, port: 0, stateDirectory: join(h.directory, "state"), providers });
const factory = (p: { type: string }) => p.type === "copilot-subscription" ? new CopilotSubscription(p as ConstructorParameters<typeof CopilotSubscription>[0]) : {} as Provider;

test("a provider removed while its live session is still starting loses that session when the request it started ends", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SLOW_CREATE = "1500";
  let next = config(h, [provider(), other]);
  const server = await startGateway(next, factory, async () => next, { onFailure: () => {}, copilotTempBase: h.scratch });
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { Authorization: `Bearer ${await gatewayToken(join(h.directory, "state"))}`, "Content-Type": "application/json", "thread-id": "thread-1" };
    const answered = fetch(`${url}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "alias", input: "hello", stream: true }) }).then(response => response.text());
    // The CLI has started and is slow to create its session: the attach is in progress, and no session is registered yet.
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "create"))); await sleep(200);
    assert.equal(live().sessions().length, 0, "the session is not registered yet");
    next = config(h, [other]); await fetch(`${url}/health`);
    assert.match(await answered, /answer/, "the request that was already running is still answered");
    const [pid] = await h.pids();
    assert.ok(await until(async () => !alive(pid) && live().sessions().length === 0 && (await h.liveDirs()).length === 0), "the session is gone once its request has ended, though its provider was removed while it started");
    assert.deepEqual((await h.sessions()).filter(entry => entry.outcome === "closed").map(entry => entry.missReason), ["provider_removed"]);
  } finally { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await h.restore(); }
});

test("a gateway generation that starts with a configuration which no longer serves a session's provider retires it", { timeout: 30000 }, async () => {
  const h = await harness();
  const first = config(h, [provider(), other]);
  const server = await startGateway(first, factory, undefined, { onFailure: () => {}, copilotTempBase: h.scratch });
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { Authorization: `Bearer ${await gatewayToken(join(h.directory, "state"))}`, "Content-Type": "application/json", "thread-id": "thread-1" };
    await (await fetch(`${url}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "alias", input: "hello", stream: true }) })).text();
    assert.equal(live().sessions().length, 1); const [pid] = await h.pids();
    // An upgrade whose configuration still serves the provider keeps the session it adopts.
    await createGatewayHandler(config(h, [provider(), other]), factory, undefined, { copilotTempBase: h.scratch });
    await sleep(300); assert.equal(live().sessions().length, 1); assert.ok(alive(pid), "the session lives on");
    // One whose configuration does not serve it ends it, though it was never reloaded.
    await createGatewayHandler(config(h, [other]), factory, undefined, { copilotTempBase: h.scratch });
    assert.ok(await until(async () => !alive(pid) && live().sessions().length === 0 && (await h.liveDirs()).length === 0), "the adopted session of a removed provider is closed");
    assert.deepEqual((await h.sessions()).filter(entry => entry.outcome === "closed").map(entry => entry.missReason), ["provider_removed"]);
  } finally { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await h.restore(); }
});
