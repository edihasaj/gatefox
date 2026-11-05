import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoizedRuntime } from "../gateway-runtime-memo.js";
import type { GatewaySdkRuntime } from "../gateway-sdk-runtime.js";

async function sdk(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "gw-runtime-memo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "gateway-codex");
  await writeFile(executable, "sdk", { mode: 0o700 }); await writeFile(join(directory, "build.json"), "{}", { mode: 0o600 });
  const runtime = { executable, binarySha256: "a".repeat(64), selectedModelCompaction: true, executorIdentity: true, codeModeHost: false } as GatewaySdkRuntime;
  let verified = 0;
  return { directory, executable, runtime, verified: () => verified, verify: async () => { verified++; await new Promise(resolve => setTimeout(resolve, 5)); return runtime; } };
}

test("a burst and later calls for one unchanged SDK verify it once", async t => {
  const f = await sdk(t); const resolve = memoizedRuntime(f.verify);
  const answers = await Promise.all(Array.from({ length: 40 }, () => resolve()));
  assert.ok(answers.every(answer => answer === f.runtime)); assert.equal(f.verified(), 1);
  await resolve(); assert.equal(f.verified(), 1);
});

test("any change to the SDK or its companions verifies again", async t => {
  const f = await sdk(t); const resolve = memoizedRuntime(f.verify);
  await resolve(); assert.equal(f.verified(), 1);
  await writeFile(f.executable, "SDK"); await resolve(); assert.equal(f.verified(), 2, "same length, new bytes");
  await writeFile(f.executable, "SDK"); await resolve(); assert.equal(f.verified(), 3, "rewritten with the same bytes");
  await chmod(f.executable, 0o722); await resolve(); assert.equal(f.verified(), 4, "mode");
  await writeFile(join(f.directory, "build.json"), "{ }"); await resolve(); assert.equal(f.verified(), 5, "receipt");
  await writeFile(join(f.directory, "codex-code-mode-host"), "host"); await resolve(); assert.equal(f.verified(), 6, "a companion that appeared");
  await resolve(); assert.equal(f.verified(), 6);
});

test("no answer, a failed verification and missing files are not kept", async t => {
  const f = await sdk(t); let answer: GatewaySdkRuntime | undefined; let fail = false; let calls = 0;
  const resolve = memoizedRuntime(async () => { calls++; if (fail) throw new Error("does not match"); return answer; });
  assert.equal(await resolve(), undefined); assert.equal(await resolve(), undefined); assert.equal(calls, 2);
  answer = f.runtime; await resolve(); await resolve(); assert.equal(calls, 3);
  fail = true; await unlink(f.executable);
  await assert.rejects(resolve(), /does not match/); await assert.rejects(resolve(), /does not match/); assert.equal(calls, 5);
});

test("a burst arriving when the SDK has changed verifies it once more, with no caller failing", async t => {
  const f = await sdk(t); const resolve = memoizedRuntime(f.verify);
  await resolve(); await chmod(f.executable, 0o722);
  const answers = await Promise.all(Array.from({ length: 40 }, () => resolve()));
  assert.ok(answers.every(answer => answer === f.runtime)); assert.equal(f.verified(), 2);
});
