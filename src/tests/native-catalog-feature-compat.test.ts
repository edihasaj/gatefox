import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeCodexFeatureArgs, preflightCodexFeatureArgs } from "../codex-feature-compat.js";
import { prepareNativeCatalog } from "../native-catalog.js";
import { shimFiles } from "./shim-fixture.js";
import type { Message } from "../app-server-connection.js";

const args = ["app-server", "-c", "features.codex_hooks=true", "--enable=codex_hooks",
  "-c", "features.code_mode_tool_description_first=true", "--disable", "guardianv2.thread_context",
  "--config=profiles.work.features=" + JSON.stringify({ codex_hooks: true, code_mode: true, guardianv2: { enabled: false, thread_context: true } }),
  "-c", "profiles.'work.profile'.features={ codex_hooks = false, code_mode = true, guardianv2 = { enabled = true, thread_context = false } }",
  "--config=features.guardianv2.thread_context=false", "-c", "features.code_mode.enabled=true"];
const expectedPreflight = ["app-server",
  '--config=profiles.work.features={"code_mode":true,"guardianv2":{"enabled":false}}',
  "-c", "profiles.'work.profile'.features={ code_mode = true, guardianv2 = { enabled = true } }",
  "-c", "features.code_mode.enabled=true"];

async function capturedFixture() {
  const f = await shimFiles(); const capture = join(f.directory, "sdk-args.jsonl");
  const source = await readFile(f.backend, "utf8");
  await writeFile(f.backend, source.replace("const fs=require('node:fs');const path=require('node:path');",
    `const fs=require('node:fs');const path=require('node:path');fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');`)
    .replace(`const home=process.env.CODEX_HOME||${JSON.stringify(f.nativeHome)};`, `const home=${JSON.stringify(f.nativeHome)};`), { mode: 0o700 });
  return { ...f, captured: async (): Promise<string[][]> => (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line)) };
}

test("metadata preflight removes retired scalar, profile, JSON and TOML CLI keys without synthesizing hooks", () => {
  const original = [...args]; assert.deepEqual(preflightCodexFeatureArgs(args), expectedPreflight); assert.deepEqual(args, original);
  for (const enabled of [false, true]) {
    const current = ["-c", `features.hooks=${enabled}`, "--config=profiles.work.features=" + JSON.stringify({ hooks: enabled, codex_hooks: !enabled, code_mode: true }),
      "-c", `profiles.'work.profile'.features={ hooks = ${enabled}, codex_hooks = ${!enabled}, code_mode = true }`, enabled ? "--enable" : "--disable", "hooks"];
    assert.deepEqual(preflightCodexFeatureArgs([...args, ...current]), [...expectedPreflight,
      "-c", `features.hooks=${enabled}`, `--config=profiles.work.features={"hooks":${enabled},"code_mode":true}`,
      "-c", `profiles.'work.profile'.features={ hooks = ${enabled}, code_mode = true }`, enabled ? "--enable" : "--disable", "hooks"]);
  }
});

test("every metadata SDK spawn receives clean arguments and preserves the native hooks base", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const f = await capturedFixture(); const original = await readFile(join(f.nativeHome, "config.toml"), "utf8");
  const sourceCatalog = JSON.parse(await readFile(f.catalog, "utf8"));
  try {
    for (const enabled of [undefined, false, true]) {
      const base: Message = enabled === undefined ? {} : { features: { hooks: enabled }, profiles: { work: { features: { hooks: enabled } }, "work.profile": { features: { hooks: enabled } } } };
      await writeFile(join(f.nativeHome, "agent-policy.json"), JSON.stringify(base));
      const prepared = await prepareNativeCatalog(f.backend, args, f.value);
      assert.deepEqual(prepared.settings, { model: "native", model_provider: "openai", model_catalog_json: f.catalog, ...base });
      assert.deepEqual((await f.captured()).at(-1), expectedPreflight);
      const later = normalizeCodexFeatureArgs(args, prepared.settings);
      if (enabled === undefined) {
        assert.ok(later.includes("features.hooks=true")); assert.ok(later.includes("--enable=hooks"));
        assert.ok(later.includes('--config=profiles.work.features={"code_mode":true,"guardianv2":{"enabled":false},"hooks":true}'));
        assert.ok(later.includes("profiles.'work.profile'.features={ hooks = false, code_mode = true, guardianv2 = { enabled = true } }"));
      } else assert.deepEqual(later, expectedPreflight);
      const combined = JSON.parse(await readFile(prepared.path, "utf8"));
      assert.deepEqual(combined.models[0], sourceCatalog.models[0]); assert.equal(combined.identity, undefined);
    }
    assert.equal((await f.captured()).length, 3);
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), original);
  } finally { f.close(); }
});

test("the actual shim applies aliases after preflight and respects native and current CLI hooks", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const cases = [
    { base: undefined, legacy: true, current: undefined, expected: ["features.hooks=true", "features.code_mode.enabled=true"] },
    { base: false, legacy: true, current: undefined, expected: ["features.code_mode.enabled=true"] },
    { base: true, legacy: false, current: undefined, expected: ["features.code_mode.enabled=true"] },
    { base: true, legacy: true, current: false, expected: ["features.code_mode.enabled=true", "features.hooks=false"] },
  ];
  for (const value of cases) {
    const f = await capturedFixture();
    if (value.base !== undefined) await writeFile(join(f.nativeHome, "agent-policy.json"), JSON.stringify({ features: { hooks: value.base } }));
    const forwarded = ["app-server", "-c", `features.codex_hooks=${value.legacy}`, "-c", "features.code_mode_tool_description_first=true", "-c", "features.guardianv2.thread_context=false", "-c", "features.code_mode.enabled=true",
      ...(value.current === undefined ? [] : ["-c", `features.hooks=${value.current}`])];
    const original = await readFile(join(f.nativeHome, "config.toml"), "utf8");
    const child = spawn(process.execPath, [f.cli, "codex-shim", "--config", f.config, "--codex", f.backend, "--", ...forwarded], { env: f.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume(); const exited = once(child, "close"); const lines = createInterface({ input: child.stdout });
    const initialized = new Promise<Message>((resolve, reject) => {
      lines.on("line", line => { const message = JSON.parse(line); if (message.id === 1) message.error ? reject(new Error(message.error.message)) : resolve(message); });
      child.once("close", code => reject(new Error(`Shim exited before initialization: ${code}`)));
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "preflight-feature-test", version: "1" } } }) + "\n");
    try {
      await initialized;
      const observed = await f.captured(); assert.equal(observed.length, 2);
      assert.deepEqual(observed[0], ["app-server", "-c", "features.code_mode.enabled=true", ...(value.current === undefined ? [] : ["-c", `features.hooks=${value.current}`])]);
      assert.deepEqual(observed[1].filter(arg => arg.startsWith("features.")), value.expected);
      assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), original);
      child.stdin.end(); await exited; assert.equal(child.exitCode, 0);
    } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await exited; } lines.close(); f.close(); }
  }
});
