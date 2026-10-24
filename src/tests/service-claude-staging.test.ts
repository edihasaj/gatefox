import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readdir, readFile, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pendingClaudeConsolidationPath, previewClaudeConsolidation, readPendingClaudeConsolidation, stageClaudeConsolidation, type ClaudeDependencies } from "../service-claude-staging.js";
import type { ServicePlan } from "../service-plan.js";
import { allLabels, labels, legacyObjects, readObject, rewrite, rewriteMain, snapshot, withFixture, writeLegacy, writePlan, type Fixture } from "./service-claude-staging-support.js";

const backups = async (f: Fixture): Promise<string[]> => (await readdir(join(f.state, "service-backups")).catch(() => [] as string[])).filter(name => name.startsWith("claude-"));

test("preview is read-only and staging writes only the private receipt", async () => {
  await withFixture(async f => {
    const before = await snapshot(f);
    const preview = await previewClaudeConsolidation(f.config, f.deps());
    assert.equal(preview.ready, true); assert.equal(preview.staged, false);
    assert.deepEqual(preview.retires, allLabels);
    assert.deepEqual(await snapshot(f), before); assert.equal(await readPendingClaudeConsolidation(f.state), undefined);
    assert.deepEqual(await backups(f), []); assert.deepEqual(f.world.mutating(), []);
    const staged = await stageClaudeConsolidation(f.config, f.deps());
    assert.equal(staged.staged, true);
    assert.deepEqual(await snapshot(f), before, "staging changes neither the plan nor any legacy plist");
    assert.deepEqual(f.world.mutating(), []); assert.equal(f.world.loaded.size, 4);
    const receipt = (await readPendingClaudeConsolidation(f.state))!;
    assert.equal(receipt.phase, "staged"); assert.deepEqual(receipt.jobs.map(job => job.label), allLabels);
    assert.equal(f.notices.at(-1)?.event, "claude_consolidation_staged");
    assert.equal((await stat(f.receiptPath)).mode & 0o777, 0o600);
    assert.equal(pendingClaudeConsolidationPath(f.state), f.receiptPath);
    const adapter = receipt.candidatePlan.components.find(component => component.id === "claude-adapter")!;
    assert.equal(adapter.kind, "claude-adapter"); assert.equal(adapter.command, f.appNode);
    assert.equal(adapter.environment?.PATH, `${join(f.appNode, "..")}:/usr/bin:/bin:/usr/sbin:/sbin`);
    assert.equal(adapter.workingDirectory, join(f.home, "Library", "Application Support", "Claude-3p", "desktop-adapter"));
    assert.equal(adapter.log, join(f.state, "services", "claude-adapter.log"));
    assert.equal(adapter.args[0], legacyObjects(f.home)[labels.adapter]!.ProgramArguments[1]);
    const tunnel = receipt.candidatePlan.components.find(component => component.id === "claude-inference-studio")!;
    assert.equal(tunnel.kind, "tunnel"); assert.equal(tunnel.command, "/usr/bin/ssh"); assert.ok(tunnel.args.includes("-R")); assert.equal(tunnel.workingDirectory, undefined);
    assert.equal(receipt.candidatePlan.components.length, 5);
    const [backup] = await backups(f); const files = await readdir(join(f.state, "service-backups", backup!));
    assert.equal(files.length, 5); assert.equal((await stat(join(f.state, "service-backups", backup!))).mode & 0o777, 0o700);
    for (const label of allLabels) assert.equal((await stat(legacyObjects(f.home)[label]!.StandardOutPath)).mode & 0o777, 0o644, "legacy logs are preserved untouched");
  });
});

test("restaging is idempotent for identical inputs and refreshes when a legacy job changed", async () => {
  await withFixture(async f => {
    await stageClaudeConsolidation(f.config, f.deps()); const first = await readPendingClaudeConsolidation(f.state);
    await stageClaudeConsolidation(f.config, f.deps());
    assert.equal((await readPendingClaudeConsolidation(f.state))?.backup, first?.backup); assert.equal((await backups(f)).length, 1);
    await rewrite(f, labels.inference, object => { object.ThrottleInterval = 20; });
    await stageClaudeConsolidation(f.config, f.deps());
    const second = await readPendingClaudeConsolidation(f.state);
    assert.notEqual(second?.backup, first?.backup);
    assert.notEqual(second?.jobs.find(job => job.label === labels.inference)?.plistSha256, first?.jobs.find(job => job.label === labels.inference)?.plistSha256);
  });
});

