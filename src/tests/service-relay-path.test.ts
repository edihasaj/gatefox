import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followCurrentRelease } from "../service-relay-path.js";
import type { ServiceComponent } from "../service-plan.js";

const relay = (command: string, kind: ServiceComponent["kind"] = "native"): ServiceComponent =>
  ({ id: "native", kind, command, args: ["--native-home", "/n", "--daemon"], log: "/l" });

test("a relay pinned to an old release starts from current once current has a relay", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-path-"));
  for (const version of ["0.5.0", "0.6.6"]) {
    await mkdir(join(root, "releases", version, "package", "native"), { recursive: true });
    const binary = join(root, "releases", version, "package", "native", "gateway-native-relay");
    await writeFile(binary, "#!/bin/sh\n"); await chmod(binary, 0o755);
  }
  await symlink(join("releases", "0.6.6"), join(root, "current"));
  const pinned = relay(join(root, "releases", "0.5.0", "package", "native", "gateway-native-relay"));
  const followed = followCurrentRelease(pinned);
  assert.equal(followed.command, join(root, "current", "package", "native", "gateway-native-relay"));
  assert.deepEqual(followed.args, pinned.args, "only the executable changes");
  assert.equal(pinned.command, join(root, "releases", "0.5.0", "package", "native", "gateway-native-relay"), "the plan's own component is not mutated");
});

test("the pinned relay is kept when current has no relay, and other components are untouched", () => {
  const pinned = relay("/r/releases/0.5.0/package/native/gateway-native-relay");
  assert.equal(followCurrentRelease(pinned, () => false), pinned);
  assert.equal(followCurrentRelease(relay("/r/current/package/native/gateway-native-relay"), () => true).command, "/r/current/package/native/gateway-native-relay");
  assert.equal(followCurrentRelease(relay("/private/relay"), () => true).command, "/private/relay");
  const tunnel = relay("/r/releases/0.5.0/package/native/gateway-native-relay", "tunnel");
  assert.equal(followCurrentRelease(tunnel, () => true), tunnel);
});
