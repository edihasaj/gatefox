import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { macTunnel } from "../mac-tunnel.js";
import { removeTunnelComponent } from "../mac-tunnel-remove.js";
import { pendingLoginConsolidationPath } from "../mac-login-consolidate.js";
import { readServicePlan, servicePlanPath, type ServicePlan } from "../service-plan.js";
import { writePrivateJson } from "../config.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { api, fixture, forward, ids, noBackups, noSsh, none, remove, removeAllRoots, running, sshConfigFile, transportFixture, unusedPort } from "./mac-tunnel-remove-fixtures.js";


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
    assert.equal((await stat(join(f.state, "service-backups"))).mode & 0o777, 0o700, "the backups directory is private");
    assert.deepEqual(JSON.parse(await readFile(backup, "utf8")), f.plan, "the backup holds the plan from before the removal");
    const record = join(f.state, "service-backups", "tunnel-removals.json");
    assert.equal((await stat(record)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(record, "utf8")).removals.map((entry: { id: string; backup: string }) => [entry.id, entry.backup]), [["spark", backup]]);
  } finally { await f.stop(); }
});

test("a provider on the tunnel's local port blocks its removal, whatever loopback spelling it uses", async () => {
  // Every spelling that connects to a listener bound to 127.0.0.1. Config validation accepts http only for three of them; any host is accepted over https.
  for (const baseUrl of ["http://127.0.0.1:18301/v1", "http://localhost:18301", "http://[::1]:18301/v1", "https://0.0.0.0:18301/v1", "https://[::]:18301/v1", "https://[::ffff:127.0.0.1]:18301/v1",
    "https://localhost.:18301/v1", "https://LOCALHOST:18301/v1", "https://api.localhost:18301/v1", "https://127.0.0.2:18301/v1", "https://127.1:18301/v1", "https://[::ffff:0.0.0.0]:18301/v1", "https://[0:0:0:0:0:0:0:1]:18301/v1"]) {
    const f = await fixture({ active: 0, status: "ok" }, api(baseUrl));
    try {
      await assert.rejects(remove(f.state, "spark"), /Provider spark_api uses this tunnel's local port 18301; point it at another endpoint or remove it from the gateway configuration, then repeat the removal/, baseUrl);
      assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
      await noBackups(f.state);
    } finally { await f.stop(); }
  }
});

test("a provider that does not reach the tunnel's listener does not block its removal", async () => {
  for (const baseUrl of ["http://127.0.0.1:18302/v1", "https://example.com:18301/v1", "https://10.0.0.5:18301/v1", "https://[::ffff:10.0.0.5]:18301/v1", "https://128.0.0.1:18301/v1", "https://[::2]:18301/v1", "https://notlocalhost:18301/v1", "https://localhost.example.com:18301/v1"]) {
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
  // An ssh_config RemoteForward whose first word equals the client's port listens on the other machine too.
  const remote = await transportFixture(18301, true, ["-o", "RemoteForward=18301 127.0.0.1:3457"]);
  assert.equal((await remove(remote.state, "spark")).removed, true);
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

test("a tunnel id matches exactly: a longer or a shorter name never removes or excuses another tunnel", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    // spark is present: neither a longer name nor a shorter one is spark.
    for (const other of ["spark-2", "spar", "park", "tunnel-spark", "spark-"]) {
      await assert.rejects(remove(f.state, other), new RegExp(`^Error: No tunnel ${other} in the unified service plan$`), other);
      assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
      await noBackups(f.state);
    }
    const longer = { ...f.plan, components: f.plan.components.map(component => component.id === "tunnel-spark" ? { ...component, id: "tunnel-spark-2026" } : component) };
    await writePrivateJson(servicePlanPath(f.state), longer);
    // spark-2026 is present: asking for spark must not remove it.
    await assert.rejects(remove(f.state, "spark"), /^Error: No tunnel spark in the unified service plan$/);
    assert.deepEqual(await readServicePlan(f.state), longer, "tunnel-spark-2026 is still in the plan");
    await noBackups(f.state);
    assert.equal((await remove(f.state, "spark-2026")).removed, true);
    await assert.rejects(remove(f.state, "spark"), /^Error: No tunnel spark in the unified service plan$/);
    assert.equal((await remove(f.state, "spark-2026")).alreadyRemoved, true);
  } finally { await f.stop(); }
});

test("a state directory that cannot hold the plan lock refuses the removal and never reports it as already removed", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    await chmod(f.state, 0o500);
    try { await assert.rejects(remove(f.state, "spark"), /^Error: Cannot lock the gateway service plan \(EACCES\); the tunnel was not removed$/); } finally { await chmod(f.state, 0o700); }
    await noBackups(f.state);
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan was not changed");
    // The operator later drops the tunnel by hand: no removal was ever recorded for it.
    await writePrivateJson(servicePlanPath(f.state), { ...f.plan, components: f.plan.components.filter(component => component.id !== "tunnel-spark") });
    await assert.rejects(remove(f.state, "spark"), /^Error: No tunnel spark in the unified service plan$/);
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
    // Port 0 asks ssh for a free one, so the real listener cannot be known.
    ["-L", "0:127.0.0.1:18300"], ["-D", "0"], ["-L", "127.0.0.1:0:127.0.0.1:18300"], ["-o", "LocalForward=0 127.0.0.1:18300"],
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
    await assert.rejects(macTunnel("uninstall", { id: "spark" }, f.state, running, { resolveSsh: noSsh }), /Quit ChatGPT normally/);
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the guard ran through the CLI path");
    const result = await macTunnel("uninstall", { id: "spark" }, f.state, none, { resolveSsh: noSsh });
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

test("a later removal does not carry a record across a hand edit of the plan", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    await remove(f.state, "spark");
    // spark stays absent, but the plan file is now another one than the removal left.
    await delay(50); await writePrivateJson(servicePlanPath(f.state), { ...(await readServicePlan(f.state))!, sharedExecutors: false });
    await remove(f.state, "studio");
    await assert.rejects(remove(f.state, "spark"), /^Error: No tunnel spark in the unified service plan$/);
    assert.equal((await remove(f.state, "studio")).alreadyRemoved, true, "the removal just made is still recognised");
  } finally { await f.stop(); }
});

test("a later removal does not carry a record across a restore and a hand edit", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    const first = await remove(f.state, "spark");
    assert.equal((await remove(f.state, "spark")).alreadyRemoved, true);
    await delay(50); await writePrivateJson(servicePlanPath(f.state), JSON.parse(await readFile(String(first.backup), "utf8")));
    // The operator then drops spark by hand again, so no removal by this command describes that plan.
    await delay(50); await writePrivateJson(servicePlanPath(f.state), { ...f.plan, components: f.plan.components.filter(component => component.id !== "tunnel-spark") });
    await remove(f.state, "studio");
    await assert.rejects(remove(f.state, "spark"), /^Error: No tunnel spark in the unified service plan$/);
    assert.equal((await remove(f.state, "studio")).alreadyRemoved, true);
  } finally { await f.stop(); }
});

