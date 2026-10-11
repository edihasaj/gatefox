import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { sshWrapper } from "../mac-ssh.js";
import { appServerIndex } from "../codex-shim.js";
import { shimFiles } from "./shim-fixture.js";
import { AppServerConnection } from "../app-server-connection.js";

test("app-server routing distinguishes a command from config values and prompts", () => {
  assert.equal(appServerIndex(["-c", "features.code_mode_host=true", "app-server"]), 2);
  assert.equal(appServerIndex(["--cd", "app-server", "exec", "hi"]), -1);
  assert.equal(appServerIndex(["exec", "app-server"]), -1);
  assert.equal(appServerIndex(["--config=model=app-server", "app-server"]), 1);
});

test("SSH command preserves the original CLI and decorates only app-server", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const f = await shimFiles();
  const original = join(f.directory, "original ' CLI"); const wrapper = join(f.directory, "ssh-codex"); const config = join(f.directory, "gateway ' config.json");
  await copyFile(f.config, config);
  await writeFile(original, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n', { mode: 0o700 });
  await writeFile(wrapper, sshWrapper(config, original, f.backend, { command: process.execPath, args: [f.cli] }), { mode: 0o700 });
  const exec = promisify(execFile);
  try {
    for (const args of [["--version"], ["exec", "app-server"], ["--cd", "app-server", "exec", "literal $(touch should-not-exist)"]]) assert.deepEqual(JSON.parse((await exec(wrapper, args, { env: f.env })).stdout), args);
    const connection = new AppServerConnection(wrapper, ["-c", "features.code_mode_host=true", "app-server"], async () => {}, () => {}, f.env);
    try {
      await connection.request("initialize", { clientInfo: { name: "ssh-test", version: "1" } });
      const response = await connection.request("model/list", {});
      assert.deepEqual((response.data as Array<{ model: string }>).map(row => row.model), ["native", "claude/model"]);
    } finally { connection.stop(); await connection.exited; }
  } finally { f.close(); }
});
