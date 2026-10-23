import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayToken, type GatewayConfig, type ProviderConfig } from "../config.js";
import { startGateway } from "../server.js";
import type { Provider } from "../providers/provider.js";

const sol = "gpt-6.1-sol", terra = "gpt-5.6-terra";
const account = (id: string, selected = false): ProviderConfig => ({ id, type: "codex-subscription", credentialFile: "unused",
  defaultForBareModels: selected, models: { [id + "/" + sol]: sol, [id + "/" + terra]: terra } });

async function fixture(t: TestContext, providers: ProviderConfig[], blockFirst = false) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-subagent-accounts-"));
  let current: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, providers };
  const seen: Array<{ account: string; model: string }> = [];
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const factory = (provider: ProviderConfig): Provider => ({ async *infer(request) {
    seen.push({ account: provider.id, model: request.model });
    if (blockFirst && seen.length === 1) { started(); await held; }
    yield { type: "text", text: "ok" };
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } });
  const server = await startGateway(current, factory, async () => current);
  t.after(async () => {
    release(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const port = (server.address() as { port: number }).port;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const post = async (model: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers,
      body: JSON.stringify({ model, input: "fixture" }) });
    await response.json(); return response.status;
  };
  return { seen, post, release, firstStarted, reload: (providers: ProviderConfig[]) => { current = { ...current, providers }; } };
}

test("a bare role model uses the designated account while explicit account aliases retain their account", async t => {
  const f = await fixture(t, [account("personal"), account("work", true)]);
  assert.equal(await f.post(terra), 200);
  assert.equal(await f.post("personal/" + terra), 200);
  assert.deepEqual(f.seen, [{ account: "work", model: terra }, { account: "personal", model: terra }]);
});

test("a designated account that lacks a role model does not borrow that model from another account", async t => {
  const selected = { ...account("work", true), models: { ["work/" + sol]: sol } };
  const f = await fixture(t, [account("personal"), selected]);
  assert.equal(await f.post(terra), 404);
  assert.deepEqual(f.seen, []);
  assert.equal(await f.post("personal/" + terra), 200);
  assert.deepEqual(f.seen, [{ account: "personal", model: terra }]);
});

test("two accounts without a designated default stay ambiguous and never invoke an adapter", async t => {
  const f = await fixture(t, [account("personal"), account("work")]);
  assert.equal(await f.post(terra), 404); assert.deepEqual(f.seen, []);
});

test("changing the designated account affects later requests and preserves an admitted request's account", { timeout: 10000 }, async t => {
  const f = await fixture(t, [account("personal"), account("work", true)], true);
  const first = f.post(terra);
  await f.firstStarted;
  f.reload([account("work"), account("personal", true)]);
  assert.equal(await f.post(terra), 200);
  f.release(); assert.equal(await first, 200);
  assert.deepEqual(f.seen, [{ account: "work", model: terra }, { account: "personal", model: terra }]);
});
