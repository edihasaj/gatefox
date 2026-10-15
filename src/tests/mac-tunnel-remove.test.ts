import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { macTunnel } from "../mac-tunnel.js";
import { removeTunnelComponent } from "../mac-tunnel-remove.js";
import { readServicePlan, servicePlanPath, type ServicePlan } from "../service-plan.js";
import { writePrivateJson } from "../config.js";
import { withPrivateFileLock } from "../private-file-lock.js";

const bind = async (server: { once(event: "error", cb: () => void): unknown; listen(port: number, host: string, cb: () => void): unknown }): Promise<boolean> =>
  new Promise(done => { server.once("error", () => done(false)); server.listen(0, "127.0.0.1", () => done(true)); });

/** A port with nothing behind it; sandboxes that forbid sockets get a random one. */
async function unusedPort(): Promise<number> {
  const server = createNetServer();
  if (await bind(server)) { const port = (server.address() as { port: number }).port; await new Promise(done => server.close(done)); return port; }
  return 41000 + Math.floor(Math.random() * 1000);
}

interface Health { port: number; stop(): Promise<void> }
/** The gateway's /health listener. `null` means no inference listener answers at all. */
async function health(body: Record<string, unknown> | null): Promise<Health> {
  if (body === null) return { port: await unusedPort(), stop: async () => {} };
  const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); });
  if (await bind(server)) return { port: (server.address() as { port: number }).port, stop: () => new Promise(done => server.close(() => done())) };
  const port = await unusedPort(); const real = globalThis.fetch;
  globalThis.fetch = (input, init) => new URL(String(input)).port === String(port)
    ? Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })) : real(input as never, init as never);
  return { port, stop: async () => { globalThis.fetch = real; } };
}

const none = async () => "";
const running = async () => "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n";
const forward = "127.0.0.1:18301:127.0.0.1:18300";
const sparkArgs = (...forwards: string[]) => ["-N", "-T", ...forwards, "qwen-spark"];
const ids = (plan: ServicePlan | undefined) => plan!.components.map(component => component.id);
const noBackups = async (state: string) => assert.ok(!(await readdir(state)).includes("service-backups"), "nothing was backed up");
const api = (baseUrl: string) => ({ id: "spark_api", type: "responses-api", baseUrl, apiKeyEnv: "SPARK_API_KEY", models: { spark: "spark" } });

/** A plan with inference, the tunnel under test, and a reverse tunnel that must survive. */
async function fixture(answer: Record<string, unknown> | null, provider?: Record<string, unknown>, forwards = ["-L", forward]) {
  const root = await mkdtemp(join(tmpdir(), "gw-tunnel-remove-")); const state = join(root, "state"); await mkdir(state, { recursive: true, mode: 0o700 });
  const listener = await health(answer); const config = join(root, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: listener.port, stateDirectory: state,
    providers: [{ id: "claude", type: "claude-subscription", models: { claude: "claude" } }, ...(provider ? [provider] : [])] }));
  const tunnel = (id: string, args: string[]) => ({ id, kind: "tunnel" as const, command: "/usr/bin/ssh", args, log: join(state, `${id}.log`) });
  const plan: ServicePlan = { version: 1, config, sharedExecutors: true, components: [
    { id: "inference", kind: "inference", command: "/bin/true", args: [], log: join(state, "inference.log") },
    { id: "desktop", kind: "desktop", command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", args: ["--app", "/Applications/ChatGPT.app"], log: join(state, "desktop.log") },
    tunnel("tunnel-spark", sparkArgs(...forwards)),
    tunnel("tunnel-studio", ["-N", "-T", "-R", "3459:127.0.0.1:3457", "mac-studio"]),
  ] };
  await writePrivateJson(servicePlanPath(state), plan);
  return { state, plan, stop: () => listener.stop() };
}

