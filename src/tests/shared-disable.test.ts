import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "../config.js";
import { servicePlanPath } from "../service-plan.js";
import { disableSharing, sharingDisableFailureMessage } from "../mac-shared-disable.js";

test("disabling a sharing mode previews the remaining plan without touching the service", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-disable-"));
  const config = join(directory, "gateway.json");
  try {
    await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: directory, clientOnly: true, providers: [] });
    await assert.rejects(disableSharing(config, "shared-executors"), /nothing is shared/);
    await writePrivateJson(servicePlanPath(directory), { version: 1, config, sharedExecutors: true, sharedNativeExecutor: true, components: [
      { id: "native", kind: "native", command: "/usr/bin/true", args: ["--native-home", join(directory, "native"), "--relay-home", join(directory, "relay"), "--codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "--daemon"], log: join(directory, "native.log") }] });
    const preview = await disableSharing(config, "shared-executors");
    assert.deepEqual(preview, { mode: "shared-executors", enabled: true, remaining: { sharedNativeExecutor: true, sharedExecutors: false }, applied: false,
      next: "gateway service shared-executors --disable --apply after local and remote chats finish" });
    assert.deepEqual((await disableSharing(config, "shared-native")).remaining, { sharedNativeExecutor: false, sharedExecutors: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the failure message collapses a JSON parse error but keeps an ordinary reason", () => {
  let syntax: unknown = new Error("expected JSON.parse to throw");
  try { JSON.parse('{"pid": SECRET_TOKEN_FROM_PLAN'); } catch (error) { syntax = error; }
  assert.ok(syntax instanceof SyntaxError);
  const fromParse = sharingDisableFailureMessage("shared-executors", syntax, "/tmp/backup", true);
  assert.match(fromParse, /Invalid JSON data/);
  assert.doesNotMatch(fromParse, /SECRET|pid/);
  assert.match(fromParse, /^Turning off shared-executors failed \(Invalid JSON data\)\. The previous plan is restored from \/tmp\/backup and the service was restarted\.$/);
  assert.equal(sharingDisableFailureMessage("shared-native", new Error("launchctl bootstrap failed"), "/tmp/backup", false),
    "Turning off shared-native failed (launchctl bootstrap failed). The previous plan is restored from /tmp/backup; start it with gateway service install.");
  assert.match(sharingDisableFailureMessage("shared-native", "not an error", "/tmp/backup", false), /failed \(Unknown failure\)\./);
});
