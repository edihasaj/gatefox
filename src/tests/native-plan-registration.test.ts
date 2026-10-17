import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writePrivateJson } from "../config.js";
import { macNative } from "../mac-native.js";
import { nativeRelayHome } from "../native-control.js";
import { nativeRegistrationPath } from "../native-pause.js";
import { registerPlanRelay, relayCheck, type PlanRelayDeps } from "../native-plan-registration.js";
import { servicePlanPath, type ServicePlan } from "../service-plan.js";

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

test("gateway native install under a unified plan reaches the registration, while uninstall stays refused", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  const f = await fixture("refused");
  try {
    await writePrivateJson(servicePlanPath(f.state), f.plan);
    // Either this Mac's ChatGPT is open, or the fake relay's check refuses: both are the registration path, not the old refusal.
    await assert.rejects(macNative("install", f.configPath), (error: Error) => /Quit ChatGPT normally|nothing was registered/.test(error.message) && !/owned by the unified service/.test(error.message));
    await assert.rejects(macNative("uninstall", f.configPath), /owned by the unified service/);
    assert.equal(await f.receipt(), undefined);
  } finally { await f.clean(); }
});
