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
