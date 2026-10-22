import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppServerBackends } from "../app-server-backends.js";
import type { Message } from "../app-server-connection.js";
import { executionHostMarker, sdkIdentity, type HostIdentity } from "../execution-host-storage.js";
import { claimNativeHome, privateNativeHolders, readNativeHomeOwner } from "../native-execution-host-storage.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { privateNativeOwnership } from "../native-fallback.js";
import { readServicePlan } from "../service-plan.js";
import { configureTelemetry } from "../telemetry.js";
import { fallbackFixture, until } from "./native-fallback-fixture.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots();
hostRunsInThisProcess();

type Fixture = Awaited<ReturnType<typeof fallbackFixture>>;
async function hostIdentity(f: Fixture): Promise<HostIdentity> {
  return {
    version: 1,
    managed: executionHostMarker,
    configPath: resolve(f.configPath),
    nativeHome: resolve(f.nativeHome),
    ...await sdkIdentity(f.sdk),
    socketPath: join(f.home, "native.sock"),
  };
}

test("a managed private-native plan leases its matching home before every SDK start", { timeout: 20000 }, async () => {
  const f = await fallbackFixture({ sharedNativeExecutor: false });
  const since = Date.now() - 1_000;
  configureTelemetry(f.config.stateDirectory, "test");
  const configPath = join(f.nativeHome, "config.toml");
  const authPath = join(f.nativeHome, "auth.json");
  const originalConfig = await readFile(configPath, "utf8");
  const originalAuth = '{"tokens":{"access_token":"native-token"}}\n';
  await writeFile(authPath, originalAuth, { mode: 0o600 });
  try {
    const first = await f.create();
    await until(async () => (await f.launches()).length === 1, "the first private engine start");
    const [firstLaunch] = await f.launches();
    assert.equal(firstLaunch.kind, "stdio");
    assert.equal(firstLaunch.lease?.hostPid, process.pid);
    assert.equal(firstLaunch.lease?.private, true);
    assert.ok(["starting", "running"].includes(String(firstLaunch.lease?.sdkState)));
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 1);

    const second = await f.create();
    await until(async () => (await f.launches()).length === 2, "the second private engine start");
    const launches = await f.launches();
    assert.equal(launches[1].lease?.private, true);
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 2);
    assert.equal((await f.events("native_sharing_fallback", since)).length, 0, "a normal managed private launch is not a fallback");

    const host = await hostIdentity(f);
    await assert.rejects(claimNativeHome(host, f.home), /already owns this native home/);

    const snapshot = { models: [] as Message[], revision: "fixture" };
    const catalog = {
      current: () => snapshot,
      refresh: async () => snapshot,
      combined: (value: typeof snapshot) => ({ models: value.models }),
      nativeSlugs: new Set<string>(),
    } as unknown as DesktopCatalog;
    await assert.rejects(
      AppServerBackends.create(f.sdk, ["app-server", "--listen", "stdio://", "bad\0argument"], f.config, {}, {}, catalog,
        async () => {}, () => {}, f.configPath),
    );
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 2, "a failed SDK build returns its lease");

    await first.adapter.request("fixture/exit", {}).catch(() => {});
    await until(() => first.exits() === 1, "the first private engine exit");
    await until(async () => (await privateNativeHolders(f.nativeHome, f.home)) === 1, "one remaining private lease");
    await assert.rejects(claimNativeHome(host, f.home), /already owns this native home/);

    await second.adapter.request("fixture/exit", {}).catch(() => {});
    await until(() => second.exits() === 1, "the final private engine exit");
    await until(async () => (await privateNativeHolders(f.nativeHome, f.home)) === 0, "the final private lease release");
    await claimNativeHome(host, f.home);

    assert.equal(await readFile(configPath, "utf8"), originalConfig);
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.privateOwner, undefined);
  } finally {
    await f.clean();
  }
});

test("only the managed plan's exact configuration and native home take a private lease", async () => {
  const f = await fallbackFixture({ sharedNativeExecutor: false });
  const configPath = join(f.nativeHome, "config.toml");
  const authPath = join(f.nativeHome, "auth.json");
  const originalConfig = await readFile(configPath, "utf8");
  const originalAuth = '{"tokens":{"access_token":"native-token"}}\n';
  await writeFile(authPath, originalAuth, { mode: 0o600 });
  try {
    const plan = await readServicePlan(f.config.stateDirectory);
    assert.ok(plan);
    const elsewhere = join(f.directory, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    for (const [label, config, nativeHome, candidatePlan] of [
      ["unmanaged", f.configPath, f.nativeHome, undefined],
      ["no configuration", undefined, f.nativeHome, plan],
      ["another configuration", join(f.directory, "other-gateway.json"), f.nativeHome, plan],
      ["another native home", f.configPath, elsewhere, plan],
    ] as const) {
      const lease = await privateNativeOwnership(config, nativeHome, f.sdk, undefined, candidatePlan);
      assert.equal(lease, undefined, label);
    }
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 0);
    assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
    assert.equal(await readNativeHomeOwner(elsewhere), undefined);
    assert.equal(await readFile(configPath, "utf8"), originalConfig);
    assert.equal(await readFile(authPath, "utf8"), originalAuth);
  } finally {
    await f.clean();
  }
});

test("a host and a managed private engine cannot both claim a native home before SDK spawn", async () => {
  const f = await fallbackFixture({ sharedNativeExecutor: false });
  try {
    const plan = await readServicePlan(f.config.stateDirectory);
    assert.ok(plan);
    const [privateClaim, hostClaim] = await Promise.allSettled([
      privateNativeOwnership(f.configPath, f.nativeHome, f.sdk, undefined, plan),
      claimNativeHome(await hostIdentity(f), f.home),
    ]);
    assert.equal([privateClaim, hostClaim].filter(result => result.status === "fulfilled").length, 1);
    assert.deepEqual(await f.launches(), [], "claiming ownership does not start an SDK");
    if (privateClaim.status === "fulfilled") {
      assert.ok(privateClaim.value);
      assert.equal(await privateNativeHolders(f.nativeHome, f.home), 1);
      assert.equal((await readNativeHomeOwner(f.nativeHome))?.privateOwner?.shared, true);
      await privateClaim.value.release();
    } else {
      assert.equal((await readNativeHomeOwner(f.nativeHome))?.privateOwner, undefined);
      if (hostClaim.status === "fulfilled") await hostClaim.value.publish(undefined, true);
    }
  } finally {
    await f.clean();
  }
});