/** A plan whose tunnels stand alone: no inference component and no local listener to probe. */
async function transportFixture(port: number, clientOnly: boolean, forwards = ["-L", `127.0.0.1:${port}:127.0.0.1:18300`], only = false, hostLast = true) {
  const root = await mkdtemp(join(tmpdir(), "gw-tunnel-remove-")); const state = join(root, "state"); await mkdir(state, { recursive: true, mode: 0o700 });
  const config = join(root, "gateway.json");
  await writeFile(config, JSON.stringify(clientOnly
    ? { version: 1, port, stateDirectory: state, providers: [], clientOnly: true }
    : { version: 1, port, stateDirectory: state, providers: [{ id: "claude", type: "claude-subscription", models: { claude: "claude" } }] }));
  const tunnel = (id: string, args: string[]) => ({ id, kind: "tunnel" as const, command: "/usr/bin/ssh", args, log: join(state, `${id}.log`) });
  const spark = tunnel("tunnel-spark", hostLast ? sparkArgs(...forwards) : ["-N", "-T", ...forwards]);
  const components = only ? [spark] : [
    { id: "desktop", kind: "desktop" as const, command: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", args: ["--app", "/Applications/ChatGPT.app"], log: join(state, "desktop.log") },
    spark,
    tunnel("tunnel-studio", ["-N", "-T", "-R", "3459:127.0.0.1:3457", "mac-studio"]),
  ];
  const plan: ServicePlan = { version: 1, config, sharedExecutors: !only, components };
  await writePrivateJson(servicePlanPath(state), plan);
  return { state, plan };
}

const remove = async (state: string, id: string, listProcesses = none) => removeTunnelComponent(state, (await readServicePlan(state))!, id, listProcesses);

test("removing a tunnel keeps every other component and archives the plan it replaced", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    const result = await remove(f.state, "spark");
    assert.equal(result.tunnel, "spark"); assert.equal(result.removed, true); assert.equal(result.appliesAt, "next service restart");
    assert.match(String(result.note), /stops at the next gateway service restart/);
    const next = (await readServicePlan(f.state))!;
    assert.deepEqual(ids(next), ["inference", "desktop", "tunnel-studio"]);
    assert.deepEqual(next, { ...f.plan, components: f.plan.components.filter(component => component.id !== "tunnel-spark") }, "nothing else in the plan changed");
    assert.equal((await stat(servicePlanPath(f.state))).mode & 0o777, 0o600);
    const backup = String(result.backup);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(backup, "utf8")), f.plan, "the backup holds the plan from before the removal");
    const record = join(f.state, "service-backups", "tunnel-removals.json");
    assert.equal((await stat(record)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(record, "utf8")).removals.map((entry: { id: string; backup: string }) => [entry.id, entry.backup]), [["spark", backup]]);
  } finally { await f.stop(); }
});

test("a provider on the tunnel's local port blocks its removal, whatever loopback spelling it uses", async () => {
  for (const baseUrl of ["http://127.0.0.1:18301/v1", "http://localhost:18301", "http://[::1]:18301/v1"]) {
    const f = await fixture({ active: 0, status: "ok" }, api(baseUrl));
    try {
      await assert.rejects(remove(f.state, "spark"), /Provider spark_api uses this tunnel's local port 18301; point it at another endpoint or remove it from the gateway configuration, then repeat the removal/, baseUrl);
      assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
      await noBackups(f.state);
    } finally { await f.stop(); }
  }
});

test("a provider that does not reach the tunnel's listener does not block its removal", async () => {
  for (const baseUrl of ["http://127.0.0.1:18302/v1", "https://example.com:18301/v1", "https://10.0.0.5:18301/v1"]) {
    const f = await fixture({ active: 0, status: "ok" }, api(baseUrl));
    try { assert.equal((await remove(f.state, "spark")).removed, true, baseUrl); }
    finally { await f.stop(); }
  }
});

test("a reverse tunnel's local target is not a port any provider depends on", async () => {
  const f = await fixture({ active: 0, status: "ok" }, { ...api("http://127.0.0.1:18300/v1"), id: "qwen" }, ["-R", forward]);
  try {
    assert.equal((await remove(f.state, "spark")).removed, true);
    assert.deepEqual(ids((await readServicePlan(f.state))!), ["inference", "desktop", "tunnel-studio"]);
  } finally { await f.stop(); }
  // On a remote client, a reverse forward targeting the client port is not the client's own connection.
  const client = await transportFixture(18301, true, ["-R", "3459:127.0.0.1:18301"]);
  assert.equal((await remove(client.state, "spark")).removed, true);
});

test("an unknown tunnel is refused and a repeated removal is idempotent and still says when it applies", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    await assert.rejects(remove(f.state, "missing"), /No tunnel missing in the unified service plan/);
    await noBackups(f.state);
    await remove(f.state, "spark");
    assert.deepEqual(await remove(f.state, "spark"), { tunnel: "spark", removed: false, alreadyRemoved: true, appliesAt: "next service restart",
      note: "Already removed from the service plan; if the service has not restarted since, the tunnel stops at the next gateway service restart" });
    assert.deepEqual(ids((await readServicePlan(f.state))!), ["inference", "desktop", "tunnel-studio"]);
  } finally { await f.stop(); }
});

