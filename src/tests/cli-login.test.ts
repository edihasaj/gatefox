import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
test("next-login CLI scope refuses conflicting or unrelated mutations before opening configuration", async () => {
  for (const args of [["service", "consolidate", "--apply", "--next-login"], ["service", "install", "--next-login"], ["desktop", "register", "--next-login"]]) {
    await assert.rejects(run(process.execPath, [cli, ...args, "--config", "/missing/fixture/gateway.json"]), error => {
      const failure = error as Error & { code: number; stderr: string };
      assert.equal(failure.code, 2); assert.match(failure.stderr, /--next-login is only valid/);
      assert.ok(!failure.stderr.includes("Configuration file")); return true;
    });
  }
  const help = await run(process.execPath, [cli, "--help", "--next-login"]);
  assert.match(help.stdout, /consolidate \[--apply \| --next-login\]/);
});
