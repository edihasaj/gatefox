import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { toolSearchCommand } from "../tool-search-command.js";

const codex = { id: "codex", type: "codex-subscription", credentialFile: "codex.json", models: { "codex/sol": "gpt-6.1-sol" }, label: "Codex 2" };
const claude = { id: "claude", type: "claude-subscription", models: { "claude/x": "x" } };
async function fixture(providers: unknown[], extra: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-tool-search-command-"));
  const path = join(directory, "gateway.json");
  await writeFile(path, JSON.stringify({ version: 1, port: 1, stateDirectory: directory, chatIdentity: "openai", providers, ...extra }), { mode: 0o600 });
  return { directory, path };
}
const offline = async () => ({ reachable: false });

test("tool-search turns the bridge on and off for every Codex provider and leaves the rest of gateway.json alone", async () => {
  const { directory, path } = await fixture([codex, { ...codex, id: "codex2", models: { "codex2/sol": "gpt-6.1-sol" } }, claude]);
  try {
    assert.deepEqual(await toolSearchCommand("status", path, await loadConfig(path), offline), { providers: [{ id: "codex", toolSearch: "off" }, { id: "codex2", toolSearch: "off" }], changed: false });
    const on = await toolSearchCommand("on", path, await loadConfig(path), offline);
    assert.deepEqual(on, { providers: [{ id: "codex", toolSearch: "bridge" }, { id: "codex2", toolSearch: "bridge" }], changed: true, daemon: { reachable: false } });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.chatIdentity, "openai"); assert.equal(saved.providers[0].label, "Codex 2"); assert.equal(Object.hasOwn(saved.providers[2], "toolSearch"), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600, "the file stays owner-only");
    assert.equal((await toolSearchCommand("on", path, await loadConfig(path), offline)).changed, false, "already on");
    const off = await toolSearchCommand("off", path, await loadConfig(path), async () => ({ reachable: true }));
    assert.deepEqual(off.providers.map(provider => provider.toolSearch), ["off", "off"]);
    assert.deepEqual(off.daemon, { reachable: true });
    assert.equal(Object.hasOwn(JSON.parse(await readFile(path, "utf8")).providers[0], "toolSearch"), false, "off is the default, so the field is removed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("tool-search refuses a gateway without a Codex provider and a client-only gateway", async () => {
  const none = await fixture([claude]);
  const client = await fixture([], { clientOnly: true });
  try {
    await assert.rejects(toolSearchCommand("on", none.path, await loadConfig(none.path), offline), /No codex-subscription provider/);
    await assert.rejects(toolSearchCommand("status", client.path, await loadConfig(client.path), offline), /client of another/);
  } finally { await rm(none.directory, { recursive: true, force: true }); await rm(client.directory, { recursive: true, force: true }); }
});
