import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { startServeRuntime } from "../serve-runtime.js";
import type { ReleaseLease } from "../release-retention.js";
import { gatewayToken } from "../config.js";

const run = promisify(execFile);
const openMarkerCount = async (marker: string) => {
  const { stdout } = await run("/usr/sbin/lsof", ["-nP", "-p", String(process.pid), "-Fn"]);
  return stdout.split("\n").filter(line => line === `n${marker}`).length;
};

test("a runtime setup failure releases its acquired release lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-release-lease-")); let releases = 0;
  const lease: ReleaseLease = { release() { releases++; } };
  try {
    const config = join(root, "gateway.json"); await writeFile(config, "{", { mode: 0o600 });
    await assert.rejects(startServeRuntime(config, undefined, undefined, undefined, lease));
    assert.equal(releases, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same-release leases share one marker descriptor until the final release", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-release-fd-"));
  try {
    const dist = join(root, "releases", "1.0.0", "package", "dist"), marker = join(root, "releases", "1.0.0", ".gateway-release"), module = join(dist, "release-retention.js");
    await mkdir(dist, { recursive: true, mode: 0o700 }); await writeFile(marker, "1.0.0\n", { mode: 0o600 });
    await copyFile(new URL("../release-retention.js", import.meta.url), module); await chmod(module, 0o600);
    const loaded = await import(pathToFileURL(module).href);
    const canonicalMarker = await realpath(marker), before = await openMarkerCount(canonicalMarker), first = loaded.retainRunningRelease(pathToFileURL(module).href), second = loaded.retainRunningRelease(pathToFileURL(module).href);
    assert.equal(first.releaseName, "1.0.0");
    assert.equal(await openMarkerCount(canonicalMarker), before + 1);
    first.release(); assert.equal(await openMarkerCount(canonicalMarker), before + 1);
    second.release(); assert.equal(await openMarkerCount(canonicalMarker), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a hot-swapped runtime holds its old release until its own request finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-release-drain-")); let oldReleased = 0; let newReleased = 0;
  let began!: () => void; let finish!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const continueUpstream = new Promise<void>(resolve => { finish = resolve; });
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* consume */ } began(); await continueUpstream;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"type":"response.output_text.delta","delta":"held"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const state = join(root, "state"), config = join(root, "gateway.json");
  const key = "GATEWAY_RELEASE_RETENTION_TEST_KEY"; process.env[key] = "fixture";
  await writeFile(config, JSON.stringify({ version: 1, port: 0, stateDirectory: state, providers: [{ id: "fixture", type: "responses-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, apiKeyEnv: key, models: { fixture: "fixture" } }] }), { mode: 0o600 });
  let gateway: Awaited<ReturnType<typeof startServeRuntime>> | undefined; let replacement: Awaited<ReturnType<typeof startServeRuntime>> | undefined;
  try {
    const old: ReleaseLease = { release() { oldReleased++; } };
    gateway = await startServeRuntime(config, undefined, undefined, undefined, old);
    const port = (gateway.server.address() as { port: number }).port, token = await gatewayToken(state);
    const request = fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "fixture", input: "hold" }) });
    await started;
    const next: ReleaseLease = { release() { newReleased++; } };
    replacement = await startServeRuntime(config, undefined, gateway.server, gateway.runtime, next);
    assert.equal(oldReleased, 0, "the old handler still owns its response");
    finish(); assert.equal((await request).status, 200);
    for (let attempt = 0; oldReleased === 0; attempt++) { assert.ok(attempt < 100, "old release did not drain"); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(oldReleased, 1);
  } finally {
    finish?.(); await replacement?.runtime.stop(); gateway?.server.closeAllConnections();
    if (gateway) await new Promise<void>(resolve => gateway!.server.close(() => resolve()));
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    delete process.env[key]; await rm(root, { recursive: true, force: true });
  }
});


test("the real split CLI keeps cli.js and its immutable release marker open while its command runs", { skip: process.platform !== "darwin", timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gatefox-split-cli-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const release = join(root, "releases/1.0.0"), dist = join(release, "package/dist"), entry = join(dist, "cli.js"), marker = join(release, ".gateway-release");
    await mkdir(dist, { recursive: true, mode: 0o700 }); await writeFile(marker, "1.0.0\n", { mode: 0o600 });
    await writeFile(join(release, "package/package.json"), '{"type":"module"}');
    for (const name of ["cli.js", "error-message.js", "release-retention.js"]) await copyFile(new URL(`../${name}`, import.meta.url), join(dist, name));
    await writeFile(join(dist, "cli-main.js"), 'export async function main(){process.stdout.write("READY\\n"); setInterval(()=>{},1000); }');
    child = spawn(process.execPath, [entry, "serve"], { stdio: ["ignore", "pipe", "pipe"] });
    const active = child;
    await new Promise<void>((resolve, reject) => {
      active.stdout!.on("data", chunk => { if (String(chunk).includes("READY")) resolve(); });
      active.once("exit", code => reject(new Error(`Fixture exited before readiness (${code})`)));
      active.once("error", reject);
    });
    const { stdout } = await run("/usr/sbin/lsof", ["-nP", "-p", String(child.pid), "-Fn"]);
    const names = stdout.split("\n");
    assert.ok(names.includes(`n${await realpath(entry)}`), "installer can identify the immutable CLI entrypoint");
    assert.ok(names.includes(`n${await realpath(marker)}`), "the running release is retained");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
