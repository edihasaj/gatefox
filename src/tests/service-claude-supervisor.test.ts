import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor, type NativeProbes, type SupervisorHealing } from "../service-supervisor.js";
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

test("waking from sleep restarts the SSH tunnel only: Claude children keep their processes", { timeout: 30000 }, async () => {
  const f = await folder("gwc-wake-");
  const supervisor = new ServiceSupervisor({ version: 1, config: f.config, components: [fixtureComponent(f.directory, "tunnel", "tunnel", alive), ...claude(f.directory)] }, f.directory, 25);
  try {
    await supervisor.start(); await f.ready(["tunnel", "claude-adapter", "claude-inference"]);
    const before = await f.pids();
    supervisor.checkWake(Date.now() + 600_000);
    await until(async () => { const now = await f.pids(); return !!now.tunnel && now.tunnel !== before.tunnel; }, "the tunnel restarted");
    const after = await f.pids();
    assert.equal(after["claude-adapter"], before["claude-adapter"]); assert.equal(after["claude-inference"], before["claude-inference"]);
    assert.ok(running(before["claude-adapter"]!) && running(before["claude-inference"]!));
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

test("a busy or throwing Claude probe leaves inference and every other child running and the host reopened; an idle one restarts", { timeout: 30000 }, async () => {
  const f = await folder("gwc-guard-"); const stand = host(); const asked: number[][] = [];
  const answers: Array<() => boolean> = [() => false, () => { throw new Error("probe failed"); }, () => true];
  const supervisor = new ServiceSupervisor(sharedPlan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing, undefined,
    async pids => { asked.push(pids); return answers.shift()!(); });
  try {
    await supervisor.start(); await f.ready(["inference", "claude-adapter", "claude-inference"]);
    const before = await f.pids();

    assert.equal(await supervisor.restartWhenIdle(), false, "a busy probe refuses the restart");
    assert.equal(stand.calls.strict, 1); assert.equal(stand.calls.resumes, 1, "the host gate reopened");
    assert.equal(await signals(f.directory), 0, "inference was never asked to exit");
    assert.deepEqual(asked[0].sort(), [before["claude-adapter"]!, before["claude-inference"]!].sort(), "only the Claude children were asked about");

    assert.equal(await supervisor.restartWhenIdle(), false, "a probe that throws refuses it too, and does not reject");
    assert.equal(stand.calls.strict, 2); assert.equal(stand.calls.resumes, 2, "the host was not left quiesced");
    assert.equal(await signals(f.directory), 0);
    assert.deepEqual(await f.pids(), before, "no child was restarted by either refusal");
    assert.ok(Object.values(before).every(pid => pid === undefined || running(pid)));

    assert.equal(await supervisor.restartWhenIdle(), true, "an idle probe lets the restart through; restarting had been reset");
    assert.equal(await signals(f.directory), 1, "inference is asked once, through its own idle guard");
    await supervisor.stopped;
    assert.equal(stand.calls.closes, 1);
  } finally { await supervisor.stop(); await f.remove(); }
});

test("without a Claude child the Claude probe is never consulted", { timeout: 30000 }, async () => {
  const f = await folder("gwc-none-"); const stand = host(); let asked = 0;
  const plan = sharedPlan(f); plan.components = plan.components.filter(component => !component.kind.startsWith("claude-"));
  const supervisor = new ServiceSupervisor(plan, f.directory, 5, stand.start, unregistered, undefined, undefined, healing, undefined, async () => { asked++; return false; });
  try {
    await supervisor.start(); await f.ready(["inference"]);
    assert.equal(await supervisor.restartWhenIdle(), true);
    assert.equal(asked, 0);
  } finally { await supervisor.stop(); await f.remove(); }
});
