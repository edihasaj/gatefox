import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor } from "../service-supervisor.js";
import { readServicePlan, validateServicePlan, serviceStatusPath, type ServiceComponent } from "../service-plan.js";
import { writePrivateJson } from "../config.js";

async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (await predicate()) return; await delay(20); }
  assert.fail("Service did not reach the expected state");
}
function component(directory: string, id: string, kind: ServiceComponent["kind"], source: string): ServiceComponent {
  return { id, kind, command: process.execPath, args: ["-e", source], log: join(directory, id + ".log") };
}
function live(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

test("one failed child restarts without replacing another child or rerunning the login hook", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-")); const statusFile = serviceStatusPath(directory);
  const supervisor = new ServiceSupervisor({ version: 1, config: join(directory, "config.json"), components: [
    component(directory, "tunnel", "tunnel", "setInterval(()=>{},1000)"),
    component(directory, "native", "native", "setInterval(()=>{},1000)"),
    component(directory, "desktop", "desktop", "console.log('LOGIN_ONCE')"),
  ] }, directory, 25);
  const read = async () => JSON.parse(await readFile(statusFile, "utf8")) as { components: Array<{ id: string; pid?: number; state: string; restarts: number }> };
  let owned: number[] = [];
  try {
    await supervisor.start();
    await until(async () => (await read()).components.every(value => value.id === "desktop" ? value.state === "complete" : value.state === "running"));
    const before = (await read()).components; owned = before.flatMap(value => value.pid ? [value.pid] : []);
    process.kill(before.find(value => value.id === "tunnel")!.pid!, "SIGKILL");
    await until(async () => { const after = (await read()).components; return !!after.find(value => value.id === "tunnel")?.pid && after.find(value => value.id === "tunnel")?.pid !== before.find(value => value.id === "tunnel")?.pid; });
    const after = (await read()).components;
    assert.equal(after.find(value => value.id === "native")?.pid, before.find(value => value.id === "native")?.pid);
    assert.equal(after.find(value => value.id === "tunnel")?.restarts, 1);
    assert.equal((await readFile(join(directory, "desktop.log"), "utf8")).trim(), "LOGIN_ONCE");
    owned.push(after.find(value => value.id === "tunnel")!.pid!);
  } finally { await supervisor.stop(); }
  assert.ok(owned.every(pid => !live(pid)), "shutdown leaves no owned children");
  assert.ok((await read()).components.every(value => value.state === "stopped"));
});

test("missing child executable backs off and shutdown cancels the retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-missing-"));
  const child = component(directory, "native", "native", ""); child.command = join(directory, "absent");
  const supervisor = new ServiceSupervisor({ version: 1, config: join(directory, "config.json"), components: [child] }, directory, 100);
  await supervisor.start();
  await until(async () => JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components[0].state === "waiting");
  await supervisor.stop(); await delay(150);
  const status = JSON.parse(await readFile(serviceStatusPath(directory), "utf8"));
  assert.equal(status.components[0].state, "stopped"); assert.equal(status.components[0].restarts, 1);
});

test("idle restart waits for the inference child to accept its own idle guard", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-idle-"));
  const supervisor = new ServiceSupervisor({ version: 1, config: join(directory, "config.json"), components: [
    component(directory, "inference", "inference", "process.on('SIGUSR2',()=>process.exit(0)); console.log('READY'); setInterval(()=>{},1000)"),
    component(directory, "tunnel", "tunnel", "setInterval(()=>{},1000)"),
  ] }, directory, 25);
  try {
    await supervisor.start(); await until(async () => (await readFile(join(directory, "inference.log"), "utf8")).includes("READY"));
    assert.equal(await supervisor.restartWhenIdle(), true);
    assert.ok(JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components.every((value: { state: string }) => value.state === "stopped"));
  } finally { await supervisor.stop(); }
});

test("service plans reject duplicates, credential environment overrides, and public permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-plan-"));
  const definition = component(directory, "inference", "inference", "");
  assert.throws(() => validateServicePlan({ version: 1, config: join(directory, "config.json"), components: [definition, { ...definition, id: "second" }] }), /Duplicate/);
  assert.throws(() => validateServicePlan({ version: 1, config: join(directory, "config.json"), components: [{ ...definition, environment: { API_KEY: "must-not-be-copied" } }] }), /environment/);
  await writePrivateJson(join(directory, "service-plan.json"), { version: 1, config: join(directory, "config.json"), components: [definition] });
  assert.equal((await readServicePlan(directory))?.components.length, 1);
  const publicState = await mkdtemp(join(tmpdir(), "gateway-plan-public-"));
  await writeFile(join(publicState, "service-plan.json"), "{}", { mode: 0o644 });
  await chmod(join(publicState, "service-plan.json"), 0o644);
  await assert.rejects(readServicePlan(publicState), /private file/);
});

test("an inference child that refuses idle restart keeps the relay and its own process", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-busy-"));
  const supervisor = new ServiceSupervisor({ version: 1, config: join(directory, "config.json"), components: [
    component(directory, "inference", "inference", "process.on('SIGUSR2',()=>{}); console.log('BUSY_READY'); setInterval(()=>{},1000)"),
    component(directory, "native", "native", "setInterval(()=>{},1000)"),
  ] }, directory, 25);
  try {
    await supervisor.start(); await until(async () => (await readFile(join(directory, "inference.log"), "utf8")).includes("BUSY_READY"));
    const before = JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components;
    assert.equal(await supervisor.restartWhenIdle(), false);
    assert.deepEqual(JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components, before);
    assert.ok(before.every((value: { pid: number }) => live(value.pid)));
  } finally { await supervisor.stop(); }
});

test("a failed shared execution host leaves inference and tunnels running and retries the host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-host-"));
  const config = join(directory, "config.json");
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: directory, providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_SUPERVISOR_FIXTURE_KEY", models: { fixture: "upstream" } }] });
  const native = component(directory, "native", "native", "setInterval(()=>{},1000)");
  native.args = [...native.args, "--codex", join(directory, "codex"), "--native-home", join(directory, "native-home")];
  let attempts = 0;
  const host = async () => {
    attempts++;
    if (attempts === 1) throw new Error("Bundled SDK version changed");
    return { close: async () => {}, prepareStop: async () => true, resume: () => {} };
  };
  const supervisor = new ServiceSupervisor({ version: 1, config, sharedExecutors: true, components: [
    component(directory, "inference", "inference", "setInterval(()=>{},1000)"),
    component(directory, "tunnel", "tunnel", "setInterval(()=>{},1000)"), native,
  ] }, directory, 5, host as never);
  const read = async () => JSON.parse(await readFile(serviceStatusPath(directory), "utf8")) as { executionHost?: { state: string }; components: Array<{ state: string }> };
  try {
    await supervisor.start();
    await until(async () => (await read()).components.every(value => value.state === "running"));
    await until(async () => (await read()).executionHost?.state === "running");
    assert.equal(attempts, 2, "the host is retried after its first failure");
  } finally { await supervisor.stop(); }
});
