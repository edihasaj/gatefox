// Proves a packaged install cannot claim rollout readiness until its real private
// supervisor, inference server, execution host and direct-tool canary agree.
// It never contacts a provider, starts ChatGPT, or reads credentials.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { groupGone } from "./group-gone.mjs";

const exec = promisify(execFile);
const { values } = parseArgs({ options: {
  package: { type: "string" }, root: { type: "string" }, app: { type: "string" },
} });
for (const key of ["package", "root"]) assert.ok(values[key], `Pass --${key}`);

const source = resolve(values.package);
const evidenceRoot = resolve(values.root);
const app = resolve(values.app ?? "/Applications/ChatGPT.app");
const fixture = await realpath(await mkdtemp("/tmp/gwr-"));
const home = join(fixture, "home");
const native = join(fixture, "native");
const state = join(fixture, "state");
const work = join(fixture, "work");
const unpacked = join(fixture, "unpacked");
const prefix = join(home, ".local");
const resultPath = join(evidenceRoot, "rollout-readiness.json");
const expectedVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
assert.match(expectedVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/, "Use a canonical release version");

const evidence = {
  checkedAt: new Date().toISOString(),
  packageVersion: expectedVersion,
  installerRepeated: false,
  desktopPresetNoop: false,
  realService: false,
  inferenceServing: false,
  executionHostServing: false,
  plainBeforeVerify: "",
  verified: "",
  cachedAfterVerify: "",
  userNativeUnchanged: false,
  privateAuthAbsent: false,
  noProviderRequests: true,
  passed: false,
};

function cleanEnvironment(extra = {}) {
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, CODEX_HOME: native,
    GATEWAY_TELEMETRY: "off", GATEWAY_ERROR_REPORTS: "off",
    GATEWAY_ROLLOUT_FIXTURE_KEY: "fixture-only-not-a-provider-token", ...extra };
  return env;
}

