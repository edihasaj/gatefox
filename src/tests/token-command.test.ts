import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile), cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const fixtureToken = "synthetic-token-" + "x".repeat(32);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gatefox-token-")), file = join(root, "client-token"), config = join(root, "gateway.json"), loader = join(root, "no-runtime.mjs");
  await writeFile(file, fixtureToken + "\n", { mode: 0o600 });
  await writeFile(config, JSON.stringify({ version: 1, port: 3457, stateDirectory: "state", clientOnly: true, providers: [] }));
  await writeFile(loader, `import {registerHooks} from 'node:module';
registerHooks({resolve(spec, context, next){
  if(spec.includes('cli-main.js') || spec.includes('/providers/') || spec.includes('service-daemon')) throw Error('Token helper imported the provider/service CLI');
  return next(spec,context);
}});`);
  const invoke = (...args: string[]) => run(process.execPath, ["--import", loader, cli, "token", ...args], { timeout: 5000, cwd: root });
  return { root, file, config, invoke, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("the real token --file command completes without loading provider or service code", async () => {
  const f = await fixture(); try {
    const result = await f.invoke("--file", f.file);
    assert.equal(result.stdout, fixtureToken + "\n");
    assert.equal(result.stderr, "");
  } finally { await f.cleanup(); }
});

test("the config token helper keeps private token creation and reuses the same credential", async () => {
  const f = await fixture(); try {
    const first = await f.invoke("--config", f.config), second = await f.invoke("--config", f.config);
    assert.match(first.stdout.trim(), /^[A-Za-z0-9_-]{32,256}$/);
    assert.equal(second.stdout, first.stdout);
    assert.equal(await readFile(join(f.root, "state/client-token"), "utf8"), first.stdout);
  } finally { await f.cleanup(); }
});

test("the lightweight helper rejects malformed configuration without leaking its contents", async () => {
  const f = await fixture(); try {
    await writeFile(f.config, '{"secret-fixture-value":"never-in-diagnostics", broken');
    await assert.rejects(f.invoke("--config", f.config), error => {
      const result = error as Error & { stdout: string; stderr: string };
      assert.equal(result.stdout, ""); assert.match(result.stderr, /Configuration file is unreadable or invalid JSON/);
      assert.doesNotMatch(result.stderr, /never-in-diagnostics/); return true;
    });
    await assert.rejects(f.invoke("--config", f.config, "--file", f.file), /--file is only valid/);
  } finally { await f.cleanup(); }
});

test("the lightweight helper preserves token ownership/mode and symlink refusal", { skip: process.platform === "win32" }, async () => {
  const f = await fixture(); try {
    await chmod(f.file, 0o644);
    await assert.rejects(f.invoke("--file", f.file), /private file owned by this user/);
    await chmod(f.file, 0o600);
    const alias = join(f.root, "alias"); await symlink(f.file, alias);
    await assert.rejects(f.invoke("--file", alias));
  } finally { await f.cleanup(); }
});
