import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { activeNativeRelay, relaySocketPath } from "../native-control.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { shortFolder } from "./short-folder.js";

/**
 * The relay the adapter may use is the one that is registered, connected and reachable.
 * Each of the three answers is checked here without a ChatGPT app or a real relay. A registration must point under
 * `$HOME/.local/state/gw-native`, so each fixture points HOME at a folder of its own for its test, whether the file runs
 * under npm test or on its own, and the real home is never touched.
 */
async function relayFixture(registered: boolean | undefined): Promise<{ config: GatewayConfig; home: string; reasons: () => Promise<unknown[]>; close: () => Promise<void> }> {
  const folder = await shortFolder("gw-relay-");
  const nativeHome = join(folder.directory, "codex"); await mkdir(nativeHome, { mode: 0o700 });
  const previousHome = process.env.HOME; process.env.HOME = join(folder.directory, "h");
  const home = join(folder.directory, "h", ".local/state/gw-native", "fx");
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (registered !== undefined) await writePrivateJson(join(folder.directory, "native-registration.json"), { registered, home, nativeHome });
  configureTelemetry(folder.directory, "test");
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = nativeHome;
  const config = { version: 1, port: 3457, stateDirectory: folder.directory, providers: [] } as unknown as GatewayConfig;
  return {
    config, home,
    reasons: async () => { await flushTelemetry(); return (await readTelemetry(folder.directory, Date.now() - 60_000)).filter(event => event.event === "native_relay_skipped").map(event => event.reason); },
    close: async () => {
      if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      await folder.remove();
    },
  };
}

test("a machine that never registered a relay is used without the relay, and says nothing", async () => {
  const f = await relayFixture(undefined);
  try {
    assert.equal(await activeNativeRelay(f.config), undefined);
    assert.deepEqual(await f.reasons(), []);
  } finally { await f.close(); }
});

test("a registration that says the relay was removed is skipped by that name", async () => {
  const f = await relayFixture(false);
  try {
    assert.equal(await activeNativeRelay(f.config), undefined);
    assert.deepEqual(await f.reasons(), ["not_registered"]);
  } finally { await f.close(); }
});

test("a registered relay that never connected is skipped as not connected", async () => {
  const f = await relayFixture(true);
  try {
    assert.equal(await activeNativeRelay(f.config), undefined, "no status file at all");
    await writeFile(join(f.home, "status.json"), '{"status":"connecting"}');
    assert.equal(await activeNativeRelay(f.config), undefined, "a relay that is still connecting");
    await writeFile(join(f.home, "status.json"), "{ not json");
    assert.equal(await activeNativeRelay(f.config), undefined, "a garbled status file never throws");
    assert.deepEqual(await f.reasons(), ["not_connected", "not_connected", "not_connected"]);
  } finally { await f.close(); }
});

test("a connected relay whose control socket is gone is skipped as unreachable", async () => {
  const f = await relayFixture(true);
  try {
    await writeFile(join(f.home, "status.json"), '{"status":"connected"}');
    assert.equal(await activeNativeRelay(f.config), undefined);
    assert.deepEqual(await f.reasons(), ["unreachable"]);
  } finally { await f.close(); }
});

test("a connected relay on a live control socket is the relay that is used", { skip: process.platform === "win32", timeout: 20000 }, async t => {
  const f = await relayFixture(true);
  await writeFile(join(f.home, "status.json"), '{"status":"connected"}');
  await mkdir(resolve(f.home, "app-server-control"), { recursive: true, mode: 0o700 });
  const server = createServer();
  server.on("connection", socket => socket.end());
  try { server.listen(relaySocketPath(f.home)); await once(server, "listening"); }
  catch (error) { await new Promise(done => server.close(done)); return void t.skip(`this machine will not bind a private socket: ${(error as { message?: string }).message}`); }
  try {
    assert.equal((await activeNativeRelay(f.config))?.home, f.home);
    assert.deepEqual(await f.reasons(), [], "a live relay is never a skipped one");
  } finally { await new Promise(done => server.close(done)); await f.close(); }
});