interface Refusal { name: string; mutate(f: Fixture): Promise<ClaudeDependencies | void> }
const argsOf = (object: Record<string, any>): string[] => object.ProgramArguments;
const refusals: Refusal[] = [
  { name: "unknown plist key", mutate: f => rewrite(f, labels.adapter, object => { object.Program = "/bin/sh"; }) },
  { name: "missing adapter marker", mutate: async f => { await writeLegacy(f, labels.adapter, await readObject(f.files[labels.adapter]!), false); } },
  { name: "unpinned script", mutate: f => rewrite(f, labels.adapter, object => { argsOf(object)[1] = "/tmp/cli.js"; }) },
  { name: "extra adapter argument", mutate: f => rewrite(f, labels.adapter, object => { argsOf(object).push("--evil"); }) },
  { name: "wrong working directory", mutate: f => rewrite(f, labels.inference, object => { object.WorkingDirectory = "/tmp"; }) },
  { name: "environment beyond PATH", mutate: f => rewrite(f, labels.inference, object => { object.EnvironmentVariables.NODE_OPTIONS = "--x"; }) },
  { name: "tunnel wrong port", mutate: f => rewrite(f, labels.tunnel, object => { object.ProgramArguments = argsOf(object).map(arg => arg.replace("127.0.0.1:3468:127.0.0.1:3468", "127.0.0.1:3468:127.0.0.1:3469")); }) },
  { name: "tunnel wrong direction", mutate: f => rewrite(f, labels.tunnel, object => { object.ProgramArguments = argsOf(object).map(arg => arg === "-L" ? "-R" : arg); }) },
  { name: "tunnel proxy command", mutate: f => rewrite(f, labels.tunnel, object => { argsOf(object).splice(argsOf(object).length - 1, 0, "-o", "ProxyCommand=evil"); }) },
  { name: "tunnel omitted bind", mutate: f => rewrite(f, labels.tunnel, object => { object.ProgramArguments = argsOf(object).map(arg => arg.startsWith("127.0.0.1:3468") ? "3468:127.0.0.1:3468" : arg); }) },
  { name: "tunnel without ControlMaster=no", mutate: f => rewrite(f, labels.studio, object => { const args = argsOf(object); args.splice(args.indexOf("ControlMaster=no") - 1, 2); }) },
  { name: "tunnel host injection", mutate: f => rewrite(f, labels.tunnel, object => { argsOf(object)[argsOf(object).length - 1] = "-oProxyCommand=x"; }) },
  { name: "group-writable plist", mutate: async f => { await chmod(f.files[labels.inference]!, 0o664); } },
  { name: "symlinked plist", mutate: async f => { await unlink(f.files[labels.studio]!); await writeFile(join(f.root, "target.plist"), "x"); await symlink(join(f.root, "target.plist"), f.files[labels.studio]!); } },
  { name: "missing pinned script", mutate: async f => { await unlink(legacyObjects(f.home)[labels.adapter]!.ProgramArguments[1]); } },
  { name: "symlinked pinned config", mutate: async f => { const path = join(legacyObjects(f.home)[labels.inference]!.WorkingDirectory, "gateway.json"); await unlink(path); await writeFile(join(f.root, "other.json"), "{}"); await symlink(join(f.root, "other.json"), path); } },
  { name: "failed signature", mutate: async () => ({ verifySignature: async () => false }) },
  { name: "main plist unassociated", mutate: f => rewriteMain(f, object => { delete object.AssociatedBundleIdentifiers; }) },
  { name: "main plist for another configuration", mutate: f => rewriteMain(f, object => { object.ProgramArguments[3] = "/elsewhere.json"; }) },
  { name: "pending login consolidation", mutate: async () => ({ pendingLogin: async () => ({ staged: true }) }) },
  { name: "pending native sharing", mutate: async () => ({ pendingNative: async () => ({ staged: true }) }) },
  { name: "disabled legacy job", mutate: async f => { f.world.disabled.add(labels.inference); } },
  { name: "loaded job without plist", mutate: async f => { await unlink(f.files[labels.studio]!); } },
  { name: "unsafe private log destination", mutate: async f => {
    await writeFile(join(f.state, "services-placeholder"), ""); const { mkdir } = await import("node:fs/promises");
    await mkdir(join(f.state, "services"), { mode: 0o700 }); await writeFile(join(f.state, "services", "claude-adapter.log"), "x"); await chmod(join(f.state, "services", "claude-adapter.log"), 0o644);
  } },
  { name: "existing Claude component in the plan", mutate: async f => {
    const plan: ServicePlan = { ...f.plan, components: [...f.plan.components, { id: "claude-adapter", kind: "claude-adapter", command: "/x", args: [], log: "/x.log" }] }; await writePlan(f, plan);
  } },
];

