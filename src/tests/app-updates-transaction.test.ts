import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import test from "node:test";
import { beginInstallationTransaction, finalizeCommittedInstallationTransaction, recoverInstallationTransaction, rollbackOwnedTransaction, runCanonicalInstall, swapAndCommitInstallationTransaction, type TransactionCommand } from "../app-updates/transaction.js";

const noop: TransactionCommand = async () => {};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "transaction-")), prefix = join(directory, "prefix");
  const root = join(prefix, "share", "subscription-gateway"), bin = join(prefix, "bin"), app = join(directory, "Harness Gateway.app"), stage = join(directory, ".update.app");
  await mkdir(join(root, "releases", "0.1.0"), { recursive: true }); await mkdir(bin, { recursive: true });
  await writeFile(join(root, "releases", "0.1.0", ".gateway-release"), "0.1.0\n"); await symlink("releases/0.1.0", join(root, "current"));
  for (const name of ["gateway", "harness-gateway", "subscription-gateway"]) await writeFile(join(bin, name), `#!/bin/sh\n# Managed by subscription-gateway installer\nold ${name}\n`, { mode: 0o700 });
  for (const [path, value] of [[app, "old"], [stage, "new"]] as const) {
    await mkdir(join(path, "Contents", "MacOS"), { recursive: true }); await writeFile(join(path, "Contents", "Info.plist"), value);
    await writeFile(join(path, "Contents", "MacOS", "GatewayUpdateInstaller"), "fixture", { mode: 0o700 });
  }
  const tx = () => beginInstallationTransaction({ installation: { root, prefix }, app, version: "0.2.0", team: "ABCDE12345" });
  const receipt = async (key: string, path: string) => {
    const journal = JSON.parse(await readFile(join(root, "app-update-transaction.json"), "utf8"));
    const info = await lstat(path); const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path);
    journal.installer ??= { outputs: {} }; journal.installer.outputs[key] = { dev: info.dev, ino: info.ino, mode: info.mode & 0o777, size: info.size, digest: createHash("sha256").update(bytes).digest("hex") };
    await writeFile(join(root, "app-update-transaction.json"), JSON.stringify(journal), { mode: 0o600 });
  };
  const install = async (partial = false) => {
    await mkdir(join(root, "releases", "0.2.0"), { recursive: true }); await writeFile(join(root, "releases", "0.2.0", ".gateway-release"), "0.2.0\n");
    const current = join(root, "current"); await unlink(current); await symlink("releases/0.2.0", current); await receipt("current", current);
    const gateway = join(bin, "gateway"); await writeFile(gateway, "# Managed by subscription-gateway installer\nnew gateway\n", { mode: 0o700 }); await receipt("gateway", gateway);
    if (partial) throw new Error("partial");
    await writeFile(join(bin, "harness-gateway"), "# Managed by subscription-gateway installer\nnew harness\n", { mode: 0o700 }); await receipt("harness-gateway", join(bin, "harness-gateway"));
  };
  const swap: TransactionCommand = async (helper, args) => {
    assert.equal(helper, join(stage, "Contents", "MacOS", "GatewayUpdateInstaller")); assert.deepEqual(args, [app, stage]);
    const temporary = join(directory, ".old.app"); await rename(app, temporary); await rename(stage, app); await rename(temporary, stage);
  };
  return { directory, root, prefix, app, stage, tx, install, swap, receipt };
}
async function bundleReceipt(path: string) {
  const bundle = await lstat(path), bytes = await readFile(join(path, "Contents", "Info.plist"));
  return { dev: bundle.dev, ino: bundle.ino, mode: bundle.mode & 0o777, size: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
}
test("partial canonical publication restores current and wrappers", async () => {
  const f = await fixture(); try {
    await assert.rejects(runCanonicalInstall(await f.tx(), { installer: async () => f.install(true), command: noop }), /partial/);
    assert.equal(await readFile(join(f.prefix, "bin", "gateway"), "utf8"), "#!/bin/sh\n# Managed by subscription-gateway installer\nold gateway\n");
    assert.equal(await readlink(join(f.root, "current")), "releases/0.1.0");
    await assert.rejects(readFile(join(f.root, "app-update-transaction.json")), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("a transaction cannot downgrade a release selected by a concurrent canonical installer", async () => {
  const f = await fixture(); try {
    await mkdir(join(f.root, "releases", "0.3.0")); await writeFile(join(f.root, "releases", "0.3.0", ".gateway-release"), "0.3.0\n");
    await unlink(join(f.root, "current")); await symlink("releases/0.3.0", join(f.root, "current"));
    await assert.rejects(f.tx(), /newer gateway release/);
    assert.equal(await readlink(join(f.root, "current")), "releases/0.3.0");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("an already aborted install and a zero-receipt installing journal recover without wedging", async () => {
  const f = await fixture(); try {
    const tx = await f.tx(), controller = new AbortController(); controller.abort(new Error("cancelled"));
    await assert.rejects(runCanonicalInstall(tx, { installer: async () => f.install(), command: noop, signal: controller.signal }), /cancelled/);
    await assert.rejects(readFile(join(f.root, "app-update-transaction.json")), { code: "ENOENT" });
    const retry = await f.tx(), path = join(f.root, "app-update-transaction.json"), journal = JSON.parse(await readFile(path, "utf8"));
    journal.phase = "installing"; await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
    assert.equal(await recoverInstallationTransaction({ installation: retry.installation, app: retry.app, team: retry.team, command: noop }), "rolled_back");
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("CLI and app commit together after the verified atomic swap", async () => {
  const f = await fixture(); try {
    const tx = await f.tx(); await runCanonicalInstall(tx, { installer: async () => f.install(), command: noop });
    await swapAndCommitInstallationTransaction(tx, { helper: join(f.stage, "Contents", "MacOS", "GatewayUpdateInstaller"), stage: f.stage, command: f.swap, verifyTarget: async () => {} });
    assert.equal(await readFile(join(f.app, "Contents", "Info.plist"), "utf8"), "new");
    assert.equal(await readFile(join(f.prefix, "bin", "gateway"), "utf8"), "# Managed by subscription-gateway installer\nnew gateway\n");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("post-swap recovery commits once and retains its journal until pending-state acknowledgement", async () => {
  const f = await fixture(); try {
    const tx = await f.tx(); await runCanonicalInstall(tx, { installer: async () => f.install(), command: noop });
    await f.swap(join(f.stage, "Contents", "MacOS", "GatewayUpdateInstaller"), [f.app, f.stage]);
    const path = join(f.root, "app-update-transaction.json"), journal = JSON.parse(await readFile(path, "utf8"));
    journal.phase = "swapping"; journal.swap = { stage: f.stage, incoming: await bundleReceipt(f.app) };
    await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
    const pending = { version: tx.version, appStage: f.stage };
    assert.equal(await recoverInstallationTransaction({ installation: tx.installation, app: tx.app, team: tx.team, pending, command: noop, verifyIncoming: async app => assert.equal(app, f.app) }), "committed");
    assert.equal(await readFile(join(f.app, "Contents", "Info.plist"), "utf8"), "new");
    assert.equal(await readFile(join(f.stage, "Contents", "Info.plist"), "utf8"), "old");
    assert.equal(JSON.parse(await readFile(path, "utf8")).phase, "committed");
    assert.equal(await recoverInstallationTransaction({ installation: tx.installation, app: tx.app, team: tx.team, pending, command: noop }), "committed");
    await finalizeCommittedInstallationTransaction(tx);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("installing recovery consumes write-ahead receipts and restores only owned outputs", async () => {
  const f = await fixture(); try {
    const previous = join(f.root, "previous-release"); await writeFile(previous, "releases/0.0.9\n", { mode: 0o600 });
    const tx = await f.tx();
    await assert.rejects(f.install(true), /partial/);
    const stagedPrevious = previous + ".new"; await writeFile(stagedPrevious, "releases/0.1.0\n", { mode: 0o600 }); await rename(stagedPrevious, previous); await f.receipt("previous", previous);
    const path = join(f.root, "app-update-transaction.json"), journal = JSON.parse(await readFile(path, "utf8"));
    journal.phase = "installing"; await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
    const concurrent = join(f.prefix, "bin", "unowned-concurrent"); await writeFile(concurrent, "preserve\n", { mode: 0o700 });
    assert.equal(await recoverInstallationTransaction({ installation: tx.installation, app: tx.app, team: tx.team, command: noop }), "rolled_back");
    assert.equal(await readlink(join(f.root, "current")), "releases/0.1.0");
    assert.equal(await readFile(previous, "utf8"), "releases/0.0.9\n");
    assert.equal(await readFile(join(f.prefix, "bin", "gateway"), "utf8"), "#!/bin/sh\n# Managed by subscription-gateway installer\nold gateway\n");
    assert.equal(await readFile(concurrent, "utf8"), "preserve\n");
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("concurrent output replacement fails closed and retains its journal", async () => {
  const f = await fixture(); try {
    const tx = await f.tx(); await runCanonicalInstall(tx, { installer: async () => f.install(), command: noop });
    await writeFile(join(f.prefix, "bin", "gateway"), "concurrent\n", { mode: 0o700 });
    await assert.rejects(rollbackOwnedTransaction(tx), /changed/);
    assert.equal(await readFile(join(f.prefix, "bin", "gateway"), "utf8"), "concurrent\n");
    assert.ok(await readFile(join(f.root, "app-update-transaction.json")));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("a replaced retained app is never swapped over the verified candidate during rollback", async () => {
  const f = await fixture(); try {
    const tx = await f.tx(); await runCanonicalInstall(tx, { installer: async () => f.install(), command: noop });
    const swapThenReplace: TransactionCommand = async (_helper, _args) => {
      await f.swap(join(f.stage, "Contents", "MacOS", "GatewayUpdateInstaller"), [f.app, f.stage]);
      await rm(f.stage, { recursive: true, force: true }); await mkdir(join(f.stage, "Contents", "MacOS"), { recursive: true });
      await writeFile(join(f.stage, "Contents", "Info.plist"), "intruder");
      throw new Error("helper reported failure after swapping");
    };
    await assert.rejects(swapAndCommitInstallationTransaction(tx, { helper: join(f.stage, "Contents", "MacOS", "GatewayUpdateInstaller"), stage: f.stage,
      command: swapThenReplace, verifyTarget: async () => {} }), /helper reported failure/);
    assert.equal(await readFile(join(f.app, "Contents", "Info.plist"), "utf8"), "new");
    assert.ok(await readFile(join(f.root, "app-update-transaction.json")));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("recovery recognizes an already restored wrapper by desired bytes and leaves its new inode intact", async () => {
  const f = await fixture(); try {
    const tx = await f.tx(); await runCanonicalInstall(tx, { installer: async () => f.install(), command: noop });
    const gateway = join(f.prefix, "bin", "gateway"), restored = gateway + ".restored";
    await writeFile(restored, "#!/bin/sh\n# Managed by subscription-gateway installer\nold gateway\n", { mode: 0o700 }); await rename(restored, gateway);
    const inode = (await lstat(gateway)).ino;
    assert.equal(await recoverInstallationTransaction({ installation: tx.installation, app: tx.app, team: tx.team, command: noop }), "rolled_back");
    assert.equal((await lstat(gateway)).ino, inode);
    assert.equal(await readlink(join(f.root, "current")), "releases/0.1.0");
    assert.equal(await readFile(join(f.prefix, "bin", "harness-gateway"), "utf8"), "#!/bin/sh\n# Managed by subscription-gateway installer\nold harness-gateway\n");
    await assert.rejects(readFile(join(f.root, "app-update-transaction.json")), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test("malformed journals and a second cleanup fail closed or are idempotent", async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root, "app-update-transaction.json"), "{\"schema\":1}", { mode: 0o600 });
    await assert.rejects(recoverInstallationTransaction({ installation: { root: f.root, prefix: f.prefix }, app: f.app, team: "ABCDE12345", command: noop }), /unsafe/);
    await unlink(join(f.root, "app-update-transaction.json"));
    const tx = await f.tx(); await runCanonicalInstall(tx, { installer: async () => f.install(), command: noop }); await rollbackOwnedTransaction(tx); await rollbackOwnedTransaction(tx);
    assert.equal(await readFile(join(f.prefix, "bin", "gateway"), "utf8"), "#!/bin/sh\n# Managed by subscription-gateway installer\nold gateway\n");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
