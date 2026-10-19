import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writePrivateJson } from "../config.js";
import { nativeHomeOwnerPath, readNativeHomeOwner, type NativeHomeOwner } from "../native-execution-host-storage.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.

async function fixture(): Promise<{ nativeHome: string; path: string; owner: NativeHomeOwner; restore: () => void }> {
  const root = await mkdtemp(join(tmpdir(), "gw-native-owner-read-")); const nativeHome = join(root, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const previous = process.env.HOME; process.env.HOME = root;
  const path = nativeHomeOwnerPath(nativeHome);
  const owner: NativeHomeOwner = { version: 1, managed: "subscription-gateway-native-execution-owner", configPath: join(root, "gateway.json"), nativeHome,
    codex: join(root, "codex"), sdkSha256: "a".repeat(64), hostPid: 0, pid: 0, socketPath: join(root, "native.sock"), state: "stopped", sdkState: "stopped" };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writePrivateJson(path, owner);
  return { nativeHome, path, owner, restore: () => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; } };
}

test("a receipt replaced by atomic rename between lstat and open is retried, not reported invalid", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    let writing = true;
    const writers = Array.from({ length: 4 }, (_, lane) => (async () => { for (let version = 0; writing; version++) await writePrivateJson(f.path, { ...f.owner, hostPid: (version + lane) % 2 }); })());
    try { for (let index = 0; index < 300; index++) for (const owner of await Promise.all(Array.from({ length: 8 }, () => readNativeHomeOwner(f.nativeHome)))) assert.equal(owner?.nativeHome, f.nativeHome); }
    finally { writing = false; await Promise.all(writers); }
  } finally { f.restore(); }
});

test("an unreadable or overly permissive receipt is still rejected, and a missing one is absent", async () => {
  const f = await fixture();
  try {
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.state, "stopped");
    await chmod(f.path, 0o644);
    await assert.rejects(readNativeHomeOwner(f.nativeHome), /ownership receipt is invalid/);
    const other = await mkdtemp(join(tmpdir(), "gw-native-owner-missing-"));
    assert.equal(await readNativeHomeOwner(other), undefined);
  } finally { f.restore(); }
});
