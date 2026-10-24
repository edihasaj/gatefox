import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor, type NativeProbes, type SupervisorHealing } from "../service-supervisor.js";
import { isClaudeComponent } from "../service-claude-activity.js";
import { serviceStatusPath, validateServicePlan, type ServiceComponent, type ServicePlan } from "../service-plan.js";
import { writePrivateJson } from "../config.js";
import { configureTelemetry, flushTelemetry } from "../telemetry.js";
import { shortFolder } from "./short-folder.js";
import { fixtureComponent, killFixtures, killFixturesAfterTests } from "./supervisor-fixture.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

killFixturesAfterTests();
isolateExecutionRoots();

const alive = "setInterval(()=>{},1000)";
async function until(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) { if (await predicate()) return; await delay(20); }
  assert.fail(`the supervisor never reached: ${what}`);
}
const running = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
type Status = Array<{ id: string; state: string; pid?: number; restarts: number; nextRestartAt?: string }>;

async function folder(prefix: string) {
  const made = await shortFolder(prefix); const directory = made.directory; const config = join(directory, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3459, clientOnly: true, stateDirectory: directory, providers: [] });
  configureTelemetry(directory, "test");
  const status = async () => (JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components as Status);
  const pids = async () => Object.fromEntries((await status()).map(value => [value.id, value.pid]));
  const ready = (ids: string[]) => until(async () => { const all = await status(); return ids.every(id => all.find(value => value.id === id)?.state === "running" && all.find(value => value.id === id)?.pid); }, `${ids.join(", ")} running`);
  const remove = async () => { await flushTelemetry(); await killFixtures(directory); await made.remove(); };
  return { directory, config, status, pids, ready, remove };
}
const claude = (directory: string, source = alive): ServiceComponent[] => [
  fixtureComponent(directory, "claude-adapter", "claude-adapter", source),
  fixtureComponent(directory, "claude-inference", "claude-inference", source),
];

test("service plans accept one Claude adapter and one private inference, with an absolute working directory", () => {
  const base = { version: 1, config: "/tmp/gateway.json" };
  const component = (id: string, kind: string, extra: object = {}) => ({ id, kind, command: "/bin/x", args: [], log: `/tmp/${id}.log`, ...extra });
  const plan = validateServicePlan({ ...base, components: [component("a", "claude-adapter", { workingDirectory: "/tmp/work" }), component("b", "claude-inference")] });
  assert.equal(plan.components[0].workingDirectory, "/tmp/work");
  assert.throws(() => validateServicePlan({ ...base, components: [component("a", "claude-adapter"), component("b", "claude-adapter")] }), /Duplicate service responsibility/);
  assert.throws(() => validateServicePlan({ ...base, components: [component("a", "claude-adapter", { workingDirectory: "relative/dir" })] }), /working directory/);
  assert.throws(() => validateServicePlan({ ...base, components: [component("a", "claude-adapter", { workingDirectory: "/tmp/a\nb" })] }), /working directory/);
  assert.throws(() => validateServicePlan({ ...base, components: [component("a", "claude-adapter", { workingDirectory: 7 })] }), /working directory/);
  assert.throws(() => validateServicePlan({ ...base, components: [component("a", "claude-bridge")] }), /Invalid or duplicate/);
});

test("Claude children start in their working directory and others in the supervisor's", { timeout: 30000 }, async () => {
  const f = await folder("gwc-cwd-");
  const work = join(f.directory, "work"); await mkdir(work);
  const note = (id: string) => `require('node:fs').writeFileSync(${JSON.stringify(join(f.directory, id + ".cwd"))}, process.cwd()); ${alive}`;
  const [adapter, inference] = [fixtureComponent(f.directory, "claude-adapter", "claude-adapter", note("claude-adapter")), fixtureComponent(f.directory, "claude-inference", "claude-inference", note("claude-inference"))];
  adapter.workingDirectory = work;
  const supervisor = new ServiceSupervisor({ version: 1, config: f.config, components: [adapter, inference] }, f.directory, 5);
  try {
    await supervisor.start(); await f.ready(["claude-adapter", "claude-inference"]);
    await until(async () => (await readFile(join(f.directory, "claude-inference.cwd"), "utf8").catch(() => "")) !== "" && (await readFile(join(f.directory, "claude-adapter.cwd"), "utf8").catch(() => "")) !== "", "both children reported their directory");
    assert.equal(await realpath(await readFile(join(f.directory, "claude-adapter.cwd"), "utf8")), await realpath(work));
    assert.equal(await realpath(await readFile(join(f.directory, "claude-inference.cwd"), "utf8")), await realpath(process.cwd()), "no workingDirectory: the supervisor's own");
  } finally { await supervisor.stop(); await f.remove(); }
});

