import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localProvider, setupFromHost } from "../setup-from-host.js";

const remote = { home: "/Users/other", config: {
  version: 1, port: 9999, stateDirectory: "/Users/other/state", tailnetListener: true, availability: { spendwatch: "/Users/other/bin/spendwatch" },
  chatIdentity: "openai", nativeModelPicker: ["codex/gpt-6.1-sol"],
  providers: [
    { id: "claude-primary", type: "claude-subscription", label: "Claude", authDirectory: "/Users/other/.claude-primary", models: { "claude-sonnet-4-6": "claude-sonnet-4-6" } },
    { id: "codex-primary", type: "codex-subscription", label: "Codex", credentialFile: "/Users/other/state/credentials/codex-primary.json", models: { "codex/gpt-6.1-sol": "gpt-6.1-sol" } },
    { id: "openrouter", type: "responses-api", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", credentialFile: "/Users/other/keys/openrouter", models: { "or/x": "x" } },
  ] } };

test("providers are rewritten to this Mac's paths and never carry the other Mac's credentials", () => {
  assert.equal(localProvider(remote.config.providers[0]!, "/Users/other", "state", "/Users/me").provider.authDirectory, "/Users/me/.claude-primary");
  assert.equal(localProvider(remote.config.providers[1]!, "/Users/other", "state").provider.credentialFile, "state/credentials/codex-primary.json");
  assert.deepEqual(localProvider(remote.config.providers[2]!, "/Users/other", "state").needs, "key");
});

test("a new Mac gets the shared settings, keeps its own machine settings and is told what to sign in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gatefox-from-host-")); const destination = join(dir, "gateway.json");
  await writeFile(destination, JSON.stringify({ version: 1, port: 3457, stateDirectory: "state", providers: [{ id: "local-only", type: "responses-api", label: "L", baseUrl: "https://x.test/v1", apiKeyEnv: "LOCAL_KEY", models: { "l/x": "x" } }] }), { mode: 0o600 });
  const result = await setupFromHost("studio", destination, async host => { assert.equal(host, "studio"); return structuredClone(remote); });
  const written = JSON.parse(await readFile(destination, "utf8"));
  assert.equal(written.port, 3457); assert.equal(written.stateDirectory, "state");
  assert.equal(written.tailnetListener, undefined); assert.equal(written.availability, undefined);
  assert.equal(written.chatIdentity, "openai");
  assert.deepEqual(written.providers.map((provider: { id: string }) => provider.id), ["claude-primary", "codex-primary", "openrouter", "local-only"]);
  assert.equal(written.providers[2].credentialFile, "state/credentials/openrouter.token");
  assert.equal((await stat(destination)).mode & 0o077, 0);
  assert.equal(result.credentialsCopied, false);
  const next = result.next as string[];
  assert.ok(next.includes("gatefox login claude-primary --account-email EMAIL")); assert.ok(next.includes("gatefox login codex-primary --account-email EMAIL"));
  assert.ok(next.some(line => line.startsWith("Copy the openrouter API key"))); assert.equal(next.at(-1), "gatefox setup --local");
});

test("a client-only source or a host without accounts is refused before anything is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gatefox-from-host-")); const destination = join(dir, "gateway.json");
  await assert.rejects(setupFromHost("h", destination, async () => ({ home: "/h", config: { clientOnly: true, providers: [] } })), /another Mac's gateway/);
  await assert.rejects(setupFromHost("h", destination, async () => ({ home: "/h", config: { providers: [] } })), /no accounts/);
  await assert.rejects(readFile(destination), { code: "ENOENT" });
});
