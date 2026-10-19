import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { ServiceSupervisor, type NativeProbes } from "../service-supervisor.js";
import { serviceStatusPath, type ServicePlan } from "../service-plan.js";
import { executionHostHome } from "../execution-host.js";
import { executionHostMarker, sdkIdentity, socketIdentity } from "../execution-host-storage.js";
import { executionHostReady } from "../mac-shared-executors.js";
import { probeExecutionHost, type SdkBaseline } from "../service-host-probe.js";
import { writePrivateJson } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { shortFolder } from "./short-folder.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";
import { fixtureComponent, killFixturesAfterTests } from "./supervisor-fixture.js";

isolateExecutionRoots(); // The SDK rendezvous and host homes stay in this file's own folder, never /tmp/codex-daemon-<uid>.
hostRunsInThisProcess(); // The supervisor's host runs inside the test process: see src/tests/in-process-host.ts.
killFixturesAfterTests();

/** A stand-in control socket with a receipt naming it, and an app engine file the receipt was verified against. */
async function standIn(options: { answerPid?: number; silent?: boolean; receiptPid?: number } = {}) {
  const made = await shortFolder("gwp-"); const home = join(made.directory, "home"); await mkdir(home, { mode: 0o700 });
  const socketPath = join(home, "host.sock");
  const server = createServer(); const sockets = new WebSocketServer({ server });
  sockets.on("connection", client => client.on("message", bytes => {
    const message = JSON.parse(String(bytes)) as { id?: number };
    if (options.silent || message.id === undefined) return;
    client.send(JSON.stringify({ id: message.id, result: { version: 1, pid: options.answerPid ?? process.pid } }));
  }));
  server.listen(socketPath); await once(server, "listening"); await chmod(socketPath, 0o600);
  const codex = join(made.directory, "codex"); await writeFile(codex, "engine one\n", { mode: 0o700 });
  const identity = await sdkIdentity(codex);
  await writePrivateJson(join(home, "owner.json"), { version: 1, managed: executionHostMarker, configPath: join(made.directory, "gateway.json"), nativeHome: join(made.directory, "native"),
    ...identity, socketPath, capabilities: ["native"], pid: options.receiptPid ?? process.pid, state: "running", generations: [], socket: await socketIdentity(socketPath) });
  const close = async () => { for (const client of sockets.clients) client.terminate(); sockets.close(); await new Promise(resolve => server.close(resolve)); };
  return { home, codex, socketPath, server, close, remove: async () => { await close().catch(() => {}); await made.remove(); } };
}

test("a probe passes a healthy host and names each failure with a fixed reason", async () => {
  const healthy = await standIn();
  try {
    const baseline: SdkBaseline = {};
    assert.equal(await probeExecutionHost({ home: healthy.home, pid: process.pid, codex: healthy.codex }, baseline), undefined);
    assert.ok(baseline.file && baseline.sha256, "an unchanged engine is hashed once, then judged by its file identity");
    assert.equal(await probeExecutionHost({ home: healthy.home, pid: process.pid, codex: healthy.codex }, baseline), undefined);
    assert.equal(await probeExecutionHost({ home: healthy.home, pid: process.pid }), undefined, "a gateway-only host is not checked against the app engine");
    await writeFile(healthy.codex, "engine two, after an app update\n");
    assert.equal(await probeExecutionHost({ home: healthy.home, pid: process.pid, codex: healthy.codex }, baseline), "sdk_changed");
    await unlink(healthy.codex);
    assert.equal(await probeExecutionHost({ home: healthy.home, pid: process.pid, codex: healthy.codex }, {}), "sdk_changed", "a missing engine has changed");
    assert.equal(await probeExecutionHost({ home: healthy.home, pid: process.pid + 1 }), "receipt_mismatch", "the receipt names another process");
    // The socket is replaced by another one at the same path: the receipt no longer describes it.
    await healthy.close(); await unlink(healthy.socketPath).catch(() => {}); // A closed listener removes its own path.
    const other = createServer(); other.listen(healthy.socketPath); await once(other, "listening"); await chmod(healthy.socketPath, 0o600);
    try { assert.equal(await probeExecutionHost({ home: healthy.home, pid: process.pid }), "socket_mismatch"); }
    finally { await new Promise(resolve => other.close(resolve)); }
    assert.equal(await probeExecutionHost({ home: join(healthy.home, "absent"), pid: process.pid }), "receipt_mismatch", "no receipt at all");
  } finally { await healthy.remove(); }
  const silent = await standIn({ silent: true });
  try {
    const started = Date.now();
    assert.equal(await probeExecutionHost({ home: silent.home, pid: process.pid, timeoutMs: 200 }), "status_timeout");
    assert.ok(Date.now() - started < 2000, "the probe gives up at its limit");
  } finally { await silent.remove(); }
  const imposter = await standIn({ answerPid: process.pid + 1 });
  try { assert.equal(await probeExecutionHost({ home: imposter.home, pid: process.pid }), "status_failed", "an answer for another process"); }
  finally { await imposter.remove(); }
});

