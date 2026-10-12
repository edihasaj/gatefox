import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serviceTunnelArguments } from "../service-tunnel.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor } from "../service-supervisor.js";

const original = ["-N", "-T", "-F", "/private/SSH Profile/config", "-o", "BatchMode=yes", "-o", "RequestTTY=no", "-R", "127.0.0.1:3459:127.0.0.1:3457", "user@fixture-host"];

test("legacy managed tunnel defaults leave its endpoint, profile and stored arguments unchanged", () => {
  const saved = [...original]; const normalized = serviceTunnelArguments(original);
  assert.deepEqual(original, saved); assert.deepEqual(normalized.slice(-original.length), original);
  assert.deepEqual(serviceTunnelArguments(normalized), normalized, "retries do not duplicate defaults");
});

test("explicit split, attached, combined and case-insensitive SSH options retain their values", () => {
  for (const options of [
    ["-o", "ConnectTimeout=45", "-o", "ConnectionAttempts=3"],
    ["-oconnecttimeout=45", "-oConnectionAttempts=3"],
    ["-NToConnectTimeout 45", "-o", "connectionattempts 3"],
  ]) {
    const args = [...options, ...original]; assert.deepEqual(serviceTunnelArguments(args), args);
  }
  const onlyTimeout = ["-o", "ConnectTimeout=45", ...original];
  assert.deepEqual(serviceTunnelArguments(onlyTimeout), ["-o", "ConnectionAttempts=1", ...onlyTimeout]);
});

test("option names inside profile paths or remote command text never disable outage defaults", () => {
  const args = ["-F", "/private/ConnectTimeout=90", "fixture-host", "-o", "ConnectionAttempts=7"];
  assert.deepEqual(serviceTunnelArguments(args).slice(0, 4), ["-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1"]);
});

test("the system SSH parser applies new defaults and preserves explicit connection values", { skip: process.platform !== "darwin" }, async () => {
  const effective = async (options: string[]) => {
    const { stdout } = await promisify(execFile)("/usr/bin/ssh", ["-G", ...serviceTunnelArguments(["-F", "/dev/null", ...options, "-N", "-T", "-R", "127.0.0.1:3459:127.0.0.1:3457", "fixture-host"])]);
    return new Map(stdout.split("\n").map(line => { const space = line.indexOf(" "); return [line.slice(0, space), line.slice(space + 1)] as const; }));
  };
  const defaults = await effective([]); assert.equal(defaults.get("connecttimeout"), "10"); assert.equal(defaults.get("connectionattempts"), "1");
  const explicit = await effective(["-oconnecttimeout=45", "-o", "ConnectionAttempts 3"]); assert.equal(explicit.get("connecttimeout"), "45"); assert.equal(explicit.get("connectionattempts"), "3");
  assert.equal(defaults.get("host"), "fixture-host"); assert.equal(explicit.get("remoteforward"), defaults.get("remoteforward"));
});

test("unified supervisor applies defaults to a new legacy SSH child without rewriting its plan", { skip: process.platform !== "darwin", timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-tunnel-defaults-")); const log = join(directory, "ssh.log");
  const args = ["-G", "-F", "/dev/null", "-N", "-T", "-R", "127.0.0.1:3459:127.0.0.1:3457", "fixture-host"];
  const plan = { version: 1 as const, config: join(directory, "gateway.json"), components: [{ id: "tunnel-fixture", kind: "tunnel" as const, command: "/usr/bin/ssh", args, log }] };
  const before = JSON.stringify(plan); const supervisor = new ServiceSupervisor(plan, directory);
  try {
    await supervisor.start(); let output = "";
    for (let attempt = 0; attempt < 100; attempt++) { output = await readFile(log, "utf8"); if (/^connecttimeout 10$/m.test(output)) break; await delay(20); }
    assert.match(output, /^connecttimeout 10$/m); assert.match(output, /^connectionattempts 1$/m);
    assert.equal(JSON.stringify(plan), before);
  } finally { await supervisor.stop(); await rm(directory, { recursive: true, force: true }); }
});