test("a crashing Claude adapter backs off exponentially while its sibling and an unrelated inference keep running", { timeout: 30000 }, async () => {
  const f = await folder("gwc-crash-");
  const marker = JSON.stringify(join(f.directory, "adapter-starts"));
  const adapter = fixtureComponent(f.directory, "claude-adapter", "claude-adapter", `require('node:fs').appendFileSync(${marker}, Date.now() + '\\n'); process.exit(1)`);
  const inference = fixtureComponent(f.directory, "claude-inference", "claude-inference", alive);
  const supervisor = new ServiceSupervisor({ version: 1, config: f.config, components: [adapter, inference] }, f.directory, 40);
  const starts = async () => (await readFile(join(f.directory, "adapter-starts"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  try {
    await supervisor.start(); await f.ready(["claude-inference"]);
    const sibling = (await f.pids())["claude-inference"]!;
    await until(async () => (await starts()).length >= 4, "four adapter starts");
    const times = await starts();
    // Retries wait 40, 80, 160 ms (never sooner): each wait is at least the schedule, and the third is well past the first.
    assert.ok(times[1] - times[0] >= 35 && times[2] - times[1] >= 75 && times[3] - times[2] >= 155, `backoff gaps ${times.slice(1).map((time, index) => time - times[index]).join(", ")} ms`);
    const all = await f.status();
    const crashed = all.find(value => value.id === "claude-adapter")!; const other = all.find(value => value.id === "claude-inference")!;
    assert.ok(crashed.restarts >= 3 && ["waiting", "running"].includes(crashed.state), `adapter state ${crashed.state}, restarts ${crashed.restarts}`);
    assert.equal(other.state, "running"); assert.equal(other.pid, sibling, "the sibling was never restarted"); assert.equal(other.restarts, 0);
    assert.ok(running(sibling));
  } finally { await supervisor.stop(); await f.remove(); }
});

test("only the two adopted Claude tunnel ids are Claude components", () => {
  const component = (id: string, kind: ServiceComponent["kind"] = "tunnel"): ServiceComponent => ({ id, kind, command: "/bin/true", args: [], log: "/tmp/component.log" });
  assert.equal(isClaudeComponent(component("claude-inference-tunnel")), true);
  assert.equal(isClaudeComponent(component("claude-inference-studio")), true);
  assert.equal(isClaudeComponent(component("claude-inference-tunnel-copy")), false);
  assert.equal(isClaudeComponent(component("claude-adapter", "claude-adapter")), true);
});

test("waking from sleep heals ordinary gateway tunnels but preserves adopted Claude forwards", { timeout: 30000 }, async () => {
  const f = await folder("gwc-wake-");
  const adopted = ["claude-inference-tunnel", "claude-inference-studio"].map(id => fixtureComponent(f.directory, id, "tunnel", alive));
  const supervisor = new ServiceSupervisor({ version: 1, config: f.config, components: [fixtureComponent(f.directory, "tunnel", "tunnel", alive), ...adopted, ...claude(f.directory)] }, f.directory, 25);
  try {
    await supervisor.start(); await f.ready(["tunnel", "claude-inference-tunnel", "claude-inference-studio", "claude-adapter", "claude-inference"]);
    const before = await f.pids();
    supervisor.checkWake(Date.now() + 600_000);
    await until(async () => { const now = await f.pids(); return !!now.tunnel && now.tunnel !== before.tunnel; }, "the tunnel restarted");
    const after = await f.pids();
    assert.equal(after["claude-inference-tunnel"], before["claude-inference-tunnel"]);
    assert.equal(after["claude-inference-studio"], before["claude-inference-studio"]);
    assert.equal(after["claude-adapter"], before["claude-adapter"]); assert.equal(after["claude-inference"], before["claude-inference"]);
    assert.ok(running(before["claude-inference-tunnel"]!) && running(before["claude-inference-studio"]!));
  } finally { await supervisor.stop(); await f.remove(); }
});

/** A shared-executor plan: inference exits on SIGUSR2 (noting it), a relay slot, and the Claude pair. */
function sharedPlan(f: { directory: string; config: string }): ServicePlan {
  const marker = JSON.stringify(join(f.directory, "sigusr2"));
  const inference = fixtureComponent(f.directory, "inference", "inference", `process.on('SIGUSR2',()=>{require('node:fs').appendFileSync(${marker},'x');process.exit(0)}); ${alive}`);
  const relay = fixtureComponent(f.directory, "native", "native", alive);
  relay.args.push("--", "--daemon", "--codex", join(f.directory, "codex"), "--native-home", join(f.directory, "native-home"), "--relay-home", join(f.directory, "relay-home"));
  return { version: 1, config: f.config, sharedExecutors: true, components: [inference, relay, ...claude(f.directory)] };
}
const signals = async (directory: string) => (await readFile(join(directory, "sigusr2"), "utf8").catch(() => "")).length;
const unregistered: NativeProbes = { registered: async () => false, fingerprint: async () => "same", appRunning: async () => false };
const healing: Partial<SupervisorHealing> = { watchKick: () => () => {}, hostProbeMs: 3_600_000, healthSchedule: () => () => {}, releaseState: () => ({ running: "0.4.4", installed: "0.4.4" }) };
function host() {
  const calls = { strict: 0, resumes: 0, closes: 0 };
  const start = async () => ({ close: async () => { calls.closes++; }, prepareStop: async () => { calls.strict++; return true; }, prepareQuietStop: async () => ({ loadedChats: 0 }), resume: () => { calls.resumes++; } });
  return { calls, start: start as never };
}

test("a configured Claude component refuses automatic restart before host or inference side effects, including before spawn and while retrying", { timeout: 30000 }, async () => {
  const f = await folder("gwc-guard-"); const stand = host();
  const spawning = new ServiceSupervisor(sharedPlan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing);
  try {
    const starting = spawning.start();
    assert.equal(await spawning.restartWhenIdle(), false, "the configured but not-yet-spawned Claude component refuses");
    assert.equal(stand.calls.strict, 0, "the host idle gate was never closed");
    assert.equal(await signals(f.directory), 0, "inference was never asked to drain");
    await starting; await f.ready(["inference", "claude-adapter", "claude-inference"]);
    await spawning.stop(); await spawning.stopped;

    const retryPlan = sharedPlan(f);
    const index = retryPlan.components.findIndex(component => component.id === "claude-adapter");
    retryPlan.components[index] = fixtureComponent(f.directory, "claude-adapter", "claude-adapter", "process.exit(1)");
    const retrying = new ServiceSupervisor(retryPlan, f.directory, 300, stand.start, unregistered, undefined, undefined, healing);
    await retrying.start(); await f.ready(["inference", "claude-inference"]);
    await until(async () => { const adapter = (await f.status()).find(value => value.id === "claude-adapter"); return adapter?.state === "waiting" && adapter.pid === undefined; }, "a Claude retry without a pid");
    const before = await f.pids();
    assert.equal(await retrying.restartWhenIdle(), false, "a retrying Claude component with no pid still refuses");
    assert.equal(stand.calls.strict, 0, "no automatic attempt quiesced the host");
    assert.equal(await signals(f.directory), 0, "no automatic attempt signalled inference");
    assert.deepEqual(await f.pids(), before, "the refusal did not replay inference or other children");

    await retrying.stop(); await retrying.stopped;
    assert.ok(!running(before.inference!), "an explicit operator stop still stops the owned inference");
  } finally { await spawning.stop(); await f.remove(); }
});

test("without a Claude component, an automatic restart still proceeds", { timeout: 30000 }, async () => {
  const f = await folder("gwc-none-"); const stand = host();
  const plan = sharedPlan(f); plan.components = plan.components.filter(component => !component.kind.startsWith("claude-"));
  const supervisor = new ServiceSupervisor(plan, f.directory, 5, stand.start, unregistered, undefined, undefined, healing);
  try {
    await supervisor.start(); await f.ready(["inference"]);
    assert.equal(await supervisor.restartWhenIdle(), true);
  } finally { await supervisor.stop(); await f.remove(); }
});

test("an adopted reverse Claude forward skips generic cleanup and retries with its saved argv", { timeout: 30000 }, async () => {
  const f = await folder("gwc-claude-reverse-"); let cleanupCalls = 0;
  const inference = fixtureComponent(f.directory, "inference", "inference", alive);
  const forward: ServiceComponent = {
    id: "claude-inference-studio", kind: "tunnel", command: "/usr/bin/ssh",
    args: ["-G", "-N", "-T", "-R", "127.0.0.1:3468:127.0.0.1:3468", "localhost"], log: join(f.directory, "claude-inference-studio.log"),
  };
  const plan: ServicePlan = { version: 1, config: f.config, components: [inference, forward] };
  const saved = JSON.stringify(plan);
  const supervisor = new ServiceSupervisor(plan, f.directory, 25, undefined, undefined, undefined, undefined, {}, undefined, async () => { cleanupCalls++; return 0; });
  try {
    await supervisor.start(); await f.ready(["inference"]);
    await until(async () => ((await f.status()).find(value => value.id === forward.id)?.restarts ?? 0) >= 1, "the adopted reverse forward to retry after exit");
    const pids = await f.pids();
    assert.equal(cleanupCalls, 0, "the adopted forward never ran a generic remote listener cleanup command");
    assert.equal(JSON.stringify(plan), saved, "retries use the exact saved forward arguments");
    assert.equal(pids.inference, (await f.status()).find(value => value.id === "inference")?.pid, "a forward retry did not replay inference");
  } finally { await supervisor.stop(); await f.remove(); }
});