test("a restored backup puts the tunnel back and it can be removed again", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    const first = await remove(f.state, "spark");
    await delay(50); await writePrivateJson(servicePlanPath(f.state), JSON.parse(await readFile(String(first.backup), "utf8")));
    assert.equal((await remove(f.state, "spark")).removed, true, "spark is back in the plan and is removed again");
    assert.equal((await remove(f.state, "spark")).alreadyRemoved, true);
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

const exists = (path: string) => access(path).then(() => true, () => false);
const darwin = async <T>(action: () => Promise<T>): Promise<T> => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!; Object.defineProperty(process, "platform", { value: "darwin" });
  try { return await action(); } finally { Object.defineProperty(process, "platform", original); }
};

test("a pending next-login consolidation refuses a tunnel removal and changes nothing", async () => {
  const f = await fixture({ active: 0, status: "ok" });
  try {
    // The staged plan no longer lists tunnel-studio, so activating it later would fail against a plan that changed in between.
    const staged: ServicePlan = { ...f.plan, components: f.plan.components.filter(component => component.id !== "tunnel-studio") };
    const primaryLabel = "com.edihasaj.subscription-gateway";
    await writePrivateJson(pendingLoginConsolidationPath(f.state), { version: 1, phase: "ready", config: f.plan.config, plan: staged, primaryLabel, primaryPlistDigest: "a".repeat(64),
      removedLabels: [], backup: join(f.state, "service-backups", "login-consolidation-test.json"), sources: [{ label: primaryLabel, digest: "b".repeat(64), mode: 0o600 }] });
    await darwin(async () => {
      for (const id of ["spark", "studio", "missing"]) {
        await assert.rejects(macTunnel("uninstall", { id }, f.state, none, { resolveSsh: noSsh }), /^Error: Tunnel startup is staged under the unified service at next login; its separate registration was not changed$/, id);
      }
    });
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    await noBackups(f.state);
    assert.equal(await exists(join(f.state, "service-backups")), false);
  } finally { await f.stop(); }
});

test("a tunnel that does not run /usr/bin/ssh is refused instead of being read as ssh would be", async () => {
  for (const command of ["/opt/homebrew/bin/autossh", "/opt/homebrew/bin/ssh", "/usr/bin/ssh2", "/usr/bin/SSH"]) {
    const f = await fixture({ active: 0, status: "ok" });
    try {
      const plan: ServicePlan = { ...f.plan, components: f.plan.components.map(component => component.id === "tunnel-spark" ? { ...component, command } : component) };
      await writePrivateJson(servicePlanPath(f.state), plan);
      await assert.rejects(remove(f.state, "spark"), /^Error: Cannot determine tunnel spark's local port; edit the service plan manually$/, command);
      assert.deepEqual(await readServicePlan(f.state), plan, "the plan is untouched");
      await noBackups(f.state);
      // Another tunnel in the same plan that does run /usr/bin/ssh still retires.
      assert.equal((await remove(f.state, "studio")).removed, true);
    } finally { await f.stop(); }
  }
});

test("fixtures and ssh_config files leave no temporary directory behind", async () => {
  const f = await fixture({ active: 0, status: "ok" }); const g = await transportFixture(18301, true); const h = await transportFixture(18301, true); const config = await sshConfigFile("Host x");
  for (const path of [f.root, g.root, h.root, config]) assert.equal(await exists(path), true, path);
  await f.stop(); await g.stop();
  assert.equal(await exists(f.root), false); assert.equal(await exists(g.root), false);
  assert.equal(await exists(h.root), true, "a fixture whose test never calls stop() is still registered");
  await removeAllRoots();
  for (const path of [h.root, config]) assert.equal(await exists(path), false, path);
});
