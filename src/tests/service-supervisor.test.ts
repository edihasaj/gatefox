import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor } from "../service-supervisor.js";
import { readServicePlan, validateServicePlan, serviceStatusPath, type ServiceComponent } from "../service-plan.js";
import { writePrivateJson } from "../config.js";

// Waits up to a minute: a state that is never reached fails the test, and a loaded machine (children are processes) fails nothing.
async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt++) { if (await predicate()) return; await delay(20); }
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

test("a child that exits is restarted after its backoff, and shutdown cancels the retry that is pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-retry-")); const starts = join(directory, "starts");
  // A child that exists, notes each start by appending one byte, and exits at once.
  const child = component(directory, "native", "native", `require('node:fs').appendFileSync(${JSON.stringify(starts)}, 'x'); process.exit(1)`);
  const supervisor = new ServiceSupervisor({ version: 1, config: join(directory, "config.json"), components: [child] }, directory, 400);
  const status = async () => JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components[0] as { state: string; restarts: number; nextRestartAt?: string };
  const started = async () => (await readFile(starts, "utf8").catch(() => "")).length;
  await supervisor.start();
  // It exited once and waits for its backoff; the status says when the retry is due.
  let due = 0;
  await until(async () => { const current = await status(); if (current.state === "waiting" && current.nextRestartAt) due = Date.parse(current.nextRestartAt); return due > 0; });
  await supervisor.stop();
  // Whatever a loaded machine let run before stop(), the count at stop() is the baseline: no start may follow, past the due time and 500 ms more.
  const baseline = await started();
  assert.ok(baseline >= 1, "the child ran");
  await delay(Math.max(0, due + 500 - Date.now()));
  assert.equal(await started(), baseline, "no retry after shutdown");
  const stopped = await status(); assert.equal(stopped.state, "stopped"); assert.equal(stopped.nextRestartAt, undefined);
});

test("a missing child executable waits for its backoff and shutdown stops it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-missing-"));
  const child = component(directory, "native", "native", ""); child.command = join(directory, "absent");
  const supervisor = new ServiceSupervisor({ version: 1, config: join(directory, "config.json"), components: [child] }, directory, 100);
  await supervisor.start();
  await until(async () => JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components[0].state === "waiting");
  await supervisor.stop();
  const stopped = JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components[0];
  assert.equal(stopped.state, "stopped"); assert.ok(stopped.restarts >= 1, "the missing executable was retried with a backoff");
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
  // The supervisor sizes the inference grace from its own drain setting, which the child inherits.
  assert.throws(() => validateServicePlan({ version: 1, config: join(directory, "config.json"), components: [{ ...definition, environment: { GATEWAY_SHUTDOWN_DRAIN_MS: "30000" } }] }), /environment/);
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

test("waking from sleep restarts tunnels at once and leaves other components alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-wake-"));
  const supervisor = new ServiceSupervisor({ version: 1, config: join(directory, "config.json"), components: [
    component(directory, "tunnel", "tunnel", "setInterval(()=>{},1000)"),
    component(directory, "native", "native", "setInterval(()=>{},1000)"),
  ] }, directory, 25);
  const read = async () => JSON.parse(await readFile(serviceStatusPath(directory), "utf8")) as { components: Array<{ id: string; pid?: number; state: string }> };
  try {
    await supervisor.start();
    await until(async () => (await read()).components.every(value => value.state === "running"));
    const before = (await read()).components;
    supervisor.checkWake(Date.now() + 10_000); // an ordinary tick changes nothing
    supervisor.checkWake(Date.now() + 600_000); // ten minutes of sleep
    await until(async () => { const tunnel = (await read()).components.find(value => value.id === "tunnel"); return !!tunnel?.pid && tunnel.pid !== before.find(value => value.id === "tunnel")?.pid; });
    assert.equal((await read()).components.find(value => value.id === "native")?.pid, before.find(value => value.id === "native")?.pid);
  } finally { await supervisor.stop(); }
});

