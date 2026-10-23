import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { nativeModelAlias, startGateway } from "../server.js";
import type { Provider } from "../providers/provider.js";

const config = (stateDirectory = "/unused"): GatewayConfig => ({ version: 1, port: 0, stateDirectory, providers: [
  { id: "codex", type: "codex-subscription", credentialFile: "unused", models: { "codex/gpt-6.1-sol": "gpt-6.1-sol", "codex/gpt-5.6-terra": "gpt-5.6-terra" } },
  { id: "copilot", type: "copilot-subscription", models: { "copilot/gpt-6.1-sol": "gpt-6.1-sol" } },
  { id: "claude", type: "claude-subscription", models: { "claude/claude-opus-5-5": "claude-opus-5-5" } },
] });

test("bare vendor model names resolve to their own subscription route only when unambiguous", () => {
  assert.equal(nativeModelAlias(config(), "gpt-6.1-sol"), "codex/gpt-6.1-sol", "OpenAI names use the Codex subscription, not Copilot");
  assert.equal(nativeModelAlias(config(), "gpt-5.6-terra"), "codex/gpt-5.6-terra");
  assert.equal(nativeModelAlias(config(), "claude-opus-5-5"), "claude/claude-opus-5-5");
  assert.equal(nativeModelAlias(config(), "gpt-9"), undefined);
  assert.equal(nativeModelAlias(config(), "qwen3"), undefined);
  const twice = config(); twice.providers.push({ id: "codex2", type: "codex-subscription", credentialFile: "unused", models: { "codex2/gpt-6.1-sol": "gpt-6.1-sol" } });
  assert.equal(nativeModelAlias(twice, "gpt-6.1-sol"), undefined, "two subscription accounts make the name ambiguous");
});

test("a sub-agent request with a bare model name is served instead of failing with 404", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-native-alias-"));
  const seen: string[] = [];
  const provider: Provider = { async *infer(request) { seen.push(request.model); yield { type: "text", text: "ok" }; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; } };
  const server = await startGateway(config(directory), () => provider);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`;
    const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
    const ok = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.6-terra", input: "hi" }) });
    assert.equal(ok.status, 200); assert.deepEqual(seen, ["gpt-5.6-terra"]);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-9", input: "hi" }) })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test("a designated account wins independent of provider order and duplicate aliases within that account", () => {
  const original = config(); original.providers[0].defaultForBareModels = true;
  original.providers[0].models["aaa/sol"] = "gpt-6.1-sol";
  original.providers.push({ id: "personal", type: "codex-subscription", credentialFile: "other", models: { "personal/sol": "gpt-6.1-sol" } });
  assert.equal(nativeModelAlias(original, "gpt-6.1-sol"), "aaa/sol");
  assert.equal(nativeModelAlias({ ...original, providers: [...original.providers].reverse() }, "gpt-6.1-sol"), "aaa/sol");
  delete original.providers[0].defaultForBareModels;
  assert.equal(nativeModelAlias(original, "gpt-6.1-sol"), undefined);
  original.providers.pop();
  assert.equal(nativeModelAlias(original, "gpt-6.1-sol"), "aaa/sol", "two aliases in one account are not two accounts");
});

test("Claude and Codex defaults are independent and a missing model never falls back across accounts", () => {
  const value = config(); value.providers[0].defaultForBareModels = true;
  value.providers.push({ id: "claude2", type: "claude-subscription", defaultForBareModels: true,
    models: { "claude2/opus": "claude-opus-5-5" } });
  assert.equal(nativeModelAlias(value, "claude-opus-5-5"), "claude2/opus");
  assert.equal(nativeModelAlias(value, "gpt-6.1-sol"), "codex/gpt-6.1-sol");
  value.providers[0].models = { "codex/terra": "gpt-5.6-terra" };
  value.providers.push({ id: "personal", type: "codex-subscription", credentialFile: "other", models: { "personal/sol": "gpt-6.1-sol" } });
  assert.equal(nativeModelAlias(value, "gpt-6.1-sol"), undefined);
});