for (const item of refusals) {
  test(`staging refuses before writing anything: ${item.name}`, async () => {
    await withFixture(async f => {
      const extra = await item.mutate(f); const before = await snapshot(f);
      await assert.rejects(stageClaudeConsolidation(f.config, f.deps(extra ?? {})), /not staged/);
      assert.equal(await readPendingClaudeConsolidation(f.state), undefined);
      assert.deepEqual(await snapshot(f), before); assert.deepEqual(await backups(f), []); assert.deepEqual(f.world.mutating(), []);
      const preview = await previewClaudeConsolidation(f.config, f.deps(extra ?? {})); assert.equal(preview.ready, false);
    });
  });
}

test("only macOS is supported, and nothing to migrate or already consolidated is reported without staging", async () => {
  await withFixture(async f => {
    await assert.rejects(stageClaudeConsolidation(f.config, f.deps({ platform: "linux" })), /macOS/);
    assert.equal((await previewClaudeConsolidation(f.config, f.deps({ platform: "linux" }))).ready, false);
    for (const label of allLabels) { await unlink(f.files[label]!); f.world.loaded.delete(label); }
    assert.deepEqual(await stageClaudeConsolidation(f.config, f.deps()), { service: "com.edihasaj.subscription-gateway", staged: false, reason: "no_legacy_jobs" });
    await writePlan(f, { ...f.plan, components: [...f.plan.components, { id: "claude-adapter", kind: "claude-adapter", command: "/x", args: [], log: "/x.log" }] });
    assert.equal((await stageClaudeConsolidation(f.config, f.deps())).alreadyConsolidated, true);
    assert.equal((await previewClaudeConsolidation(f.config, f.deps())).reason, "already_consolidated");
  });
});

const tampers: Array<{ name: string; change(receipt: Record<string, any>): void }> = [
  { name: "plist hash", change: receipt => { receipt.jobs[0].plistSha256 = "0".repeat(64); } },
  { name: "candidate hash", change: receipt => { receipt.candidatePlanSha256 = "0".repeat(64); } },
  { name: "unknown key", change: receipt => { receipt.extra = true; } },
  { name: "foreign backup path", change: receipt => { receipt.backup = "/tmp/claude-0123456789abcdef"; } },
  { name: "foreign label", change: receipt => { receipt.jobs[0].label = "com.example.other"; } },
  { name: "phase", change: receipt => { receipt.phase = "done"; } },
];
for (const item of tampers) {
  test(`a tampered receipt is rejected: ${item.name}`, async () => {
    await withFixture(async f => {
      await stageClaudeConsolidation(f.config, f.deps());
      const receipt = JSON.parse(await readFile(f.receiptPath, "utf8")); item.change(receipt); await writeFile(f.receiptPath, JSON.stringify(receipt));
      await assert.rejects(readPendingClaudeConsolidation(f.state), /Invalid pending Claude consolidation/);
    });
  });
}

test("a shared or linked receipt is never read, and a retiring receipt blocks restaging", async () => {
  await withFixture(async f => {
    await stageClaudeConsolidation(f.config, f.deps());
    await chmod(f.receiptPath, 0o644); await assert.rejects(readPendingClaudeConsolidation(f.state), /private regular file/);
    await chmod(f.receiptPath, 0o600);
    const receipt = JSON.parse(await readFile(f.receiptPath, "utf8")); receipt.phase = "retiring";
    for (const job of receipt.jobs) job.loaded = false;
    await writeFile(f.receiptPath, JSON.stringify(receipt));
    await assert.rejects(stageClaudeConsolidation(f.config, f.deps()), /needs recovery/);
    await rename(f.receiptPath, join(f.root, "moved.json")); await symlink(join(f.root, "moved.json"), f.receiptPath);
    await assert.rejects(readPendingClaudeConsolidation(f.state), /safely open/);
  });
});
