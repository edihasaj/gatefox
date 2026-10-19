import { after, before } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setExecutionHostRootForTests, setSdkSocketRootForTests } from "../execution-host-storage.js";
import { setNativeOwnerRootForTests } from "../native-execution-host-storage.js";
import { setHostWaitForTests } from "../execution-host-client.js";

/**
 * Call once from a test file that starts an execution host or claims a host or native home. The SDK's socket rendezvous
 * (`/tmp/codex-daemon-<uid>` in production), the host homes (`~/.local/state/gw-exec`) and the native-home receipts
 * (`~/.local/state/gw-native`) then live in one short private folder of the file's own, removed when its tests end, so
 * nothing reaches the real ones whether the file runs under `npm test` or on its own. The folder is short because a Unix
 * socket path cannot exceed 104 bytes on macOS and the rendezvous names each socket by a 64-character hash.
 * An adapter whose required host is down waits up to 20 s for it to come back; in these files it waits half a second, so a
 * test of an outage still sees the adapter fail closed without sitting out the wait. A test of the wait sets its own.
 */
const testHostWaitMs = 500;
export function isolateExecutionRoots(): { restore(): void; child(): { args: string[]; env: Record<string, string> } } {
  let folder: string | undefined;
  const roots = () => folder ? { sdk: join(folder, "r"), hosts: join(folder, "x"), native: join(folder, "n") } : undefined;
  const apply = () => { const value = roots(); if (value) { setSdkSocketRootForTests(value.sdk); setExecutionHostRootForTests(value.hosts); setNativeOwnerRootForTests(value.native); setHostWaitForTests(testHostWaitMs); } };
  before(async () => {
    folder = await mkdtemp(join(process.env.GATEWAY_TEST_TMPDIR ?? (process.platform === "win32" ? tmpdir() : "/tmp"), "gwr-"));
    apply();
  });
  after(async () => {
    setSdkSocketRootForTests(); setExecutionHostRootForTests(); setNativeOwnerRootForTests(); setHostWaitForTests();
    if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  // A test that points a root at a folder of its own puts the file's back with this, never the real one. A child process the
  // test starts (a CLI host, say) gets the same roots through `child()`: its node arguments load a preload that applies them.
  const child = () => {
    const value = roots(); if (!value) throw new Error("isolateExecutionRoots: the roots exist only while the file's tests run");
    return { args: ["--import", new URL("./isolated-roots-preload.js", import.meta.url).href], env: { GATEWAY_TEST_EXECUTION_ROOTS: JSON.stringify(value) } };
  };
  return { restore: apply, child };
}