test("a backup file that merely looks like a removal does not excuse an unknown tunnel", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    const backups = join(f.state, "service-backups"); await mkdir(backups, { recursive: true, mode: 0o700 });
    await writeFile(join(backups, "tunnel-removed-ghost-2026-01-01T00-00-00.000Z.json"), "{}", { mode: 0o600 });
    await assert.rejects(remove(f.state, "ghost"), /No tunnel ghost in the unified service plan/);
  } finally { await f.stop(); }
});

test("a backup for a longer tunnel id does not excuse an unknown shorter id", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    await writePrivateJson(servicePlanPath(f.state), { ...f.plan, components: f.plan.components.map(component =>
      component.id === "tunnel-spark" ? { ...component, id: "tunnel-spark-2026" } : component) });
    assert.equal((await remove(f.state, "spark-2026")).removed, true);
    await assert.rejects(remove(f.state, "spark"), /No tunnel spark in the unified service plan/);
    assert.equal((await remove(f.state, "spark-2026")).alreadyRemoved, true);
  } finally { await f.stop(); }
});

test("a removal whose plan write failed is not later reported as already removed", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    await mkdir(join(f.state, "service-backups"), { mode: 0o700 }); await chmod(f.state, 0o500);
    try { await assert.rejects(remove(f.state, "spark")); } finally { await chmod(f.state, 0o700); }
    assert.ok(!(await readdir(join(f.state, "service-backups"))).includes("tunnel-removals.json"), "nothing was recorded");
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan was not changed");
    // The operator later drops the tunnel by hand: no removal was ever recorded for it.
    await writePrivateJson(servicePlanPath(f.state), { ...f.plan, components: f.plan.components.filter(component => component.id !== "tunnel-spark") });
    await assert.rejects(remove(f.state, "spark"), /No tunnel spark in the unified service plan/);
  } finally { await f.stop(); }
});

test("a removal that cannot be recorded still succeeds and says repeating it will not be recognised", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    await mkdir(join(f.state, "service-backups", "tunnel-removals.json"), { recursive: true, mode: 0o700 });
    const result = await remove(f.state, "spark");
    assert.equal(result.removed, true); assert.match(String(result.note), /could not be recorded/);
    assert.deepEqual(ids((await readServicePlan(f.state))!), ["inference", "desktop", "tunnel-studio"]);
  } finally { await f.stop(); }
});

test("busy, unhealthy or unreachable inference blocks a tunnel removal before anything is written", async () => {
  for (const [answer, message] of [[{ active: 2, status: "ok" }, /^Error: Gateway inference is busy or unhealthy; the tunnel was not removed$/], [{ active: 0, status: "configuration_error" }, /^Error: Gateway inference is busy or unhealthy; the tunnel was not removed$/], [null, /Cannot verify the running gateway is idle/]] as const) {
    const f = await fixture(answer);
    try {
      await assert.rejects(remove(f.state, "spark"), message);
      assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
      await noBackups(f.state);
    } finally { await f.stop(); }
  }
});

