import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servicePlist } from "../mac-service.js";

test("launchd service escapes paths, preserves argv boundaries, and exports only PATH", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-plist-")); const file = join(directory, "service.plist");
  const config = '/tmp/gateway & "account"/config.json';
  await writeFile(file, servicePlist("/usr/bin/node", "/tmp/gateway/cli.js", config, "/tmp/service.log", "/usr/bin:/bin"));
  const { stdout } = await promisify(execFile)("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.ProgramArguments, ["/usr/bin/node", "/tmp/gateway/cli.js", "serve", "--config", config]);
  assert.deepEqual(parsed.EnvironmentVariables, { PATH: "/usr/bin:/bin" });
  assert.equal(parsed.KeepAlive, true); assert.equal(parsed.RunAtLoad, true);
});
