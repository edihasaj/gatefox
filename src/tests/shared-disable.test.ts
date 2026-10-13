import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "../config.js";
import { servicePlanPath } from "../service-plan.js";
import { disableSharing } from "../mac-shared-disable.js";

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