test("a running ChatGPT desktop blocks a tunnel removal before anything is written", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    await assert.rejects(remove(f.state, "spark", running), /^Error: Quit ChatGPT normally after local and remote chats finish; the tunnel was not removed$/);
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    await noBackups(f.state);
  } finally { await f.stop(); }
});

test("a plan without inference needs no /health answer before its tunnel is removed", async () => {
  const f = await transportFixture(await unusedPort(), false);
  const result = await remove(f.state, "spark");
  assert.equal(result.removed, true); assert.equal(result.appliesAt, "next service restart");
  assert.deepEqual(ids((await readServicePlan(f.state))!), ["desktop", "tunnel-studio"]);
});

test("the only unified service component cannot be removed", async () => {
  const f = await transportFixture(await unusedPort(), false, undefined, true);
  await assert.rejects(remove(f.state, "spark"), /Tunnel spark is the only unified service component/);
  assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
  await noBackups(f.state);
});

test("a plan that changed after it was read is refused without a write", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    const stale = (await readServicePlan(f.state))!;
    const changed = { ...f.plan, sharedExecutors: false };
    await writePrivateJson(servicePlanPath(f.state), changed);
    await assert.rejects(removeTunnelComponent(f.state, stale, "spark", none), /Gateway service plan changed; repeat the tunnel removal/);
    assert.deepEqual(await readServicePlan(f.state), changed, "the plan on disk is untouched");
    await noBackups(f.state);
  } finally { await f.stop(); }
});

test("a component named like a tunnel but of another kind is an unknown tunnel", async () => {
  const f = await transportFixture(await unusedPort(), false);
  const { sharedExecutors: _shared, ...rest } = f.plan; const plan: ServicePlan = { ...rest, components: f.plan.components.map(component => component.id === "tunnel-spark" ? { ...component, kind: "native" as const } : component) };
  await writePrivateJson(servicePlanPath(f.state), plan);
  await assert.rejects(removeTunnelComponent(f.state, (await readServicePlan(f.state))!, "spark", none), /No tunnel spark in the unified service plan/);
  assert.deepEqual(await readServicePlan(f.state), plan, "the plan is untouched");
  await noBackups(f.state);
});

