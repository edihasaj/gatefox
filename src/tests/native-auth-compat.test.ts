import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderInstalledLauncher } from "../app-runtime.js";
import { legacyNativeAuthArgs } from "../native-auth-compat.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gatefox-native-auth-")), prefix = join(root, "prefix"), installation = join(prefix, "share/gatefox"), bin = join(prefix, "bin");
  await mkdir(join(installation, "releases/1.8.6/package/dist"), { recursive: true, mode: 0o700 }); await mkdir(bin, { recursive: true, mode: 0o700 });
  await writeFile(join(installation, ".gateway-installation"), "subscription-gateway\n", { mode: 0o600 });
  await writeFile(join(installation, "releases/1.8.6/package/dist/cli.js"), "// fixture\n");
  await symlink("releases/1.8.6", join(installation, "current"));
  const command = join(bin, "gatefox"), old = join(bin, "harness-gateway"), wrapper = renderInstalledLauncher(installation, command);
  for (const file of [command, old]) await writeFile(file, wrapper, { mode: 0o700 });
  const args = ["app-server", "--analytics-default-enabled", "-c", 'model="original"', ...["gatefox", "subscription_gateway"].flatMap(id => [
    "-c", `model_providers.${id}.base_url="http://127.0.0.1:3457/v1"`,
    "-c", `model_providers.${id}.auth.command=${JSON.stringify(command)}`,
    "-c", `model_providers.${id}.auth.args=["token","--config","/same/account.json"]`,
    "-c", `model_providers.${id}.auth.timeout_ms=15000`,
  ])];
  return { root, command, old, args, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("only the four known helper metadata overrides change after proving identical managed aliases", async () => {
  const f = await fixture(); try {
    const before = [...f.args], result = await legacyNativeAuthArgs(f.args);
    assert.ok(result); assert.deepEqual(f.args, before);
    assert.equal(result.length, before.length);
    let changes = 0;
    for (let i = 0; i < before.length; i++) {
      if (result[i] === before[i]) continue;
      changes++;
      assert.match(before[i]!, /^model_providers\.(gatefox|subscription_gateway)\.auth\.(command|timeout_ms)=/);
      assert.equal(result[i], before[i]!.includes("auth.command=") ? before[i]!.replace(JSON.stringify(f.command), JSON.stringify(f.old)) : before[i]!.replace("=15000", "=5000"));
    }
    assert.equal(changes, 4);
  } finally { await f.cleanup(); }
});

test("partial, duplicate, different-budget and ambiguous auth settings never get a compatibility variant", async () => {
  const f = await fixture(); try {
    const command = `model_providers.gatefox.auth.command=${JSON.stringify(f.command)}`;
    for (const args of [
      f.args.filter(value => !value.includes("subscription_gateway.auth.timeout_ms")),
      [...f.args, "-c", command],
      f.args.map(value => value.replace("auth.timeout_ms=15000", "auth.timeout_ms=30000")),
      f.args.map(value => value.startsWith("model_providers.subscription_gateway.auth.command=") ? value.replace(JSON.stringify(f.command), '"/different/gatefox"') : value),
      [...f.args, "--config=ambiguous=true"],
      f.args.map(value => value === command ? "model_providers.gatefox.auth.command=not-json" : value),
      f.args.map(value => value.includes("auth.command=") ? value.replace(JSON.stringify(f.command), '"gatefox"') : value),
    ]) assert.equal(await legacyNativeAuthArgs(args), undefined);
  } finally { await f.cleanup(); }
});

test("a foreign, writable, symlinked or differently rendered legacy helper is never considered equivalent", async () => {
  for (const kind of ["foreign", "writable", "symlink", "different-launcher"] as const) {
    const f = await fixture(); try {
      if (kind === "foreign") await writeFile(f.old, "#!/bin/sh\necho foreign\n", { mode: 0o700 });
      if (kind === "writable") await chmod(f.old, 0o722);
      if (kind === "symlink") { await rm(f.old); await symlink(f.command, f.old); }
      if (kind === "different-launcher") await writeFile(f.old, renderInstalledLauncher(join(f.root, "prefix/share/gatefox"), f.old), { mode: 0o700 });
      assert.equal(await legacyNativeAuthArgs(f.args), undefined, kind);
    } finally { await f.cleanup(); }
  }
});

test("auth aliases combine with confirmed Code Mode and analytics defaults in at most eight ownership attempts", async () => {
  const f = await fixture(); try {
    const { acquireNativeCompatible } = await import("../native-execution-compat.js");
    const args = ["-c", "features.code_mode_host=true", ...f.args], original = [...args];
    const legacy = await legacyNativeAuthArgs(f.args); assert.ok(legacy);
    const expected = legacy.filter(arg => arg !== "--analytics-default-enabled"), record = { pid: 123, revision: "retained" };
    let calls = 0, featureChecks = 0;
    const result = await acquireNativeCompatible(async params => {
      calls++; assert.equal(params.cwd, "/same/home");
      if (JSON.stringify(params.args) !== JSON.stringify(expected)) throw Object.assign(new Error("Native execution startup settings differ; existing ownership was preserved"), { code: -32000 });
      return record;
    }, args, "/same/home", async () => { featureChecks++; return true; });
    assert.equal(result, record); assert.equal(calls, 8); assert.equal(featureChecks, 1); assert.deepEqual(args, original);
  } finally { await f.cleanup(); }
});

test("auth metadata compatibility never removes an unconfirmed requested Code Mode flag", async () => {
  const f = await fixture(); try {
    const { acquireNativeCompatible } = await import("../native-execution-compat.js");
    const args = ["-c", "features.code_mode_host=true", ...f.args]; let calls = 0;
    await assert.rejects(acquireNativeCompatible(async params => {
      calls++; assert.ok((params.args as string[]).includes("features.code_mode_host=true"));
      throw Object.assign(new Error("Native execution startup settings differ; existing ownership was preserved"), { code: -32000 });
    }, args, "/same/home", async () => false), /startup settings differ/);
    assert.equal(calls, 4);
  } finally { await f.cleanup(); }
});
