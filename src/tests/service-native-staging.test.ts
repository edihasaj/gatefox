import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "../config.js";
import { activatePendingNativeSharing, pendingNativeSharingPath, readPendingNativeSharing, stageNativeSharing, type NativeSharingActivationDependencies, type NativeSharingStageDependencies } from "../service-native-staging.js";
import { readServicePlan, servicePlanPath, type ServicePlan } from "../service-plan.js";

async function fixture(sharedExecutors = false) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-native-stage-"));
  const state = join(directory, "state"); const config = join(directory, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3457, clientOnly: true, stateDirectory: state, providers: [] });
  const plan: ServicePlan = { version: 1, config, ...(sharedExecutors ? { sharedExecutors: true } : {}), components: [{
    id: "native", kind: "native", command: "/private/relay",
    args: ["--daemon", "--codex", "/private/codex", "--native-home", "/private/native", "--relay-home", "/private/relay-home"], log: "/private/log",
  }] };
  await writePrivateJson(servicePlanPath(state), plan);
  const notices: Array<{ event: string; fields: Record<string, string> }> = [];
  const stage: Partial<NativeSharingStageDependencies> = {
    platform: "darwin", registration: async () => true, nativeSdk: async () => {}, runtime: async () => ({ executable: "/private/gateway-sdk", binarySha256: "a".repeat(64), selectedModelCompaction: true, executorIdentity: true }),
    pendingLogin: async () => undefined, notice: (event, fields) => { notices.push({ event, fields }); },
  };
  const activation: Partial<NativeSharingActivationDependencies> = {
    ...stage, primary: async () => true, census: async () => [], backup: async () => {},
  };
  return { directory, state, config, plan, stage, activation, notices, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("staging native ownership writes only a narrow receipt and preserves gateway sharing unless asked", async () => {
  const f = await fixture(true);
  try {
    const before = await readFile(servicePlanPath(f.state), "utf8");
    const result = await stageNativeSharing(f.config, false, f.stage);
    const pending = await readPendingNativeSharing(f.state);
    assert.equal((await readFile(servicePlanPath(f.state), "utf8")), before);
    assert.equal(pending?.action, "enable-native"); assert.equal(pending?.enableGateway, undefined);
    assert.equal(result.sharedExecutors, true); assert.equal(f.notices.at(-1)?.event, "native_sharing_staged");
    await stageNativeSharing(f.config, true, f.stage);
    assert.equal((await readPendingNativeSharing(f.state))?.enableGateway, true);
  } finally { await f.cleanup(); }
});

test("staging refuses an unsigned SDK, missing combined runtime, pending login or foreign registration before writing intent", async () => {
  const cases: Array<{ name: string; withGateway?: boolean; dependencies: Partial<NativeSharingStageDependencies> }> = [
    { name: "signature", dependencies: { nativeSdk: async () => { throw new Error("unsigned"); } } },
    { name: "runtime", withGateway: true, dependencies: { runtime: async () => undefined } },
    { name: "login", dependencies: { pendingLogin: async () => ({ staged: true }) } },
    { name: "registration", dependencies: { registration: async () => false } },
  ];
  for (const item of cases) {
    const f = await fixture();
    try {
      const before = await readFile(servicePlanPath(f.state), "utf8");
      await assert.rejects(stageNativeSharing(f.config, item.withGateway === true, { ...f.stage, ...item.dependencies }), /./, item.name);
      assert.equal(await readFile(servicePlanPath(f.state), "utf8"), before, item.name);
      assert.equal(await readPendingNativeSharing(f.state), undefined, item.name);
    } finally { await f.cleanup(); }
  }
});

test("only the primary daemon activates a staged receipt, with no writer census at staging time", async () => {
  const f = await fixture();
  try {
    await stageNativeSharing(f.config, true, f.stage);
    const manual = await activatePendingNativeSharing(f.config, f.plan, { ...f.activation, primary: async () => false });
    assert.deepEqual(manual, f.plan); assert.ok(await readPendingNativeSharing(f.state));
    const activated = await activatePendingNativeSharing(f.config, f.plan, f.activation);
    assert.equal(activated.sharedNativeExecutor, true); assert.equal(activated.sharedExecutors, true);
    assert.equal((await readServicePlan(f.state))?.sharedNativeExecutor, true);
    assert.equal(await readPendingNativeSharing(f.state), undefined);
  } finally { await f.cleanup(); }
});

test("a changed plan, unavailable SDK, or surviving writer defers without changing either receipt or plan", async () => {
  const f = await fixture();
  try {
    await stageNativeSharing(f.config, false, f.stage);
    const original = await readFile(servicePlanPath(f.state), "utf8");
    const changed = { ...f.plan, components: [...f.plan.components, { id: "tunnel", kind: "tunnel" as const, command: "/usr/bin/ssh", args: [], log: "/private/tunnel.log" }] };
    await writePrivateJson(servicePlanPath(f.state), changed);
    assert.deepEqual(await activatePendingNativeSharing(f.config, changed, f.activation), changed);
    assert.ok(await readPendingNativeSharing(f.state));
    await writeFile(servicePlanPath(f.state), original, { mode: 0o600 });
    assert.deepEqual(await activatePendingNativeSharing(f.config, f.plan, { ...f.activation, census: async () => [{ pid: 44, kind: "adapter" }] }), f.plan);
    assert.equal(await readFile(servicePlanPath(f.state), "utf8"), original);
    assert.ok(await readPendingNativeSharing(f.state));
  } finally { await f.cleanup(); }
});

test("a daemon that started with plan A runs the current same-configuration plan B when staging sees B changed", async () => {
  const f = await fixture();
  try {
    await stageNativeSharing(f.config, false, f.stage);
    const current: ServicePlan = { ...f.plan, components: [...f.plan.components, {
      id: "tunnel", kind: "tunnel", command: "/usr/bin/ssh", args: ["example"], log: "/private/tunnel.log",
    }] };
    await writePrivateJson(servicePlanPath(f.state), current);
    const selected = await activatePendingNativeSharing(f.config, f.plan, f.activation);
    assert.deepEqual(selected, current);
    assert.deepEqual(await readServicePlan(f.state), current);
    assert.ok(await readPendingNativeSharing(f.state), "the changed-plan intent remains pending");
  } finally { await f.cleanup(); }
});

test("signature, gateway-runtime, census and backup refusals each preserve the exact old plan and receipt", async () => {
  const cases: Array<{ name: string; withGateway?: boolean; dependencies: Partial<NativeSharingActivationDependencies> }> = [
    { name: "signature", dependencies: { nativeSdk: async () => { throw new Error("not signed"); } } },
    { name: "gateway runtime", withGateway: true, dependencies: { runtime: async () => undefined } },
    { name: "census", dependencies: { census: async () => { throw new Error("cannot inspect"); } } },
    { name: "backup", dependencies: { backup: async () => { throw new Error("cannot save"); } } },
  ];
  for (const item of cases) {
    const f = await fixture();
    try {
      await stageNativeSharing(f.config, item.withGateway === true, f.stage);
      const old = await readFile(servicePlanPath(f.state), "utf8");
      assert.deepEqual(await activatePendingNativeSharing(f.config, f.plan, { ...f.activation, ...item.dependencies }), f.plan, item.name);
      assert.equal(await readFile(servicePlanPath(f.state), "utf8"), old, item.name);
      assert.ok(await readPendingNativeSharing(f.state), item.name);
    } finally { await f.cleanup(); }
  }
});

test("an exact committed candidate completes receipt cleanup after a crash", async () => {
  const f = await fixture();
  try {
    await stageNativeSharing(f.config, false, f.stage);
    const pending = (await readPendingNativeSharing(f.state))!;
    const target = { ...f.plan, sharedNativeExecutor: true };
    await writeFile(servicePlanPath(f.state), JSON.stringify(target, null, 2) + "\n", { mode: 0o600 });
    let census = 0;
    const resumed = await activatePendingNativeSharing(f.config, f.plan, { ...f.activation, census: async () => { census++; return []; } });
    assert.equal(resumed.sharedNativeExecutor, true); assert.equal(census, 0);
    assert.equal(await readPendingNativeSharing(f.state), undefined);
    assert.match(pending.candidatePlanSha256, /^[a-f0-9]{64}$/);
  } finally { await f.cleanup(); }
});

test("a writer that reports after committing the candidate never returns the old plan", async () => {
  const f = await fixture();
  try {
    await stageNativeSharing(f.config, false, f.stage);
    const result = await activatePendingNativeSharing(f.config, f.plan, {
      ...f.activation,
      commit: async (path, text) => { await writeFile(path, text, { mode: 0o600 }); throw new Error("late writer failure"); },
    });
    assert.equal(result.sharedNativeExecutor, true);
    assert.equal((await readServicePlan(f.state))?.sharedNativeExecutor, true);
    assert.equal(await readPendingNativeSharing(f.state), undefined);
  } finally { await f.cleanup(); }
});

test("a malformed or unsafe pending receipt is rejected before a re-stage can replace it", async () => {
  const f = await fixture();
  try {
    await writeFile(pendingNativeSharingPath(f.state), "{}", { mode: 0o600 });
    await assert.rejects(stageNativeSharing(f.config, false, f.stage), /Invalid pending native sharing/);
    await chmod(pendingNativeSharingPath(f.state), 0o644);
    await assert.rejects(readPendingNativeSharing(f.state), /private regular file/);
    await rm(pendingNativeSharingPath(f.state));
    if (process.platform !== "win32") {
      await symlink("/dev/null", pendingNativeSharingPath(f.state));
      await assert.rejects(readPendingNativeSharing(f.state), /Cannot safely read/);
      await assert.rejects(stageNativeSharing(f.config, false, f.stage), /Cannot safely read/);
    }
  } finally { await f.cleanup(); }
});
