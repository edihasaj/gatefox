import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  beginInstallationTransaction, recoverInstallationTransaction, rollbackOwnedTransaction, runCanonicalInstall,
  swapAndCommitInstallationTransaction, type InstallationLocation, type TransactionCommand,
} from "../app-updates/transaction.js";

const silent: TransactionCommand = async () => {};

async function fixture(): Promise<{
  directory: string; installation: InstallationLocation; app: string; stage: string; transaction: () => Promise<Awaited<ReturnType<typeof beginInstallationTransaction>>>;
  install: (version?: string, partial?: boolean) => Promise<void>; swap: TransactionCommand; verify: (path: string) => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-transaction-")); const prefix = join(directory, "prefix");
  const root = join(prefix, "share", "subscription-gateway"); const bin = join(prefix, "bin");
  const app = join(directory, "Harness Gateway.app"); const stage = join(directory, ".Harness Gateway.next.app");
  await mkdir(join(root, "releases", "0.1.0"), { recursive: true }); await mkdir(bin, { recursive: true });
  await writeFile(join(root, "releases", "0.1.0", ".gateway-release"), "0.1.0\n");
  await symlink("releases/0.1.0", join(root, "current"));
  await writeFile(join(bin, "gateway"), "old gateway\n", { mode: 0o700 });
  await writeFile(join(bin, "harness-gateway"), "old harness\n", { mode: 0o700 });
  await writeFile(join(bin, "subscription-gateway"), "old subscription\n", { mode: 0o700 });
  const makeApp = async (path: string, version: string) => {
    await mkdir(join(path, "Contents", "MacOS"), { recursive: true });
    await writeFile(join(path, "Contents", "Info.plist"), `version=${version}\n`);
    await writeFile(join(path, "Contents", "MacOS", "GatewayUpdateInstaller"), "# fixture\n", { mode: 0o700 });
  };
  await makeApp(app, "old"); await makeApp(stage, "new");
  const installation = { root, prefix };
  return {
    directory, installation, app, stage,
    transaction: () => beginInstallationTransaction({ installation, app, version: "0.2.0", team: "ABCDE12345" }),
    install: async (version = "0.2.0", partial = false) => {
      await mkdir(join(root, "releases", version), { recursive: true });
      await writeFile(join(root, "releases", version, ".gateway-release"), `${version}\n`);
      await unlink(join(root, "current")); await symlink(`releases/${version}`, join(root, "current"));
      await writeFile(join(bin, "gateway"), `gateway ${version}\n`, { mode: 0o700 });
      if (partial) throw new Error("fixture installer stopped after one wrapper");
      await writeFile(join(bin, "harness-gateway"), `harness ${version}\n`, { mode: 0o700 });
      await writeFile(join(bin, "subscription-gateway"), `subscription ${version}\n`, { mode: 0o700 });
    },
    swap: async (program, args) => {
      assert.equal(program, join(stage, "Contents", "MacOS", "GatewayUpdateInstaller"));
      assert.deepEqual(args, [app, stage]);
      const temporary = join(directory, ".swap-tmp.app");
      await rename(app, temporary); await rename(stage, app); await rename(temporary, stage);
    },
    verify: async path => { assert.ok(path === app || path === stage); },
  };
}

test("a partial canonical install restores its current release and published wrapper", async () => {
  const f = await fixture();
  try {
    const tx = await f.transaction();
    await assert.rejects(runCanonicalInstall(tx, { installer: async () => f.install("0.2.0", true), command: silent }), /fixture installer/);
    assert.equal(await readFile(join(f.installation.root, "current"), "utf8").catch(() => ""), "");
    assert.equal(await readFile(join(f.installation.prefix, "bin", "gateway"), "utf8"), "old gateway\n");
    await assert.rejects(readFile(join(f.installation.root, "app-update-transaction.json")), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a completed transaction publishes the CLI and atomically swaps the app", async () => {
  const f = await fixture();
  try {
    const tx = await f.transaction();
    await runCanonicalInstall(tx, { installer: async () => f.install(), command: silent });
    await swapAndCommitInstallationTransaction(tx, { helper: join(f.stage, "Contents", "MacOS", "GatewayUpdateInstaller"), stage: f.stage,
      command: f.swap, verifyTarget: f.verify });
    assert.equal(await readFile(join(f.installation.prefix, "bin", "gateway"), "utf8"), "gateway 0.2.0\n");
    assert.equal(await readFile(join(f.app, "Contents", "Info.plist"), "utf8"), "version=new\n");
    assert.equal(await readFile(join(f.stage, "Contents", "Info.plist"), "utf8"), "version=old\n");
    await assert.rejects(readFile(join(f.installation.root, "app-update-transaction.json")), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("rollback leaves a concurrent newer release and wrapper untouched", async () => {
  const f = await fixture();
  try {
    const tx = await f.transaction();
    await runCanonicalInstall(tx, { installer: async () => f.install(), command: silent });
    await mkdir(join(f.installation.root, "releases", "0.3.0"), { recursive: true });
    await writeFile(join(f.installation.root, "releases", "0.3.0", ".gateway-release"), "0.3.0\n");
    await unlink(join(f.installation.root, "current")); await symlink("releases/0.3.0", join(f.installation.root, "current"));
    await writeFile(join(f.installation.prefix, "bin", "gateway"), "concurrent\n", { mode: 0o700 });
    await assert.rejects(rollbackOwnedTransaction(tx), /changed/);
    assert.equal(await readFile(join(f.installation.prefix, "bin", "gateway"), "utf8"), "concurrent\n");
    await assert.rejects(readFile(join(f.installation.root, "app-update-transaction.json")), { code: "ENOENT" }).catch(() => undefined);
    assert.ok(await readFile(join(f.installation.root, "app-update-transaction.json")));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a malformed journal fails closed and is retained", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.installation.root, "app-update-transaction.json"), "{\"schema\":1,\"root\":\"/bad\"}", { mode: 0o600 });
    await assert.rejects(recoverInstallationTransaction({ installation: f.installation, app: f.app, version: "0.2.0", team: "ABCDE12345", command: silent }), /unsafe/);
    assert.equal(await readFile(join(f.installation.root, "app-update-transaction.json"), "utf8"), "{\"schema\":1,\"root\":\"/bad\"}");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("repeated rollback after cleanup does not touch the restored installation", async () => {
  const f = await fixture();
  try {
    const tx = await f.transaction();
    await runCanonicalInstall(tx, { installer: async () => f.install(), command: silent });
    await rollbackOwnedTransaction(tx);
    await rollbackOwnedTransaction(tx);
    assert.equal(await readFile(join(f.installation.prefix, "bin", "gateway"), "utf8"), "old gateway\n");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