test("the tunnel carrying a remote client's gateway connection cannot be removed", async () => {
  const f = await transportFixture(18301, true);
  await assert.rejects(remove(f.state, "spark"),
    /Tunnel spark carries this client's gateway connection on port 18301; stop this remote client with gateway service uninstall instead of removing its tunnel/);
  assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
  await noBackups(f.state);
  // Only the tunnel that carries the connection is refused; another one still retires normally.
  assert.equal((await remove(f.state, "studio")).removed, true);
});

test("every spelling of a forward to the client's port is recognised, including later and bracketed ones", async () => {
  const forms = [["-L", "[::1]:18301:127.0.0.1:18300"], ["-L18301:127.0.0.1:18300"], ["-NTL", "18301:127.0.0.1:18300"], ["-o", "LocalForward=127.0.0.1:18301 127.0.0.1:18300"],
    ["-oLocalForward=18301 127.0.0.1:18300"], ["-o", "localforward [::1]:18301 [::1]:18300"], ["-L", "18400:127.0.0.1:1", "-L", "*:18301:127.0.0.1:18300"], ["-D", "18301"], ["-L", ":18301:[::1]:18300"], ["-o", "DynamicForward=18301"],
    ["-P", "x", "-L", "18301:127.0.0.1:18300"], ["-Pdev", "-L", "18301:127.0.0.1:18300"], ["-PLab", "-L", "18301:127.0.0.1:18300"], ["-P", "-L", "-L", "18301:127.0.0.1:18300"]];
  for (const form of forms) {
    const f = await transportFixture(18301, true, form);
    await assert.rejects(remove(f.state, "spark"), /carries this client's gateway connection on port 18301/, form.join(" "));
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
  }
  const f = await fixture({ active: 0, status: "ok" }, api("http://[::1]:18301/v1"), ["-L", "[::1]:18301:127.0.0.1:18300"]);
  try { await assert.rejects(remove(f.state, "spark"), /Provider spark_api uses this tunnel's local port 18301/); } finally { await f.stop(); }
});

test("a forward whose local port cannot be identified is refused instead of passing the safety checks", async () => {
  const forms = [["-L", "18301"], ["-L"], ["-L", "/tmp/forward.sock:127.0.0.1:18300"], ["-L", "127.0.0.1:18301:/tmp/remote.sock"], ["-o", "LocalForward=nonsense"], ["-L", "99999:127.0.0.1:1"], ["-D", "x:y:z"],
    // No forward is declared, so any listener comes from ssh_config (-F or the host alias), which is not visible here.
    [], ["-F", "/tmp/ssh-config"], ["-PLab"], ["-o", "RemoteCommand=none"], ["--", "-L", "18301:127.0.0.1:18300"]];
  for (const form of forms) {
    const f = await transportFixture(18301, true, form);
    await assert.rejects(remove(f.state, "spark"), /Cannot determine tunnel spark's local port; edit the service plan manually/, form.join(" "));
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    await noBackups(f.state);
  }
});

test("gateway tunnel uninstall edits the unified plan end to end on any platform and install still refuses it", async () => {
  const f = await fixture({ active: 0, status: "ok" }); const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    // The plan branch runs before any launchctl call, so this reaches the real hook on Linux as well.
    await assert.rejects(macTunnel("uninstall", { id: "spark" }, f.state, running), /Quit ChatGPT normally/);
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the guard ran through the CLI path");
    const result = await macTunnel("uninstall", { id: "spark" }, f.state, none);
    assert.equal(result.tunnel, "spark"); assert.equal(result.removed, true);
    assert.equal(result.appliesAt, "next service restart");
    assert.deepEqual(ids((await readServicePlan(f.state))!), ["inference", "desktop", "tunnel-studio"]);
    await assert.rejects(macTunnel("install", { id: "spark", host: "qwen-spark", port: 18301, remotePort: 18300 }, f.state), /Tunnels are owned by the unified service/);
  } finally { Object.defineProperty(process, "platform", original); await f.stop(); }
});

test("a missing -L, -D or -R value at the end of the arguments is refused", async () => {
  for (const flag of ["-L", "-D", "-R"]) {
    // An earlier complete forward must not excuse the dangling one.
    const f = await transportFixture(18301, true, ["-L", "18400:127.0.0.1:1", flag], false, false);
    await assert.rejects(remove(f.state, "spark"), /Cannot determine tunnel spark's local port/, flag);
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    await noBackups(f.state);
  }
});

test("a tunnel whose forwards live only in ssh_config is refused even when a provider uses the port", async () => {
  for (const forwards of [[], ["-F", "/tmp/ssh-config"]]) {
    const f = await fixture({ active: 0, status: "ok" }, { ...api("http://127.0.0.1:18301/v1"), id: "qwen" }, forwards);
    try {
      await assert.rejects(remove(f.state, "spark"), /Cannot determine tunnel spark's local port; edit the service plan manually/, forwards.join(" "));
      assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
      await noBackups(f.state);
    } finally { await f.stop(); }
  }
});

test("arguments after -- are the remote command, not forwards", async () => {
  const f = await transportFixture(18301, true, ["-R", "3459:127.0.0.1:3457", "--", "echo", "-L", "18301:127.0.0.1:18300"]);
  assert.equal((await remove(f.state, "spark")).removed, true);
});

test("a provider base URL without a port uses the scheme's default port", async () => {
  for (const [baseUrl, port] of [["http://localhost/v1", 80], ["https://localhost/v1", 443]] as const) {
    const f = await fixture({ active: 0, status: "ok" }, api(baseUrl), ["-L", `${port}:127.0.0.1:18300`]);
    try { await assert.rejects(remove(f.state, "spark"), /Provider spark_api uses this tunnel's local port/, baseUrl); } finally { await f.stop(); }
  }
  // The other scheme's default port is not the provider's.
  for (const [baseUrl, port] of [["http://localhost/v1", 443], ["https://localhost/v1", 80]] as const) {
    const f = await fixture({ active: 0, status: "ok" }, api(baseUrl), ["-L", `${port}:127.0.0.1:18300`]);
    try { assert.equal((await remove(f.state, "spark")).removed, true, baseUrl); } finally { await f.stop(); }
  }
});

test("an unreadable removal record never changes an unknown or repeated tunnel into a read error", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    await mkdir(join(f.state, "service-backups", "tunnel-removals.json"), { recursive: true, mode: 0o700 });
    assert.equal((await remove(f.state, "spark")).removed, true);
    await assert.rejects(remove(f.state, "spark"), /^Error: No tunnel spark in the unified service plan$/);
    await assert.rejects(remove(f.state, "other"), /^Error: No tunnel other in the unified service plan$/);
  } finally { await f.stop(); }
});

test("a restored backup that is then edited by hand does not make the id look removed again", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    const result = await remove(f.state, "spark");
    assert.equal((await remove(f.state, "spark")).alreadyRemoved, true);
    // The operator restores the saved plan, as the docs describe, then drops the tunnel by hand.
    await delay(50); await writePrivateJson(servicePlanPath(f.state), JSON.parse(await readFile(String(result.backup), "utf8")));
    await delay(50); await writePrivateJson(servicePlanPath(f.state), { ...f.plan, components: f.plan.components.filter(component => component.id !== "tunnel-spark") });
    await assert.rejects(remove(f.state, "spark"), /^Error: No tunnel spark in the unified service plan$/);
  } finally { await f.stop(); }
});

test("a plan that someone else replaced after the removal does not keep the id removed", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    await remove(f.state, "spark");
    await delay(50); await writePrivateJson(servicePlanPath(f.state), { ...(await readServicePlan(f.state))!, sharedExecutors: false });
    await assert.rejects(remove(f.state, "spark"), /^Error: No tunnel spark in the unified service plan$/);
  } finally { await f.stop(); }
});

test("an earlier removal stays recognised after a later removal by the same command", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    await remove(f.state, "spark"); await remove(f.state, "studio");
    assert.equal((await remove(f.state, "spark")).alreadyRemoved, true);
    assert.equal((await remove(f.state, "studio")).alreadyRemoved, true);
    await assert.rejects(remove(f.state, "other"), /No tunnel other in the unified service plan/);
  } finally { await f.stop(); }
});

