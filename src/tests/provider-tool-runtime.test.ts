import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { providerCommand, providerToolContract, providerToolTree } from "../provider-tool-runtime.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "provider-tool-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installs = join(root, "installs"); await mkdir(installs, { mode: 0o700 });
  const stage = join(installs, "stage"); const modules = join(stage, "node_modules");
  await mkdir(modules, { recursive: true, mode: 0o700 });
  await writeFile(join(modules, "cli"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(modules, "dependency.js"), "export const value = 1;\n", { mode: 0o600 });
  await mkdir(join(modules, ".bin"), { mode: 0o700 }); await symlink("../cli", join(modules, ".bin/claude"));
  const treeSha256 = await providerToolTree(modules);
  const installation = `claude-2.1.3-${treeSha256}`; await rename(stage, join(installs, installation));
  const executable = join(installs, installation, "node_modules/cli");
  const entry = { version: "2.1.3", installation, executable: "node_modules/cli", treeSha256 };
  const manifest = { schemaVersion: 1, contract: providerToolContract, providers: { claude: entry } };
  const save = () => writeFile(join(root, "current.json"), JSON.stringify(manifest), { mode: 0o600 });
  await save(); return { root, executable, manifest, save, installation: join(installs, installation) };
}

test("unmanaged installations keep PATH selection", async t => {
  const f = await fixture(t); await rm(join(f.root, "current.json"));
  assert.equal(await providerCommand("claude", f.root), "claude");
  assert.equal(await providerCommand("copilot", f.root), "copilot");
});
test("verified private dependency tree selects the immutable executable", async t => {
  const f = await fixture(t);
  assert.equal(await providerCommand("claude", f.root), f.executable);
  assert.equal(await providerCommand("claude", f.root), f.executable);
  assert.equal(await providerCommand("copilot", f.root), "copilot");
});
test("changed dependencies invalidate a cached verification even when the entrypoint stays unchanged", async t => {
  const f = await fixture(t); await providerCommand("claude", f.root);
  await writeFile(join(f.installation, "node_modules/dependency.js"), "export const value = 2;\n");
  await assert.rejects(providerCommand("claude", f.root), /unavailable or changed/);
});
test("malformed, foreign-contract or writable manifests fail closed", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "current.json"), "{"); await assert.rejects(providerCommand("claude", f.root), /unavailable or changed/);
  await f.save(); await chmod(join(f.root, "current.json"), 0o644);
  await assert.rejects(providerCommand("claude", f.root), /unavailable or changed/);
  await chmod(join(f.root, "current.json"), 0o600);
  f.manifest.contract = "future-contract"; await f.save();
  await assert.rejects(providerCommand("claude", f.root), /unavailable or changed/);
});
test("escaping paths and symlinked entries never select an unverified executable", async t => {
  const f = await fixture(t); f.manifest.providers.claude.executable = "../outside"; await f.save();
  await assert.rejects(providerCommand("claude", f.root), /unavailable or changed/);
  f.manifest.providers.claude.executable = "node_modules/cli"; await f.save();
  const bytes = await readFile(f.executable); await rm(f.executable); await writeFile(join(f.root, "outside"), bytes, { mode: 0o700 });
  await symlink(join(f.root, "outside"), f.executable);
  await assert.rejects(providerCommand("claude", f.root), /unavailable or changed/);
});
test("atomic selection changes do not remove the previous installation", async t => {
  const f = await fixture(t); const before = await providerCommand("claude", f.root);
  const manifest = { ...f.manifest, providers: {} };
  await writeFile(join(f.root, "next.json"), JSON.stringify(manifest), { mode: 0o600 });
  await rename(join(f.root, "next.json"), join(f.root, "current.json"));
  assert.equal(await providerCommand("claude", f.root), "claude");
  assert.equal((await readFile(before, "utf8")).includes("exit 0"), true);
});
