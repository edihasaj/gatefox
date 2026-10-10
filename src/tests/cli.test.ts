import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("npm-style CLI symlinks execute help and version without a provider configuration", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-cli-"));
  const entry = join(directory, "gateway");
  await symlink(fileURLToPath(new URL("../cli.js", import.meta.url)), entry);
  const run = promisify(execFile);
  const options = { env: { ...process.env, GATEWAY_CONFIG: join(directory, "absent.json") }, cwd: directory };
  assert.equal((await run(process.execPath, [entry, "--version"], options)).stdout.trim(), "0.1.0");
  assert.match((await run(process.execPath, [entry, "--help"], options)).stdout, /gateway codex-config/);
  await assert.rejects(run(process.execPath, [entry, "providers"], options), /Configuration file is unreadable/);
});
