import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startServeRuntime } from "../serve-runtime.js";
import { readMaintenanceStatus } from "../model-auto-latest/maintenance-status.js";
import { maintenancePath } from "../model-auto-latest/state.js";
import { ServiceSupervisor } from "../service-supervisor.js";

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 1000; attempt++) { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error("maintenance condition was not observed");
}

test("the real server runtime owns one live timer, hot-swap replaces its instance, and socket close stops it", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-single-runtime-")); const config = join(root, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: 0, stateDirectory: join(root, "state"), providers: [{ id: "fixture", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "UNUSED_FIXTURE_KEY", models: { "fixture/model": "gpt-6-sol" } }] }), { mode: 0o600 });
  const agents = join(homedir(), "Library/LaunchAgents"); await mkdir(agents, { recursive: true, mode: 0o700 });
  const before = await readdir(agents);
  const beat = async (): Promise<{ instance?: string; owner?: string; state?: string }> => JSON.parse(await readFile(await maintenancePath(config), "utf8").catch(() => "{}"));
  const first = await startServeRuntime(config); let next: Awaited<ReturnType<typeof startServeRuntime>> | undefined;
  try {
    await until(() => readMaintenanceStatus(config), value => value.scheduled);
    const original = await beat(); assert.equal(original.owner, "server"); assert.equal(original.state, "active");
    next = await startServeRuntime(config, undefined, first.server, first.runtime);
    const current = await until(beat, value => Boolean(value.instance && value.instance !== original.instance && value.state === "active"));
    await first.runtime.stop(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await beat()).instance, current.instance); assert.equal((await readMaintenanceStatus(config)).scheduled, true);
    assert.deepEqual(await readdir(agents), before, "runtime starts and hot swaps must not register another LaunchAgent");
  } finally {
    first.server.closeAllConnections(); await new Promise<void>(resolve => first.server.close(() => resolve()));
    await until(() => readMaintenanceStatus(config), value => !value.scheduled);
    assert.equal((await beat()).state, "stopped");
    await next?.runtime.stop(); await first.runtime.stop();
  }
});

test("a client-only supervisor owns maintenance, but a supervisor with an inference child never duplicates it", async () => {
  for (const inference of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "gateway-single-supervisor-")); const config = join(root, "gateway.json"); const state = join(root, "state");
    await mkdir(state, { mode: 0o700 });
    await writeFile(config, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, clientOnly: true, providers: [] }), { mode: 0o600 });
    const supervisor = new ServiceSupervisor({ version: 1, config, components: inference ? [{ id: "inference", kind: "inference", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], log: join(root, "inference.log") }] : [] }, state);
    try {
      await supervisor.start();
      if (inference) {
        await new Promise(resolve => setTimeout(resolve, 75));
        assert.equal((await readMaintenanceStatus(config)).scheduled, false);
      } else {
        await until(() => readMaintenanceStatus(config), value => value.scheduled);
        assert.equal(JSON.parse(await readFile(await maintenancePath(config), "utf8")).owner, "service");
      }
    } finally {
      await supervisor.stop();
      await until(() => readMaintenanceStatus(config), value => !value.scheduled);
    }
  }
});

test("a supervisor stopped while startup awaits its updater never publishes a late maintenance owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-single-stop-")); const config = join(root, "gateway.json"); const state = join(root, "state");
  await mkdir(state, { mode: 0o700 });
  await writeFile(config, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, clientOnly: true, providers: [] }), { mode: 0o600 });
  const supervisor = new ServiceSupervisor({ version: 1, config, components: [] }, state);
  const starting = supervisor.start(); await supervisor.stop(); await starting;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await readMaintenanceStatus(config)).scheduled, false);
});
