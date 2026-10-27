import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signedGatewayRuntime } from "../gateway-signed-runtime.js";
import type { GatewaySdkRuntime } from "../gateway-sdk-runtime.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gateway-signed-runtime-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "Harness Gateway.app");
  const backend = join(app, "Contents/Resources/backend");
  const runtime = join(backend, "runtime"); const directory = join(backend, "package/gateway-sdk");
  await mkdir(runtime, { recursive: true }); await mkdir(directory, { recursive: true });
  await symlink(runtime, join(root, "app-runtime"));
  const original: GatewaySdkRuntime = { executable: join(root, "original/gateway-codex"), binarySha256: "a".repeat(64),
    selectedModelCompaction: true, executorIdentity: true, codeModeHost: false };
  const signed: GatewaySdkRuntime = { ...original, executable: join(directory, "gateway-codex"), binarySha256: "b".repeat(64) };
  const receipt = join(directory, "build.json");
  const save = (value: Record<string, unknown>) => writeFile(receipt, JSON.stringify(value));
  await save({ originalBinarySha256: original.binarySha256 });
  return { root, app, directory, original, signed, save };
}

test("a verified signed derivative keeps the original release identity", async t => {
  const f = await fixture(t); const calls: string[] = [];
  const selected = await signedGatewayRuntime(f.root, f.original, async path => {
    assert.equal(path, join(f.app, "Contents/Resources/backend/package")); calls.push("package"); return f.signed;
  }, async (app, binary) => { assert.equal(app, f.app); assert.equal(binary, f.signed.executable); calls.push("signature"); });
  assert.deepEqual(selected, { ...f.signed, binarySha256: f.original.binarySha256, executableSha256: f.signed.binarySha256, identityExecutable: f.original.executable });
  assert.deepEqual(calls, ["package", "signature", "package"]);
});

test("a different build, invalid signature, or changed candidate is never substituted", async t => {
  const f = await fixture(t);
  await f.save({ originalBinarySha256: "c".repeat(64) });
  assert.equal(await signedGatewayRuntime(f.root, f.original, async () => f.signed, async () => {}), undefined);
  await f.save({ originalBinarySha256: f.original.binarySha256 });
  assert.equal(await signedGatewayRuntime(f.root, f.original, async () => f.signed, async () => { throw Error("signature"); }), undefined);
  let calls = 0;
  assert.equal(await signedGatewayRuntime(f.root, f.original, async () => ++calls === 1 ? f.signed : { ...f.signed, binarySha256: "d".repeat(64) }, async () => {}), undefined);
  assert.equal(await signedGatewayRuntime(f.root, f.original, async () => f.signed, async () => { await f.save({ originalBinarySha256: "e".repeat(64) }); }), undefined);
});

test("a signed companion must originate from the same verified release", async t => {
  const f = await fixture(t); await mkdir(join(f.root, "original"));
  await writeFile(join(f.root, "original/build.json"), JSON.stringify({ codeModeHostSha256: "f".repeat(64) }));
  const original = { ...f.original, codeModeHost: true }; const signed = { ...f.signed, codeModeHost: true };
  await f.save({ originalBinarySha256: original.binarySha256, originalCodeModeHostSha256: "0".repeat(64) });
  assert.equal(await signedGatewayRuntime(f.root, original, async () => signed, async () => {}), undefined);
  await f.save({ originalBinarySha256: original.binarySha256, originalCodeModeHostSha256: "f".repeat(64) });
  assert.equal((await signedGatewayRuntime(f.root, original, async () => signed, async () => {}))?.executable, signed.executable);
  assert.equal(await signedGatewayRuntime(f.root, original, async () => signed, async () => {
    await f.save({ originalBinarySha256: original.binarySha256, originalCodeModeHostSha256: "f".repeat(64), codeModeHostSha256: "1".repeat(64) });
  }), undefined);
});
