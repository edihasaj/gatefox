import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
test("claude-config emits scoped settings without installing them or creating a token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-config-cli-"));
  const config = join(directory, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: 3457, stateDirectory: join(directory, "state"), providers: [
    { id: "claude", type: "claude-subscription", models: { "claude/example": "claude-example" } },
  ] }));
  const { stdout } = await run(process.execPath, [cli, "claude-config", "--model", "claude/example", "--config", config]);
  const settings = JSON.parse(stdout);
  assert.equal(settings.model, "claude/example");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3457");
  assert.match(settings.apiKeyHelper, /token/); assert.match(settings.apiKeyHelper, /--config/);
  assert.deepEqual(await readdir(directory), ["gateway.json"]);
  assert.equal(settings.permissions, undefined);
  await assert.rejects(run(process.execPath, [cli, "claude-config", "--model", "unknown", "--config", config]), /configured alias/);
});

test("claude-config remote mode rejects incomplete or mixed arguments without network access", async () => {
  for (const args of [
    ["--model", "alias", "--endpoint", "http://127.0.0.1:1/v1"],
    ["--model", "alias", "--endpoint", "http://127.0.0.1:1/v1", "--token-file", "/missing", "--catalog", "/tmp/catalog.json"],
  ]) await assert.rejects(run(process.execPath, [cli, "claude-config", ...args]), /Remote claude-config requires/);
});
