import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shortFolder } from "./short-folder.js";
import { healthCommand, healthUsage, type HealthCommandDeps } from "../health.js";
import type { VersionsResult } from "../versions.js";
import type { ServiceStatus } from "../health-checks.js";

const at = Date.parse("2026-10-16T09:00:00.000Z");

/** Every folder this file made, removed when the file's tests are done. */
const folders: Array<() => Promise<void>> = [];
async function folder(prefix: string): Promise<string> {
  const made = await shortFolder(prefix);
  folders.push(made.remove);
  return made.directory;
}

/** A config file for a quiet Mac: remote client, so no loopback probe is attempted. */
async function config(): Promise<{ directory: string; path: string; stateDirectory: string }> {
  const directory = await folder("gw-health-cmd-");
  const stateDirectory = join(directory, "state");
  const path = join(directory, "gateway.json");
  await writeFile(path, JSON.stringify({ version: 1, port: 3457, stateDirectory, clientOnly: true, providers: [] }));
  return { directory, path, stateDirectory };
}

/** The command with every machine touch replaced and the output collected. */
async function run(args: string[], extra: Partial<HealthCommandDeps> = {}) {
  const config_file = await config();
  const out: string[] = [];
  const err: string[] = [];
  const versions: VersionsResult = { installed: "0.4.4", lagging: 0, processes: [{ role: "service", pid: 1, startedAt: new Date(at).toISOString(), release: "0.4.4" }] };
  const code = await healthCommand(args, {
    now: () => at,
    stdout: text => out.push(text),
    stderr: text => err.push(text),
    configPath: async () => config_file.path,
    exists: async () => false,
    state: async () => undefined,
    writeState: async () => {},
    readPlan: async () => undefined,
    readStatus: async (): Promise<ServiceStatus> => ({ installed: false, components: [], published: false }),
    versions: async () => versions,
    telemetry: async () => [],
    ...extra,
  });
  return { code, out: out.join(""), err: err.join("") };
}

test("--help prints usage and needs no configuration", async () => {
  const { code, out } = await run(["--help"]);
  assert.equal(code, 0);
  assert.equal(out, healthUsage);
});

test("an unknown flag is refused with the usage line", async () => {
  const { code, err } = await run(["--json", "--nope"]);
  assert.equal(code, 2);
  assert.equal(err, healthUsage);
});

test("a Mac with no readable configuration fails with a fixed message", async () => {
  const directory = await folder("gw-health-nocfg-");
  const { code, err } = await run([], { configPath: async () => join(directory, "absent.json") });
  assert.equal(code, 2);
  assert.equal(err, "health: no readable gateway configuration on this Mac\n");
});

test("the human summary and --json agree on the verdict", async () => {
  const plain = await run([]);
  assert.equal(plain.code, 0);
  assert.match(plain.out, /^verdict ok/);
  assert.match(plain.out, /service\s+not installed/);
  const json = await run(["--json"]);
  assert.equal(json.code, 0);
  const report = JSON.parse(json.out);
  assert.equal(report.verdict, "ok");
  assert.equal(report.at, new Date(at).toISOString());
  assert.equal(report.inference.state, "skipped");
});

test("exit codes follow the verdict and the push answer", async () => {
  const lag: Partial<HealthCommandDeps> = { versions: async () => ({ installed: "0.4.4", lagging: 1, processes: [{ role: "inference" as const, pid: 1, startedAt: new Date(at).toISOString(), release: "0.4.2" }] }) };
  assert.equal((await run(["--json"], lag)).code, 1);
  const noRelease: Partial<HealthCommandDeps> = { versions: async () => ({ installed: null, lagging: 0, processes: [] }) };
  // Three refusals in the window are a fail, and fail exits 2. One on its own is only a warn.
  const refused = await run(["--json"], { telemetry: async () => [
    { event: "rpc_error", method: "thread/start", code: -32001, rejection: "adapter_routing", at },
    { event: "rpc_error", method: "turn/start", code: -32001, rejection: "adapter_routing", at },
    { event: "rpc_error", method: "thread/resume", rejection: "other", at },
  ], ...noRelease });
  assert.equal(JSON.parse(refused.out).verdict, "fail");
  assert.equal(refused.code, 2);
});

test("--push reaches the monitor named by the injected reader, quietly", async () => {
  const secret = "https://kuma.invalid.example/api/push/Zm9vYmFy";
  const sent: string[] = [];
  const { code, out } = await run(["--push", "--json"], {
    pushUrl: async () => ({ url: secret }),
    pushSend: async url => { sent.push(url); return { state: "sent", up: true }; },
  });
  assert.deepEqual(sent, [secret]);
  assert.equal(code, 0);
  assert.equal(out.includes(secret), false);
  assert.equal(JSON.parse(out).push.state, "sent");
  // The URL file itself is never opened for reading by the command layer either.
  const insecure = await run(["--push"], { pushUrl: async () => ({ error: "insecure" }) });
  assert.equal(insecure.code, 2);
  assert.match(insecure.out, /push\s+insecure/);
  assert.match(insecure.out, /alert push url not private/);
  // The same answer on stderr, in one fixed sentence: no path, and nothing from the file.
  assert.equal(insecure.err, "health: the alert push URL is not private; fix its permissions or remove the file\n");
  assert.equal(insecure.err.includes(secret), false);
  const quiet = await run(["--push"], { pushUrl: async () => ({ url: secret }), pushSend: async () => ({ state: "sent", up: true }) });
  assert.equal(quiet.err, "");
});

test("the command tests leave no folder behind", async () => {
  for (const remove of folders) await remove();
});