test("inference gets its drain on top of the grace while a tunnel is still killed at 2.5 s", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-drain-"));
  process.env.GATEWAY_SHUTDOWN_DRAIN_MS = "1000";
  const supervisor = new ServiceSupervisor({ version: 1, config: join(directory, "config.json"), components: [
    component(directory, "inference", "inference", "process.on('SIGTERM',()=>setTimeout(()=>{console.log('DRAINED');process.exit(0)},3000)); console.log('READY'); setInterval(()=>{},1000)"),
    component(directory, "tunnel", "tunnel", "process.on('SIGTERM',()=>{}); console.log('READY'); setInterval(()=>{},1000)"),
  ] }, directory, 25);
  const ready = async (id: string) => (await readFile(join(directory, id + ".log"), "utf8").catch(() => "")).includes("READY");
  try {
    await supervisor.start(); await until(async () => await ready("inference") && await ready("tunnel"));
    const pids = Object.fromEntries((JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components as Array<{ id: string; pid: number }>).map(value => [value.id, value.pid]));
    const started = Date.now(); const ended: Record<string, number> = {};
    const watch = setInterval(() => { for (const [id, pid] of Object.entries(pids)) if (!(id in ended) && !live(pid)) ended[id] = Date.now() - started; }, 20);
    try { await supervisor.stop(); await delay(40); } finally { clearInterval(watch); }
    assert.ok(ended.tunnel >= 2400 && ended.tunnel < 3200, `a tunnel that ignores SIGTERM is killed at 2.5 s (${ended.tunnel} ms)`);
    assert.ok(ended.inference >= 2900, `inference was not killed before drain + 2.5 s (${ended.inference} ms)`);
    assert.match(await readFile(join(directory, "inference.log"), "utf8"), /DRAINED/, "inference exited on its own");
  } finally { delete process.env.GATEWAY_SHUTDOWN_DRAIN_MS; await supervisor.stop(); }
});

test("the shared execution host closes only after inference has drained", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-order-"));
  const config = join(directory, "config.json");
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: directory, providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_SUPERVISOR_FIXTURE_KEY", models: { fixture: "upstream" } }] });
  const native = component(directory, "native", "native", "setInterval(()=>{},1000)");
  native.args = [...native.args, "--codex", join(directory, "codex"), "--native-home", join(directory, "native-home")];
  let inferencePid = 0; let closed: { atMs: number; inferenceRunning: boolean } | undefined; let started = 0;
  const host = async () => ({ close: async () => { closed = { atMs: Date.now() - started, inferenceRunning: live(inferencePid) }; }, prepareStop: async () => true, resume: () => {} });
  const supervisor = new ServiceSupervisor({ version: 1, config, sharedExecutors: true, components: [
    component(directory, "inference", "inference", "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),600)); console.log('READY'); setInterval(()=>{},1000)"), native,
  ] }, directory, 5, host as never);
  const read = async () => JSON.parse(await readFile(serviceStatusPath(directory), "utf8")) as { executionHost?: { state: string }; components: Array<{ id: string; pid?: number; state: string }> };
  try {
    await supervisor.start();
    await until(async () => (await read()).executionHost?.state === "running" && (await readFile(join(directory, "inference.log"), "utf8").catch(() => "")).includes("READY"));
    inferencePid = (await read()).components.find(value => value.id === "inference")!.pid!;
    started = Date.now(); await supervisor.stop();
    assert.ok(closed, "the host was closed");
    assert.equal(closed.inferenceRunning, false, "inference finished before its local clients were closed");
    assert.ok(closed.atMs >= 550, `the host waited for the inference drain (${closed.atMs} ms)`);
  } finally { await supervisor.stop(); }
});

test("a stopped supervisor exits at once instead of waiting out the inference grace", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-exit-"));
  const plan = { version: 1, config: join(directory, "config.json"), components: [component(directory, "inference", "inference", "setInterval(()=>{},1000)")] };
  const script = `import { ServiceSupervisor } from ${JSON.stringify(new URL("../service-supervisor.js", import.meta.url).href)};
    const supervisor = new ServiceSupervisor(${JSON.stringify(plan)}, ${JSON.stringify(directory)}, 25);
    await supervisor.start(); await new Promise(resolve => setTimeout(resolve, 300)); await supervisor.stop(); console.log("STOPPED");`;
  const { GATEWAY_SHUTDOWN_DRAIN_MS: _drain, ...env } = process.env;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "inherit"] });
  let stoppedAt = 0; child.stdout!.on("data", chunk => { if (String(chunk).includes("STOPPED")) stoppedAt = Date.now(); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0); assert.ok(stoppedAt, "the supervisor stopped");
  assert.ok(Date.now() - stoppedAt < 1500, `no grace timer keeps the stopped service alive (${Date.now() - stoppedAt} ms)`);
});

test("a wake during a slot's start never spawns a second process for it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-supervisor-start-once-"));
  const marker = join(directory, "starts");
  const supervisor = new ServiceSupervisor({ version: 1, config: join(directory, "config.json"), components: [
    component(directory, "tunnel", "tunnel", `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x'); setInterval(()=>{},1000)`),
  ] }, directory, 25);
  const internals = supervisor as unknown as { slots: Array<{ child?: unknown; timer?: NodeJS.Timeout }>; startSlot(slot: unknown): Promise<void> };
  try {
    const slot = internals.slots[0]!;
    // Two starts racing (a restart timer and a wake) start the component once.
    await Promise.all([internals.startSlot(slot), internals.startSlot(slot), (async () => { supervisor.checkWake(Date.now() + 600_000); })()]);
    await until(async () => (await readFile(marker, "utf8").catch(() => "")).length >= 1);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await readFile(marker, "utf8"), "x");
  } finally { await supervisor.stop(); }
});
