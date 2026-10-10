import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { claudeEffort } from "../providers/claude.js";
import { nativeClaudeModels, readClaudeModels } from "../providers/claude-models.js";
import { loadDiscoveredModels, modelCatalog } from "../catalog.js";
import type { ProviderConfig } from "../config.js";

const native = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"] },
  { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Duplicate" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
];

test("Claude catalog resolves aliases, removes duplicate defaults, and retains native reasoning capabilities", () => {
  const models = nativeClaudeModels(native);
  assert.deepEqual(models.map(m => m.model), ["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
  assert.equal(models[0].metadata.contextWindow, 1000000);
  assert.deepEqual(models[0].metadata.reasoningEfforts, ["low", "medium", "high", "max"]);
  assert.deepEqual(models[1].metadata.reasoningEfforts, []);
  assert.throws(() => nativeClaudeModels([{ value: "opus", displayName: "Opus", supportedEffortLevels: ["unsupported"] }]), /reasoning/);
});

test("refresh retains existing account aliases and metadata while replacing the offered model set", () => {
  const provider: ProviderConfig = { id: "claude", type: "claude-subscription", models: { saved: "claude-opus-5-5", retired: "old" }, modelMetadata: { saved: { contextWindow: 200000 } } };
  loadDiscoveredModels(provider, nativeClaudeModels(native));
  assert.deepEqual(provider.models, { saved: "claude-opus-5-5", "claude/claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001" });
  assert.equal(provider.modelMetadata?.saved.contextWindow, 1000000);
  assert.equal(provider.modelMetadata?.saved.displayName, "Opus 5.5");
});

test("account groups stay in configuration order despite conflicting upstream priorities", () => {
  const catalog = modelCatalog({ version: 1, port: 0, stateDirectory: ".", providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { older: "a", newer: "b" }, modelMetadata: { older: { priority: 90000 }, newer: { priority: 2 } } },
    { id: "codex", type: "codex-subscription", label: "Codex 2", models: { secondary: "b" }, modelMetadata: { secondary: { priority: -90000 } } },
  ] });
  assert.deepEqual(catalog.models.map(m => m.slug), ["newer", "older", "secondary"]);
  assert.deepEqual(catalog.models.map(m => m.display_name), ["Claude · b", "Claude · a", "Codex 2 · b"]);
});

function worker(mode: string) {
  return spawn(process.execPath, ["--input-type=module", "-e", `
    import {createInterface} from 'node:readline';
    ${mode === "hang" ? "process.on('SIGTERM',()=>{});" : ""}
    for await(const line of createInterface({input:process.stdin})){
      const m=JSON.parse(line);
      if(m.type!=='control_request'||m.request.subtype!=='initialize')process.exit(8);
      if(${JSON.stringify(mode)}==='eof'){process.stderr.write('private diagnostic');process.exit(2);}
      if(${JSON.stringify(mode)}==='hang')continue;
      if(${JSON.stringify(mode)}==='oversize'){process.stdout.write('x'.repeat(1024*1024+1));continue;}
      if(${JSON.stringify(mode)}==='invalid'){console.log('private-diagnostic-invalid-json');continue;}
      console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:${JSON.stringify(native)}}}}));
    }
  `], { stdio: ["pipe", "pipe", "pipe"] });
}

test("native discovery sends only metadata initialization and cleans up its worker", async () => {
  const child = worker("ok");
  const models = await readClaudeModels(child);
  assert.equal(models.length, 2);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("discovery rejects premature exit without exposing diagnostics and kills stalled workers", async () => {
  await assert.rejects(readClaudeModels(worker("eof")), /ended without a catalog/);
  const child = worker("hang");
  await assert.rejects(readClaudeModels(child, 150), /timed out/);
  assert.equal(child.signalCode, "SIGKILL");
});


test("discovery bounds unterminated output and keeps malformed metadata out of errors", async () => {
  const oversized = worker("oversize");
  await assert.rejects(readClaudeModels(oversized), /exceeds 1 MiB/);
  assert.ok(oversized.exitCode !== null || oversized.signalCode !== null);
  await assert.rejects(readClaudeModels(worker("invalid")), error => {
    assert.equal((error as Error).message, "Claude model discovery returned invalid JSON");
    return true;
  });
});


test("a Claude model without effort controls accepts none without passing an unsupported CLI flag", () => {
  const provider: ProviderConfig = { id: "claude", type: "claude-subscription", models: { haiku: "haiku", sonnet: "sonnet" }, modelMetadata: { haiku: { reasoningEfforts: [] }, sonnet: { reasoningEfforts: ["low", "high"] } } };
  assert.equal(claudeEffort(provider, { model: "haiku", input: "hello", reasoning: { effort: "none" } }), undefined);
  assert.throws(() => claudeEffort(provider, { model: "haiku", input: "hello", reasoning: { effort: "high" } }), /does not support/);
  assert.equal(claudeEffort(provider, { model: "sonnet", input: "hello", reasoning: { effort: "high" } }), "high");
  assert.throws(() => claudeEffort(provider, { model: "sonnet", input: "hello", reasoning: { effort: "none" } }), /does not support/);
});


test("discovery preserves multiple public aliases of a retained upstream model", () => {
  const provider: ProviderConfig = { id: "claude", type: "claude-subscription", models: { old: "claude-opus-5-5", current: "claude-opus-5-5" } };
  loadDiscoveredModels(provider, nativeClaudeModels(native));
  assert.equal(provider.models.old, "claude-opus-5-5");
  assert.equal(provider.models.current, "claude-opus-5-5");
});
