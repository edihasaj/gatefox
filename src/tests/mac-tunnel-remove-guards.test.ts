import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { reachesListener } from "../mac-tunnel-local.js";
import { parseSshConfigDump, type SshResolver } from "../mac-tunnel-ssh.js";
import { planKey } from "../mac-tunnel-removals.js";
import type { TunnelRemoveSeams } from "../mac-tunnel-remove.js";
import { readServicePlan, servicePlanPath } from "../service-plan.js";
import { writePrivateJson } from "../config.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { api, fixture, sshConfigFile as sshConfig, ids, noBackups, noSsh, none, remove, transportFixture, unusedPort } from "./mac-tunnel-remove-fixtures.js";

const ok = { active: 0, status: "ok" };
const withSsh = (resolveSsh: SshResolver): TunnelRemoveSeams => ({ resolveSsh });
const realSsh = { skip: existsSync("/usr/bin/ssh") ? false : "no /usr/bin/ssh" };

/** This machine's own non-loopback IPv4 address and hostname, as a provider could write them. */
const ownIPv4 = Object.values(networkInterfaces()).flat().find(entry => entry && !entry.internal && entry.family === "IPv4")?.address;
const ownHosts = [ownIPv4, hostname()].filter((host): host is string => !!host && (() => { try { return !!new URL(`http://${host}:18301`); } catch { return false; } })());

const qwenHost = (...forwards: string[]) => ["Host qwen-spark", "  HostName example.invalid", ...forwards.map(line => "  " + line)];