test("removing again after a restore carries only the records that describe the plan it started from", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    const first = await remove(f.state, "spark");
    await delay(50); await writePrivateJson(servicePlanPath(f.state), JSON.parse(await readFile(String(first.backup), "utf8")));
    await remove(f.state, "studio");
    // spark's record described a plan that was replaced by the restore; it is not carried forward.
    await assert.rejects(remove(f.state, "gone"), /No tunnel gone/);
    assert.equal((await remove(f.state, "studio")).alreadyRemoved, true);
    assert.equal((await remove(f.state, "spark")).removed, true, "spark is back in the plan and is removed again");
  } finally { await f.stop(); }
});

test("a removal waits for the plan-file lock the other plan writers hold and then refuses a plan they changed", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    const changed = { ...f.plan, sharedExecutors: false };
    let removal!: Promise<unknown>; const outcome = { settled: false };
    await withPrivateFileLock(servicePlanPath(f.state), async () => {
      removal = remove(f.state, "spark").then(() => { outcome.settled = true; }, () => { outcome.settled = true; });
      await delay(150);
      assert.equal(outcome.settled, false, "the removal is waiting for the lock");
      assert.deepEqual(await readServicePlan(f.state), f.plan);
      await noBackups(f.state);
      await writePrivateJson(servicePlanPath(f.state), changed);
    });
    await removal;
    assert.deepEqual(await readServicePlan(f.state), changed, "the other writer's plan survives");
    await noBackups(f.state);
  } finally { await f.stop(); }
});
