import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { gatewayToken, validateConfig, type GatewayConfig } from "../config.js";
import { startGateway } from "../server.js";
import { CopilotSubscription } from "../providers/copilot.js";
import type { Provider } from "../providers/provider.js";
import { alive, harness, live, providerId, sleep, until, type Harness } from "./copilot-live-harness.js";

// A configuration hot swap that removes a Copilot provider, or changes its id, auth directory or mode, ends that
// provider's live sessions at once: no request will ever reach the old scope to do it, and their folders hold the
// conversation log.
const provider = (extra: Record<string, unknown> = {}) => ({ id: providerId, type: "copilot-subscription", models: { alias: "fixture" }, ...extra });
const config = (h: Harness, providers: unknown[]): GatewayConfig => validateConfig({ version: 1, port: 0, stateDirectory: join(h.directory, "state"), providers });
const other = { id: "other", type: "claude-subscription", models: { other: "x" } };

async function run(update: (h: Harness) => GatewayConfig) {
  const h = await harness(); let next = config(h, [provider(), other]); const first = next;
  const server = await startGateway(first, p => p.type === "copilot-subscription" ? new CopilotSubscription(p) : {} as Provider, async () => next, { onFailure: () => {} });
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { Authorization: `Bearer ${await gatewayToken(join(h.directory, "state"))}`, "Content-Type": "application/json" };
    const response = await fetch(`${url}/v1/responses`, { method: "POST", headers: { ...headers, "thread-id": "thread-1" }, body: JSON.stringify({ model: "alias", input: "hello", stream: true }) });
    await response.text();
    assert.equal(live().sessions().length, 1, "the request started a live session"); const [pid] = await h.pids();
    next = update(h);
    // The new configuration is read by the next request of any kind.
    await fetch(`${url}/health`);
    return { h, pid, ended: async () => { await sleep(0); return until(async () => !alive(pid) && live().sessions().length === 0 && (await h.liveDirs()).length === 0); }, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
  } catch (error) { await h.restore(); throw error; }
}

for (const [name, update, reason] of [
  ["a removed provider", (h: Harness) => config(h, [other]), "provider_removed"],
  ["a provider whose auth directory changed", (h: Harness) => config(h, [provider({ authDirectory: join(h.directory, "account") }), other]), "provider_removed"],
  ["a provider whose id changed", (h: Harness) => config(h, [{ ...provider(), id: "renamed" }, other]), "provider_removed"],
  ["a provider switched to one-shot", (h: Harness) => config(h, [provider({ copilotSessions: { mode: "oneshot" } }), other]), "mode_oneshot"],
] as const) {
  test(`${name} ends its parked live session when the configuration is reloaded`, { timeout: 20000 }, async () => {
    const gateway = await run(update);
    try {
      assert.ok(await gateway.ended(), "the CLI process is gone, its folder removed and the registry empty");
      const closed = (await gateway.h.sessions()).filter(entry => entry.outcome === "closed");
      assert.deepEqual(closed.map(entry => entry.missReason), [reason]);
    } finally { await gateway.close(); await gateway.h.restore(); }
  });
}

test("a reload that leaves a Copilot provider as it was keeps its live session", { timeout: 20000 }, async () => {
  const gateway = await run(h => config(h, [provider(), other]));
  try {
    await sleep(300);
    assert.equal(live().sessions().length, 1); assert.ok(alive(gateway.pid), "the session lives on");
    assert.deepEqual((await gateway.h.sessions()).filter(entry => entry.outcome === "closed"), []);
  } finally { await gateway.close(); await gateway.h.restore(); }
});
