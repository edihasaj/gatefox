import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSafeRoot } from "../test-root-guard.js";
import { executionHostRoot } from "../execution-host-storage.js";
import { nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import { nativeRelayHome } from "../native-control.js";
import { sshControlHome } from "../ssh-socket.js";

// A test process never resolves a real per-user root: the leak this prevents put 1,623 test receipts into a real gw-native.
test("a test process may use a per-user root only inside a temporary folder, and never the fixed SDK rendezvous", () => {
  assert.equal(typeof process.env.NODE_TEST_CONTEXT, "string", "node:test marks this process");
  const temporary = join(tmpdir(), "gw-root-guard", ".local/state/gw-native");
  assert.equal(testSafeRoot(temporary, "native-home receipt root"), temporary);
  if (process.platform !== "win32") assert.equal(testSafeRoot("/tmp/gwr-x/n", "native-home receipt root"), "/tmp/gwr-x/n");
  assert.throws(() => testSafeRoot("/Users/someone/.local/state/gw-native", "native-home receipt root"), /A test process reached the real native-home receipt root/);
  assert.throws(() => testSafeRoot(join(tmpdir(), "codex-daemon-501"), "SDK socket rendezvous", { fixed: true }), /reached the real SDK socket rendezvous/);
  const saved = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal(testSafeRoot("/Users/someone/.local/state/gw-native", "native-home receipt root"), "/Users/someone/.local/state/gw-native", "a gateway process is never refused");
  } finally { process.env.NODE_TEST_CONTEXT = saved; }
});

test("the real roots follow the guard: a test HOME outside the temporary folders is refused, one inside is used", () => {
  const saved = process.env.HOME;
  try {
    process.env.HOME = "/Users/someone";
    assert.throws(() => executionHostRoot(), /real execution host root/);
    assert.throws(() => nativeHomeOwnerPath("/Users/someone/.codex"), /real native-home receipt root/);
    assert.throws(() => nativeRelayHome("/Users/someone/gateway.json", "/Users/someone/.codex"), /real native relay root/);
    assert.throws(() => sshControlHome("/Users/someone/gateway.json", "/Users/someone/.codex"), /real SSH control root/);
    process.env.HOME = join(tmpdir(), "gw-root-guard-home");
    assert.equal(executionHostRoot(), join(tmpdir(), "gw-root-guard-home", ".local/state/gw-exec"));
  } finally { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; }
});