test("a provider on a later forward port of the same tunnel blocks its removal", async () => {
  const f = await fixture(ok, api("http://127.0.0.1:18301/v1"), ["-L", "18400:127.0.0.1:1", "-L", "18301:127.0.0.1:18300"]);
  try {
    await assert.rejects(remove(f.state, "spark"), /Provider spark_api uses this tunnel's local port 18301; point it at another endpoint/);
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    await noBackups(f.state);
  } finally { await f.stop(); }
});

test("every spelling of the local machine reaches a loopback listener, whatever the scheme", () => {
  const loopback = { port: 18301, wildcard: false };
  for (const url of ["http://0.0.0.0:18301/v1", "http://[::ffff:127.0.0.1]:18301/v1", "http://localhost.:18301/v1", "http://[::ffff:7f00:1]:18301", "http://127.255.255.254:18301", "http://[::]:18301",
    "http://localhost..:18301", "http://x.localhost.:18301"]) assert.equal(reachesListener(url, loopback), true, url);
  for (const url of ["http://128.0.0.1:18301", "http://[::ffff:128.0.0.1]:18301", "http://[::2]:18301", "http://localhost:18302", "http://localhost.evil.com:18301", "http://xlocalhost:18301", "not a url", ""]) assert.equal(reachesListener(url, loopback), false, url);
  assert.equal(reachesListener(undefined, loopback), false);
  assert.equal(reachesListener("https://localhost/v1", { port: 443, wildcard: false }), true, "the scheme's default port");
});

test("a forward bound beyond loopback is reached through this machine's own name and addresses", async () => {
  const binds = [["-L", "*:18301:127.0.0.1:18300"], ["-L", ":18301:127.0.0.1:18300"], ["-L", "0.0.0.0:18301:127.0.0.1:18300"], ["-D", "*:18301"],
    ["-o", "LocalForward=*:18301 127.0.0.1:18300"], ["-L", "192.0.2.9:18301:127.0.0.1:18300"]];
  for (const host of ownHosts) for (const forwards of binds) {
    const f = await fixture(ok, api(`https://${host}:18301/v1`), forwards);
    try {
      await assert.rejects(remove(f.state, "spark"), /Provider spark_api uses this tunnel's local port 18301/, `${host} ${forwards.join(" ")}`);
      assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    } finally { await f.stop(); }
  }
});

test("a loopback-only forward is not reached through this machine's own name or address", async () => {
  for (const host of ownHosts) for (const forwards of [["-L", "18301:127.0.0.1:18300"], ["-L", "127.0.0.1:18301:127.0.0.1:18300"], ["-L", "[::1]:18301:127.0.0.1:18300"], ["-L", "localhost:18301:127.0.0.1:18300"]]) {
    const f = await fixture(ok, api(`https://${host}:18301/v1`), forwards);
    try { assert.equal((await remove(f.state, "spark")).removed, true, `${host} ${forwards.join(" ")}`); } finally { await f.stop(); }
  }
});

test("GatewayPorts opens a forward without a bind address to this machine's own name, but not one bound to loopback", async () => {
  const gateway = withSsh(async () => ({ listeners: [], declared: false, gatewayPorts: true }));
  for (const host of ownHosts) {
    const open = await fixture(ok, api(`https://${host}:18301/v1`), ["-L", "18301:127.0.0.1:18300"]);
    try { await assert.rejects(remove(open.state, "spark", none, gateway), /Provider spark_api uses this tunnel's local port 18301/, host); } finally { await open.stop(); }
    const closed = await fixture(ok, api(`https://${host}:18301/v1`), ["-L", "127.0.0.1:18301:127.0.0.1:18300"]);
    try { assert.equal((await remove(closed.state, "spark", none, gateway)).removed, true, host); } finally { await closed.stop(); }
  }
});

test("ssh -G output is parsed into listeners, remote forwards and GatewayPorts", () => {
  const dump = ["host qwen-spark", "gatewayports no", "dynamicforward 1081", "dynamicforward [*]:1082", "localforward 18500 [127.0.0.1]:1", "localforward []:18501 [h]:1",
    "localforward [::1]:18502 [h]:1", "remoteforward 3459 [127.0.0.1]:3457", "forwardagent no"].join("\n");
  assert.deepEqual(parseSshConfigDump(dump), { declared: true, gatewayPorts: false, listeners: [{ port: 1081, bind: undefined }, { port: 1082, bind: "*" }, { port: 18500, bind: undefined },
    { port: 18501, bind: "" }, { port: 18502, bind: "::1" }] });
  assert.deepEqual(parseSshConfigDump("gatewayports yes\nremoteforward 1 [h]:2\n"), { declared: true, gatewayPorts: true, listeners: [] });
  assert.deepEqual(parseSshConfigDump("host x\nforwardagent no\n"), { declared: false, gatewayPorts: false, listeners: [] });
  for (const bad of ["localforward /tmp/a.sock [h]:1", "localforward 0 [h]:1", "localforward 99999 [h]:1", "dynamicforward /tmp/a.sock", "localforward"]) assert.equal(parseSshConfigDump(bad), undefined, bad);
});

test("a LocalForward that ssh_config adds through -F is seen beside explicit forwards and alone", realSsh, async () => {
  const config = await sshConfig(...qwenHost("LocalForward 18301 127.0.0.1:18300"));
  for (const forwards of [["-F", config], ["-F", config, "-L", "18400:127.0.0.1:1"], ["-F", config, "-R", "3459:127.0.0.1:3457"]]) {
    const f = await fixture(ok, api("http://127.0.0.1:18301/v1"), forwards);
    try {
      await assert.rejects(remove(f.state, "spark", none, {}), /Provider spark_api uses this tunnel's local port 18301/, forwards.join(" "));
      assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
      await noBackups(f.state);
    } finally { await f.stop(); }
  }
  // The same file with no provider on its port: the forwards are known now, so the removal goes ahead.
  const clear = await fixture(ok, api("http://127.0.0.1:18302/v1"), ["-F", config]);
  try { assert.equal((await remove(clear.state, "spark", none, {})).removed, true); } finally { await clear.stop(); }
});

test("a client's gateway port that ssh_config forwards through -F is the connection the tunnel carries", realSsh, async () => {
  const config = await sshConfig(...qwenHost("LocalForward 18301 127.0.0.1:18300"));
  const f = await transportFixture(18301, true, ["-F", config]);
  await assert.rejects(remove(f.state, "spark", none, {}), /Tunnel spark carries this client's gateway connection on port 18301/);
  assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
  await noBackups(f.state);
});

test("a DynamicForward or a wildcard LocalForward from ssh_config is checked like one on the command line", realSsh, async () => {
  const config = await sshConfig(...qwenHost("DynamicForward 18301", "LocalForward 18400 127.0.0.1:1"));
  const f = await transportFixture(18301, true, ["-F", config]);
  await assert.rejects(remove(f.state, "spark", none, {}), /carries this client's gateway connection on port 18301/);
  for (const host of ownHosts) {
    const wild = await sshConfig(...qwenHost("LocalForward *:18301 127.0.0.1:18300"));
    const g = await fixture(ok, api(`https://${host}:18301/v1`), ["-F", wild]);
    try { await assert.rejects(remove(g.state, "spark", none, {}), /Provider spark_api uses this tunnel's local port 18301/, host); } finally { await g.stop(); }
  }
});

test("a tunnel whose ssh configuration cannot be resolved is refused, explicit forwards or not", realSsh, async () => {
  const missing = join(tmpdir(), "gw-tunnel-ssh-missing", "ssh_config");
  for (const forwards of [["-F", missing], ["-F", missing, "-L", "18400:127.0.0.1:1"]]) {
    const f = await transportFixture(18301, true, forwards);
    await assert.rejects(remove(f.state, "spark", none, {}), /Cannot determine tunnel spark's local port; edit the service plan manually/, forwards.join(" "));
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
    await noBackups(f.state);
  }
});

test("a resolver that fails, or that finds a forward the arguments do not show, changes the outcome", async () => {
  const failing = withSsh(async () => undefined);
  const f = await transportFixture(18301, true, ["-L", "18400:127.0.0.1:1"]);
  await assert.rejects(remove(f.state, "spark", none, failing), /Cannot determine tunnel spark's local port; edit the service plan manually/);
  assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
  await noBackups(f.state);
  // The arguments declare only a reverse forward; ssh resolves a local one on the provider's port.
  const hidden = withSsh(async () => ({ listeners: [{ port: 18301 }], declared: true, gatewayPorts: false }));
  const g = await fixture(ok, api("http://127.0.0.1:18301/v1"), ["-R", "3459:127.0.0.1:3457"]);
  try {
    await assert.rejects(remove(g.state, "spark", none, hidden), /Provider spark_api uses this tunnel's local port 18301/);
    assert.equal((await remove(g.state, "spark")).removed, true, "without that hidden forward the same tunnel retires");
  } finally { await g.stop(); }
});

test("a client-only plan that still has an inference component is not probed for the tunnel it keeps", async () => {
  const port = await unusedPort(); const f = await transportFixture(port, true);
  await writePrivateJson(servicePlanPath(f.state), { ...f.plan, components: [{ id: "inference", kind: "inference", command: "/bin/true", args: [], log: join(f.state, "inference.log") }, ...f.plan.components] });
  // Nothing answers /health on the client's port, and that listener is exactly what the tunnel being kept provides.
  assert.equal((await remove(f.state, "studio")).removed, true);
  assert.deepEqual(ids((await readServicePlan(f.state))!), ["inference", "desktop", "tunnel-spark"]);
  await assert.rejects(remove(f.state, "spark"), /carries this client's gateway connection/);
});

test("a held plan lock fails the removal as busy and names the service plan", async () => {
  const f = await fixture(ok);
  try {
    await withPrivateFileLock(servicePlanPath(f.state), async () => {
      await assert.rejects(remove(f.state, "spark", none, { resolveSsh: noSsh, lockTimeoutMs: 100 }), /^Error: Gateway service plan is busy; the tunnel was not removed$/);
      assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan is untouched");
      await noBackups(f.state);
    });
    assert.equal((await remove(f.state, "spark")).removed, true, "the lock is free again");
  } finally { await f.stop(); }
});

test("a plan write that fails after the backup leaves no record and a later hand removal is still refused", async () => {
  const f = await fixture(ok);
  try {
    const failing: TunnelRemoveSeams = { resolveSsh: noSsh, writePlan: async () => { throw new Error("disk full"); } };
    await assert.rejects(remove(f.state, "spark", none, failing), /^Error: disk full$/);
    const saved = await readdir(join(f.state, "service-backups"));
    assert.equal(saved.length, 1); assert.match(saved[0], /^tunnel-removed-spark-.*\.json$/, "the backup was written before the plan write");
    assert.ok(!saved.includes("tunnel-removals.json"), "nothing was recorded");
    assert.ok(!(await readdir(f.state)).includes("service-plan.json.lock"), "the plan lock was released");
    assert.deepEqual(await readServicePlan(f.state), f.plan, "the plan was not changed");
    await writePrivateJson(servicePlanPath(f.state), { ...f.plan, components: f.plan.components.filter(component => component.id !== "tunnel-spark") });
    await assert.rejects(remove(f.state, "spark"), /^Error: No tunnel spark in the unified service plan$/);
  } finally { await f.stop(); }
});

test("the plan key changes with the content, the inode, the modification time and the change time", () => {
  const info = { ino: 7n, mtimeNs: 1000n, ctimeNs: 2000n };
  assert.equal(planKey("a", info), planKey("a", { ...info }));
  for (const other of [planKey("b", info), planKey("a", { ...info, ino: 8n }), planKey("a", { ...info, mtimeNs: 1001n }), planKey("a", { ...info, ctimeNs: 2001n })]) assert.notEqual(other, planKey("a", info));
});

test("a plan replaced by a copy with the same content and modification time does not keep the id removed", async () => {
  const f = await fixture(ok);
  try {
    const when = 1_700_000_000;
    await remove(f.state, "spark", none, { resolveSsh: noSsh, writePlan: async (path, plan) => { await writePrivateJson(path, plan); await utimes(path, when, when); } });
    const path = servicePlanPath(f.state); const left = await stat(path, { bigint: true }); const copy = path + ".copy";
    await writeFile(copy, await readFile(path, "utf8"), { mode: 0o600 }); await utimes(copy, when, when); await rename(copy, path);
    const now = await stat(path, { bigint: true });
    assert.equal(now.mtimeNs, left.mtimeNs, "same modification time"); assert.notEqual(now.ino, left.ino, "another file");
    await assert.rejects(remove(f.state, "spark"), /^Error: No tunnel spark in the unified service plan$/);
  } finally { await f.stop(); }
});