async function command(file, args, options = {}) {
  try {
    const result = await exec(file, args, {
      cwd: options.cwd, env: options.env, timeout: options.timeout ?? 90_000,
      maxBuffer: 64 * 1024, windowsHide: true,
    });
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    return { code: typeof error?.code === "number" ? error.code : -1, stdout: String(error?.stdout ?? "") };
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise(done => server.close(done));
  return address.port;
}

/** The user configuration can be checked without traversing chat history or reading credentials. */
async function userNativeState(config, auth) {
  const configBytes = await readFile(config).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  const configDigest = configBytes ? createHash("sha256").update(configBytes).digest("hex") : "missing";
  const info = await lstat(auth).catch(error => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  // Authentication remains opaque: this only observes its filesystem metadata.
  const authMetadata = info ? `${info.dev}:${info.ino}:${info.mode & 0o777}:${info.size}:${Math.trunc(info.mtimeMs)}` : "missing";
  return { configDigest, authMetadata };
}

async function extractRelease() {
  const entry = await lstat(source);
  await mkdir(unpacked, { recursive: true, mode: 0o700 });
  if (entry.isFile()) {
    const extracted = await command("/usr/bin/tar", ["-xzf", source, "-C", unpacked], { env: cleanEnvironment() });
    assert.equal(extracted.code, 0, "The immutable release archive must extract");
    const children = await readdir(unpacked);
    assert.equal(children.length, 1, "The archive must have one release root");
    return join(unpacked, children[0]);
  }
  assert.ok(entry.isDirectory(), "--package must be a release archive or extracted release directory");
  // Release commands conventionally receive `<release>/package`. The installer
  // and bundled runtime are its siblings, so retain the parent release root.
  const parent = basename(source) === "package" && await lstat(join(resolve(source, ".."), "install")).then(info => info.isFile(), () => false)
    ? resolve(source, "..") : source;
  const destination = join(unpacked, "release");
  await cp(parent, destination, { recursive: true, preserveTimestamps: true });
  return destination;
}

async function until(check, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`${label} timed out`);
}

let daemon;
async function stopDaemon() {
  if (!daemon?.pid) return;
  try { process.kill(-daemon.pid, "SIGTERM"); } catch {}
  if (!await Promise.race([daemon.exited.then(() => true), delay(15_000).then(() => false)])) {
    try { process.kill(-daemon.pid, "SIGKILL"); } catch {}
  }
  assert.ok(await groupGone(daemon.pid, 10_000), "The private service process group must stop");
  daemon = undefined;
}

async function runRollout(gateway, config, verify = false) {
  const reply = await command(gateway, ["rollout", "--json", ...(verify ? ["--verify"] : []), "--config", config], { env: cleanEnvironment(), timeout: 120_000 });
  assert.ok(reply.stdout.length <= 64 * 1024, "Readiness output must remain bounded");
  assert.ok(reply.stdout.trim(), "Readiness must return JSON");
  const report = JSON.parse(reply.stdout);
  assert.equal(typeof report?.state, "string");
  assert.equal(typeof report?.reason, "string");
  return { code: reply.code, report };
}

try {
  const originalHome = homedir();
  const originalNative = resolve(originalHome, ".codex");
  const userNativeBefore = await userNativeState(join(originalNative, "config.toml"), join(originalNative, "auth.json"));
  assert.ok((await lstat(app)).isDirectory(), "The read-only desktop app is required to derive its real Codex path");

  for (const path of [evidenceRoot, home, native, state, work]) await mkdir(path, { recursive: true, mode: 0o700 });
  await command("/usr/bin/git", ["init", "--quiet"], { cwd: work, env: cleanEnvironment() }).then(result => assert.equal(result.code, 0));
  await command("/usr/bin/git", ["config", "user.name", "Gateway readiness fixture"], { cwd: work, env: cleanEnvironment() }).then(result => assert.equal(result.code, 0));
  await command("/usr/bin/git", ["config", "user.email", "gateway-readiness@example.invalid"], { cwd: work, env: cleanEnvironment() }).then(result => assert.equal(result.code, 0));

  const release = await extractRelease();
  const packaged = JSON.parse(await readFile(join(release, "package", "package.json"), "utf8"));
  assert.equal(packaged.version, expectedVersion, "The packaged release must match this verification checkout");
  const installer = join(release, "install");
  assert.ok((await lstat(installer)).isFile(), "The packaged installer is required");
  for (let install = 0; install < 2; install++) {
    const result = await command(installer, ["--prefix", prefix], { cwd: release, env: cleanEnvironment(), timeout: 120_000 });
    assert.equal(result.code, 0, "The packaged installer must succeed");
  }
  evidence.installerRepeated = true;

  const installed = join(prefix, "share", "subscription-gateway", "releases", expectedVersion);
  const gateway = join(prefix, "bin", "harness-gateway");
  const receipt = JSON.parse(await readFile(join(installed, "package", "release.json"), "utf8"));
  assert.equal(receipt.version, expectedVersion, "The installed immutable receipt must match the candidate");
  assert.equal(await realpath(join(prefix, "share", "subscription-gateway", "current")), installed, "Current must resolve to the installed candidate");

  const port = await reservePort();
  const config = join(fixture, "gateway.json");
  await writeFile(config, JSON.stringify({
    version: 1, port, stateDirectory: state, timeoutMs: 30_000,
    providers: [{ id: "fixture", type: "responses-api", baseUrl: "http://127.0.0.1:9/v1",
      apiKeyEnv: "GATEWAY_ROLLOUT_FIXTURE_KEY", models: { "fixture/readiness": "fixture-model" } }],
  }, null, 2) + "\n", { mode: 0o600 });
  await writeFile(join(state, "service-plan.json"), JSON.stringify({
    version: 1, config, sharedExecutors: true, sharedNativeExecutor: false,
    components: [
      { id: "inference", kind: "inference", command: gateway, args: ["serve", "--config", config], log: join(state, "inference.log"),
        environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
      // This is the service's real desktop-completion branch. /usr/bin/true receives
      // the production-shaped --app argument but never launches or mutates the app.
      { id: "desktop", kind: "desktop", command: "/usr/bin/true", args: ["--app", app], log: join(state, "desktop.log") },
    ],
  }, null, 2) + "\n", { mode: 0o600 });
  await assert.rejects(readFile(join(state, "desktop-registration.json"), "utf8"), { code: "ENOENT" });
  evidence.desktopPresetNoop = true;

  daemon = spawn(gateway, ["daemon", "--config", config], { detached: true, stdio: "ignore", env: cleanEnvironment() });
  daemon.exited = new Promise(done => daemon.once("close", done));
  const status = await until(async () => {
    try {
      const value = JSON.parse(await readFile(join(state, "service-status.json"), "utf8"));
      return value?.pid === daemon.pid && value?.runningRelease === expectedVersion
        && value?.executionHost?.state === "running"
        && value?.components?.some(component => component?.id === "inference" && component?.state === "running")
        && value?.components?.some(component => component?.id === "desktop" && component?.state === "complete") ? value : undefined;
    } catch { return undefined; }
  }, "private supervisor readiness");
  assert.equal(status.executionHost.sharedGatewayExecutors, true);
  evidence.realService = true;

  await until(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      return response.status === 200 && response.headers.get("x-gateway-release") === expectedVersion;
    } catch { return false; }
  }, "private inference health");
  evidence.inferenceServing = true;

  const before = await runRollout(gateway, config);
  assert.equal(before.code, 1, "A cached-free rollout must remain pending");
  assert.equal(before.report.state, "pending");
  assert.equal(before.report.reason, "probe_pending");
  evidence.plainBeforeVerify = before.report.reason;

  const verified = await runRollout(gateway, config, true);
  assert.equal(verified.code, 0, "A fresh packaged canary must make rollout ready");
  assert.equal(verified.report.state, "ready");
  assert.equal(verified.report.reason, "ready");
  assert.equal(verified.report.installed, expectedVersion);
  assert.equal(verified.report.inference?.release, expectedVersion);
  assert.equal(verified.report.host?.runningRelease, expectedVersion);
  assert.equal(verified.report.probe?.directToolVerified, true);
  assert.equal(verified.report.probe?.completedTurn, true);
  assert.equal(verified.report.probe?.commandVerified, true);
  evidence.executionHostServing = true;
  evidence.verified = verified.report.reason;

  const cached = await runRollout(gateway, config);
  assert.equal(cached.code, 0);
  assert.equal(cached.report.state, "ready");
  assert.equal(cached.report.reason, "ready");
  evidence.cachedAfterVerify = cached.report.reason;

  await assert.rejects(readFile(join(native, "auth.json"), "utf8"), { code: "ENOENT" });
  evidence.privateAuthAbsent = true;
  assert.deepEqual(await userNativeState(join(originalNative, "config.toml"), join(originalNative, "auth.json")),
    userNativeBefore, "The user's native configuration must be unchanged");
  evidence.userNativeUnchanged = true;
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message.replaceAll(fixture, "<fixture>") : "readiness_check_failed";
  process.exitCode = 1;
} finally {
  await stopDaemon().catch(error => { evidence.cleanupFailed = error instanceof Error ? error.message : "cleanup_failed"; process.exitCode = 1; });
  await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {});
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await writeFile(resultPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
}
