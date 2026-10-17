import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ObservedContextWindows, refreshModelMetadata } from "../model-refresh.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { ClaudeSubscription } from "../providers/claude.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-refresh-"));
  const path = join(directory, "gateway.json");
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: directory, providers: [
    { id: "claude", type: "claude-subscription", models: { "claude/opus": "claude-opus-5-5", "claude/old": "claude-opus-4-6" }, modelMetadata: { "claude/opus": { displayName: "Opus", contextWindow: 32768 } } },
  ] };
  await writePrivateJson(path, config);
  return { directory, path };
}

test("refresh updates metadata of configured models only and prefers observed windows", async () => {
  const f = await fixture();
  try {
    const observed = new ObservedContextWindows(f.directory); observed.record("claude", "claude-opus-4-6", 1000000);
    // The window is on disk before the refresh reads it: a fixed 50 ms wait lost that race on a loaded machine.
    await observed.flush();
    const updated = await refreshModelMetadata(f.path, async () => [
      { model: "claude-opus-5-5", metadata: { displayName: "Opus 5.5", contextWindow: 1000000, reasoningEfforts: ["max", "ultra"], multiAgentVersion: "v2" } },
      { model: "claude-new-model", metadata: { displayName: "New" } },
    ]);
    assert.deepEqual(updated, ["claude"]);
    const saved = JSON.parse(await readFile(f.path, "utf8")) as GatewayConfig;
    assert.deepEqual(Object.keys(saved.providers[0].models), ["claude/opus", "claude/old"], "the model set never changes automatically");
    assert.equal(saved.providers[0].modelMetadata?.["claude/opus"].contextWindow, 1000000);
    assert.equal(saved.providers[0].modelMetadata?.["claude/opus"].multiAgentVersion, "v2");
    assert.equal(saved.providers[0].modelMetadata?.["claude/old"].contextWindow, 1000000, "a window the CLI reported in real use is adopted");
    const before = (await stat(f.path)).mtimeMs;
    assert.deepEqual(await refreshModelMetadata(f.path, async () => [{ model: "claude-opus-5-5", metadata: { displayName: "Opus 5.5", contextWindow: 1000000, reasoningEfforts: ["max", "ultra"], multiAgentVersion: "v2" } }]), []);
    assert.equal((await stat(f.path)).mtimeMs, before, "an unchanged catalog is not rewritten");
    assert.deepEqual(await refreshModelMetadata(f.path, async () => { throw new Error("offline"); }), [], "a discovery failure keeps the saved metadata");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("Claude reports the context window the CLI used, without the 1M variant suffix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-window-"));
  const script = `#!${process.execPath}\nfor await(const _ of process.stdin){}\nconsole.log(JSON.stringify({type:'result',is_error:false,subtype:'success',result:'ok',usage:{input_tokens:1,output_tokens:1},modelUsage:{'claude-opus-4-6[1m]':{contextWindow:1000000}}}));\n`;
  await writeFile(join(directory, "claude"), script); await chmod(join(directory, "claude"), 0o700);
  const previous = process.env.PATH; process.env.PATH = directory + delimiter + process.env.PATH;
  const seen: Array<[string, number]> = [];
  try {
    const adapter = new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "claude-opus-4-6" } }, undefined, (model, window) => { seen.push([model, window]); });
    for await (const _ of adapter.infer({ model: "claude-opus-4-6", input: "fixture" }, new AbortController().signal)) { /* drain */ }
    assert.deepEqual(seen, [["claude-opus-4-6", 1000000]]);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; await rm(directory, { recursive: true, force: true }); }
});
