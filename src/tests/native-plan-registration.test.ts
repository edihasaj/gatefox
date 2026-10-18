import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writePrivateJson } from "../config.js";
import { macNative } from "../mac-native.js";
import { nativeRelayHome } from "../native-control.js";
import { nativeRegistrationPath } from "../native-pause.js";
import { registerPlanRelay, relayCheck, type PlanRelayDeps } from "../native-plan-registration.js";
import { servicePlanPath, type ServicePlan } from "../service-plan.js";
import { sshControlHome } from "../ssh-socket.js";

/**
 * A consolidated Mac whose relay slot waits as `not_registered`: a unified plan with a native component, and a fake relay
 * that answers `--check` the way the given scenario says. The relay home lies under the test HOME's relay root.
 */
async function fixture(check: "ready" | "refused" | "no-machine" = "ready") {
  const directory = await mkdtemp(join(tmpdir(), "gw-plan-relay-")); const state = join(directory, "state"); await mkdir(state, { mode: 0o700 });
  const configPath = join(directory, "gateway.json"), nativeHome = join(directory, "native"), codex = join(directory, "codex");
  await writePrivateJson(configPath, { version: 1, port: 3457, stateDirectory: state, clientOnly: true, providers: [] });
  const relayHome = join(dirname(nativeRelayHome(configPath, nativeHome)), "relay-under-test");
  const calls = join(directory, "relay-calls.jsonl"), relay = join(directory, "gateway-native-relay");
  const answer = { ready: `console.log(JSON.stringify({ready:true,existingMachine:true,environmentId:"env",installationId:"id"}));`,
    "no-machine": `console.log(JSON.stringify({ready:true,existingMachine:false}));`, refused: `process.exit(1);` }[check];
  await writeFile(relay, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');\n${answer}\n`, { mode: 0o700 });
  const args = ["--native-home", nativeHome, "--relay-home", relayHome, "--gateway", "/usr/bin/true", "--gateway-config", configPath, "--codex", codex, "--daemon"];
  const plan: ServicePlan = { version: 1, config: configPath, components: [
    { id: "inference", kind: "inference", command: "/usr/bin/true", args: [], log: join(directory, "inference.log") },
    { id: "native", kind: "native", command: relay, args, log: join(directory, "native.log") }] };
  const relayCalls = async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
  const receipt = () => readFile(nativeRegistrationPath(state), "utf8").then(text => JSON.parse(text), () => undefined);
  return { directory, state, configPath, nativeHome, codex, relayHome, relay, args, plan, relayCalls, receipt, clean: () => rm(directory, { recursive: true, force: true }) };
}
const order: string[] = [];
const deps = (overrides: Partial<PlanRelayDeps> = {}): PlanRelayDeps => ({
  appRunning: async () => { order.push("app"); return false; },
  check: async (binary, args) => { order.push("check"); await relayCheck(binary, args); },
  enable: async () => { order.push("enable"); },
  clearHolders: async () => { order.push("clear"); return 0; }, ...overrides });

test("install under a unified plan registers the plan's own relay after its check and connection", async () => {
  const f = await fixture(); order.length = 0;
  try {
    const result = await registerPlanRelay(f.state, f.plan, deps({ enable: async (binary, args) => { order.push("enable"); assert.equal(binary, f.relay); assert.deepEqual(args, f.args.filter(arg => arg !== "--daemon")); assert.equal(await f.receipt(), undefined, "nothing is written before the relay connected"); } }));
    assert.deepEqual(order, ["app", "check", "clear", "enable"]);
    assert.deepEqual(await f.relayCalls(), [[...f.args.filter(arg => arg !== "--daemon"), "--check"]], "the check runs the plan's relay with the plan's own homes and CLI, not as a daemon");
    assert.deepEqual(await f.receipt(), { registered: true, home: f.relayHome, nativeHome: f.nativeHome, codex: f.codex });
    assert.equal(result.registered, true); assert.equal(result.relayHome, f.relayHome); assert.match(String(result.next), /gateway service restart/);
    // Running it again changes nothing and asks nothing.
    order.length = 0;
    assert.equal((await registerPlanRelay(f.state, f.plan, deps())).unchanged, true); assert.deepEqual(order, []);
  } finally { await f.clean(); }
});

test("a missing or disabled Codex Desktop registration, or a check that finds no existing machine, registers nothing", async () => {
  for (const check of ["refused", "no-machine"] as const) {
    const f = await fixture(check); order.length = 0;
    try {
      await assert.rejects(registerPlanRelay(f.state, f.plan, deps()), /never enrolls a new machine, and nothing was registered/);
      assert.deepEqual(order, ["app", "check"], `${check}: the relay never connected`);
      assert.equal(await f.receipt(), undefined);
    } finally { await f.clean(); }
  }
});

test("an open ChatGPT app, a failed connection or a plan the service would not run registers nothing", async () => {
  const f = await fixture(); order.length = 0;
  try {
    await assert.rejects(registerPlanRelay(f.state, f.plan, deps({ appRunning: async () => true })), /Quit ChatGPT normally/);
    assert.deepEqual(await f.relayCalls(), [], "nothing ran beside the app");
    await assert.rejects(registerPlanRelay(f.state, f.plan, deps({ enable: async () => { throw new Error("Native relay did not connect within 45 seconds"); } })), /did not connect/);
    assert.equal(await f.receipt(), undefined);
    const native = f.plan.components[1]!;
    const variants: [ServicePlan, RegExp][] = [
      [{ ...f.plan, components: [f.plan.components[0]!] }, /no native relay component/],
      [{ ...f.plan, components: [f.plan.components[0]!, { ...native, args: native.args.filter(arg => arg !== "--daemon") }] }, /not its daemon/],
      [{ ...f.plan, components: [f.plan.components[0]!, { ...native, args: native.args.map(arg => arg === f.relayHome ? join(f.directory, "elsewhere") : arg) }] }, /outside the gateway's relay folder/],
      [{ ...f.plan, components: [f.plan.components[0]!, { ...native, args: native.args.map(arg => arg === f.codex ? "codex" : arg) }] }, /one absolute --codex/],
    ];
    for (const [plan, refusal] of variants) await assert.rejects(registerPlanRelay(f.state, plan, deps()), refusal);
    assert.equal(await f.receipt(), undefined);
  } finally { await f.clean(); }
});

/** Every side effect of a unified-plan install replaced, so these tests can reach no process, ChatGPT, launchd or `ps`. */
const noProcesses = (overrides: Partial<PlanRelayDeps> = {}): Partial<PlanRelayDeps> => ({ appRunning: async () => false, check: async () => {}, enable: async () => {}, ...overrides });
const lstart = (at: number) => { const d = new Date(at); const p = (n: number) => String(n).padStart(2, "0"); return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${String(d.getDate()).padStart(2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`; };

test("gateway native install under a unified plan reaches the registration with an open ChatGPT app, and registers nothing", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  const f = await fixture("refused");
  try {
    await writePrivateJson(servicePlanPath(f.state), f.plan);
    await assert.rejects(macNative("install", f.configPath, { planDeps: noProcesses({ appRunning: async () => true }) }), (error: Error) => /Quit ChatGPT normally/.test(error.message) && !/owned by the unified service/.test(error.message));
    await assert.rejects(macNative("install", f.configPath, { planDeps: noProcesses({ check: async () => { throw new Error("The native relay check failed: nothing was registered"); } }) }), /nothing was registered/);
    assert.equal(await f.receipt(), undefined);
    // A registered Mac can still uninstall under the plan (see below); anything else the plan owns stays refused.
    await assert.rejects(macNative("bogus", f.configPath), /Choose gateway native install, status, or uninstall/);
  } finally { await f.clean(); }
});

test("macNative hands the SSH control home and the config path to the holder check, then registers", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await writePrivateJson(servicePlanPath(f.state), f.plan);
    const sshHome = sshControlHome(f.configPath, f.nativeHome);
    const started = Math.floor((Date.now() - 3_600_000) / 1000) * 1000; const alive = new Set([100, 101]); const asked: Array<[string, number]> = []; const signalled: number[] = [];
    const snapshot = [`   100      1 ${lstart(started)} /usr/bin/node /g/cli.js codex-shim --config ${f.configPath} --codex ${f.codex} --ssh -- app-server --listen unix://`,
      `   101    100 ${lstart(started)} ${f.codex} app-server --listen stdio://`].join("\n");
    const result = await macNative("install", f.configPath, { nativeHome: f.nativeHome, planDeps: noProcesses(), holderDeps: {
      snapshot: async () => snapshot, activity: async (home, pid) => { asked.push([home, pid]); return { pid, startedAt: started + 300, busy: false }; },
      signal: pid => { signalled.push(pid); alive.clear(); }, alive: pid => alive.has(pid), stopWaitMs: 1000, hostWaitMs: 1000, pollMs: 10 } });
    assert.deepEqual(asked, [[sshHome, 100]], "the activity record is read from the SSH control home of this config and native home");
    assert.deepEqual(signalled, [100]);
    assert.equal(result.registered, true);
    assert.deepEqual(await f.receipt(), { registered: true, home: f.relayHome, nativeHome: f.nativeHome, codex: f.codex });
  } finally { await f.clean(); }
});

test("macNative refuses while a listener is busy: nothing is signalled, registered or left pending", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await writePrivateJson(servicePlanPath(f.state), f.plan);
    const started = Math.floor((Date.now() - 3_600_000) / 1000) * 1000; const signalled: number[] = [];
    const snapshot = [`   100      1 ${lstart(started)} /usr/bin/node /g/cli.js codex-shim --config ${f.configPath} --codex ${f.codex} --ssh -- app-server --listen unix://`, `   101    100 ${lstart(started)} ${f.codex} app-server --listen stdio://`].join("\n");
    await assert.rejects(macNative("install", f.configPath, { nativeHome: f.nativeHome, planDeps: noProcesses(), holderDeps: {
      snapshot: async () => snapshot, activity: async pid => ({ pid: 100, startedAt: started, busy: true }), signal: pid => { signalled.push(pid); }, alive: () => true, stopWaitMs: 100, hostWaitMs: 100, pollMs: 10 } }), /retry when it is idle/);
    assert.deepEqual(signalled, []); assert.equal(await f.receipt(), undefined);
    assert.equal(await readFile(join(f.state, "native-registration.pending"), "utf8").catch(() => undefined), undefined);
  } finally { await f.clean(); }
});

test("gateway native uninstall under a unified plan is the way out: it unregisters, keeps a backup and refuses nothing", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await writePrivateJson(servicePlanPath(f.state), f.plan);
    await writePrivateJson(nativeRegistrationPath(f.state), { registered: true, home: f.relayHome, nativeHome: f.nativeHome, codex: f.codex });
    const result = await macNative("uninstall", f.configPath);
    assert.equal(result.registered, false);
    assert.deepEqual(await f.receipt(), { registered: false });
    const backups = (await readdir(f.state)).filter(name => name.startsWith("native-registration.json.pre-relay-off-"));
    assert.equal(backups.length, 1);
    assert.equal(JSON.parse(await readFile(join(f.state, backups[0]), "utf8")).registered, true, "the backup holds the registration it replaced");
  } finally { await f.clean(); }
});