test("a host whose SDK socket was cleaned out of /tmp is found by its probe and restarted while idle", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const made = await shortFolder("gwr-"); const directory = made.directory; const state = join(directory, "state"); const nativeHome = join(directory, "native");
  await mkdir(nativeHome, { recursive: true, mode: 0o700 }); await writeFile(join(nativeHome, "config.toml"), 'model="original"\n', { mode: 0o600 });
  const config = join(directory, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3459, clientOnly: true, stateDirectory: state, providers: [] });
  const codex = join(directory, "codex");
  await writeFile(codex, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('codex-cli 0.162.0-alpha.17.2');process.exit(0);}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
  const relay = fixtureComponent(state, "native", "native", "setInterval(()=>{},1000)");
  relay.args.push("--", "--codex", codex, "--native-home", nativeHome);
  const plan: ServicePlan = { version: 1, config, sharedExecutors: true, components: [relay] };
  const unregistered: NativeProbes = { registered: async () => false, fingerprint: async () => "same", appRunning: async () => false };
  configureTelemetry(state, "test");
  const supervisor = new ServiceSupervisor(plan, state, 50, undefined, unregistered, undefined, undefined,
    { kickGapMs: 0, hostProbeMs: 3_600_000, watchKick: () => () => {}, healthSchedule: () => () => {} });
  const events = async (name: string) => { await flushTelemetry(); return (await readTelemetry(state, Date.now() - 600_000)).filter(event => event.event === name); };
  const hostState = async () => (JSON.parse(await readFile(serviceStatusPath(state), "utf8")) as { executionHost?: { state: string } }).executionHost?.state;
  try {
    await supervisor.start();
    const home = executionHostHome(config, nativeHome);
    assert.equal(await hostState(), "running");
    assert.equal(await probeExecutionHost({ home, pid: process.pid }), undefined);
    // What macOS's periodic /tmp cleanup does to a long-running host: the SDK socket its link names disappears.
    await unlink(await readlink(join(home, "host.sock")));
    assert.equal(await probeExecutionHost({ home, pid: process.pid }), "socket_mismatch");
    // Two failed probes in a row: the first alone could be a busy moment.
    await supervisor.checkHost(); assert.deepEqual(await events("execution_host_restarted"), []);
    await supervisor.checkHost();
    for (let attempt = 0; attempt < 500 && (await hostState() !== "running" || await probeExecutionHost({ home, pid: process.pid }) !== undefined); attempt++) await delay(20);
    assert.equal(await probeExecutionHost({ home, pid: process.pid }), undefined, "the restarted host answers on a fresh socket");
    assert.equal(await executionHostReady(plan, process.pid), true);
    assert.deepEqual((await events("execution_host_unhealthy")).map(event => event.reason), ["socket_mismatch"]);
    assert.deepEqual((await events("execution_host_restarted")).map(event => event.reason), ["socket_mismatch"]);
  } finally { await supervisor.stop(); await flushTelemetry(); await made.remove(); }
});
