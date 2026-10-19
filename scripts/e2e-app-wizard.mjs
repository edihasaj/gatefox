#!/usr/bin/env node
// Isolated real-gateway coverage for the native setup wizard. No user config or service is read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const { values } = parseArgs({ options: { management: { type: "string", default: "dist/app-management.js" }, gateway: { type: "string", default: join(homedir(), ".local/bin/gateway") },
  "serve-fixture": { type: "boolean", default: false }, output: { type: "string" } }, strict: true });
const managementPath = resolve(values.management), gatewayPath = resolve(values.gateway);
const outputRoot = values.output ? resolve(values.output) : undefined;
const root = await privateRoot(outputRoot); const home = join(root, "home");
const configPath = join(home, "Library", "Application Support", "SubscriptionGateway", "gateway.json");
const owned = new Set(); let upstream; let rootKept = Boolean(outputRoot); let fixtureDaemonPath;
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void signalCleanup(); });

try {
  await mkdir(home, { recursive: true, mode: 0o700 }); await chmod(home, 0o700);
  upstream = await upstreamFixture();
  if (values["serve-fixture"]) await serveFixture(); else await normalRun();
} catch (error) {
  process.exitCode = 1;
  process.stdout.write(JSON.stringify({ status: "failed", root, check: safe(error?.message || "fixture failed") }) + "\n");
} finally {
  for (const child of owned) await stop(child);
  if (upstream) await closeServer(upstream.server);
  if (!rootKept && !values["serve-fixture"]) await removeOwnedRoot();
}

async function privateRoot(output) {
  if (output) {
    await access(output).then(() => { throw Error("--output must name a new directory"); }, error => { if (error?.code !== "ENOENT") throw error; });
    await mkdir(output, { recursive: false, mode: 0o700 }); await chmod(output, 0o700); return output;
  }
  const path = await mkdtemp(join(tmpdir(), "harness-wizard-")); await chmod(path, 0o700); return path;
}
function fixtureEnv() { return { HOME: home, USER: "fixture", LOGNAME: "fixture", TMPDIR: "/tmp", PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` }; }
async function ensureExecutable(path) { await access(path, constants.X_OK); }
async function upstreamFixture() {
  let requests = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "fixture-one" }, { id: "fixture-two" }] })); return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      let size = 0; const chunks = []; for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) { response.writeHead(413); response.end(); return; } chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { response.writeHead(400); response.end(); return; }
      if (body.stream !== true) { response.writeHead(400); response.end(); return; }
      requests++;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
      emit({ id: "fixture-chat", object: "chat.completion.chunk", model: "fixture-one", choices: [{ index: 0, delta: { content: "app-wizard-e2e-ok" }, finish_reason: null }] });
      emit({ id: "fixture-chat", object: "chat.completion.chunk", model: "fixture-one", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      response.end("data: [DONE]\n\n"); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls: () => requests };
}
async function normalRun() {
  await ensureExecutable(gatewayPath); await access(managementPath, constants.R_OK);
  const native = await nativeSentinels(); const before = await digests(native);
  await assert.rejects(() => lstat(configPath), { code: "ENOENT" });
  let result = await management({ operation: "inspect", configPath }); assert.equal(result.providers?.length, 0);
  const first = await management({ operation: "prepare", configPath, provider: provider("Fixture primary", "fixture-primary", "fixture-secret-one") });
  const firstDraft = first.draft.id;
  result = await management({ operation: "discover", configPath, draftId: firstDraft }); const selected = modelIds(result.models); assert.deepEqual(selected, ["fixture-one", "fixture-two"]);
  result = await management({ operation: "commit", configPath, draftId: firstDraft, selectedModels: ["fixture-one"] });
  assert.equal(result.changed, true); await assertMode(configPath, 0o600);
  await assertMode(JSON.parse(await readFile(configPath, "utf8")).providers[0].credentialFile, 0o600); let revision = result.revision;
  const initial = JSON.parse(await readFile(configPath, "utf8")); initial.unknownRoot = { fixtureSentinel: true }; initial.providers[0].unknownProvider = "preserve";
  await writeFile(configPath, JSON.stringify(initial) + "\n", { mode: 0o600 });
  result = await management({ operation: "inspect", configPath }); revision = result.revision;
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.ok(await portAvailable(config.port), `New configuration selected busy loopback port ${config.port}`);
  const catalog = await gateway(["catalog", "--config", configPath]); assert.ok(JSON.parse(catalog.stdout).models.some(model => model.slug === "fixture-primary/fixture-one"));
  const running = gatewayServe(); await waitForHealth(running, config.port);
  const token = (await readFile(join(config.stateDirectory, "client-token"), "utf8")).trim();
  const inference = await fetch(`http://127.0.0.1:${config.port}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "fixture-primary/fixture-one", input: "Reply with the local fixture marker." }) });
  assert.ok(inference.ok, "Gateway inference request failed"); assert.ok(JSON.stringify(await inference.json()).includes("app-wizard-e2e-ok"), "Gateway did not translate the upstream response");
  result = await management({ operation: "authenticate", configPath, providerId: "fixture-primary", revision, provider: { apiKey: "fixture-secret-rotated" } });
  result = await management({ operation: "discover", configPath, providerId: "fixture-primary" }); assert.deepEqual(modelIds(result.models), ["fixture-one", "fixture-two"]);
  result = await management({ operation: "inspect", configPath }); revision = result.revision;
  const second = await management({ operation: "prepare", configPath, provider: provider("Fixture secondary", "fixture-secondary", "fixture-secret-two") });
  result = await management({ operation: "discover", configPath, draftId: second.draft.id }); assert.ok(modelIds(result.models).includes("fixture-two"));
  result = await management({ operation: "commit", configPath, draftId: second.draft.id, selectedModels: ["fixture-two"] }); revision = result.revision;
  const preserved = JSON.parse(await readFile(configPath, "utf8")); assert.equal(preserved.unknownRoot.fixtureSentinel, true); assert.equal(preserved.providers[0].unknownProvider, "preserve");
  await expectError({ operation: "models", configPath, providerId: "fixture-primary", revision, selectedModels: [] }, "invalid_request");
  result = await management({ operation: "models", configPath, providerId: "fixture-primary", revision, selectedModels: ["fixture-one"] }); assert.equal(result.changed, false);
  result = await management({ operation: "rename", configPath, providerId: "fixture-primary", revision, label: "Fixture primary renamed" }); assert.equal(result.changed, true); const current = result.revision;
  result = await management({ operation: "rename", configPath, providerId: "fixture-primary", revision: current, label: "Fixture primary renamed" }); assert.equal(result.changed, false);
  await expectError({ operation: "models", configPath, providerId: "fixture-primary", revision, selectedModels: ["fixture-one"] }, "configuration_changed");
  result = await management({ operation: "remove", configPath, providerId: "fixture-secondary", revision: result.revision });
  await expectError({ operation: "remove", configPath, providerId: "fixture-primary", revision: result.revision }, "invalid_configuration");
  const digestBeforeDiscard = await digest(configPath); const cancelled = await management({ operation: "prepare", configPath, provider: provider("Discarded fixture", "discarded-fixture", "fixture-secret-discard") });
  result = await management({ operation: "discard", configPath, draftId: cancelled.draft.id }); assert.equal(result.changed, false); assert.equal(await digest(configPath), digestBeforeDiscard);
  assert.deepEqual(await digests(native), before); assert.ok(upstream.calls() >= 1);
  await stop(running); owned.delete(running);
  process.stdout.write(JSON.stringify({ status: "passed", root, configPath, baseUrl: `http://127.0.0.1:${JSON.parse(await readFile(configPath, "utf8")).port}`,
    ready: true, newConfiguration: true, management: true, realInference: true, cancel: true, stale: true, nativeIsolation: true, upstreamCalls: upstream.calls() }) + "\n");
}
function provider(label, id, apiKey) { return { label, id, type: "chat-completions-api", baseUrl: upstream.baseUrl, apiKey }; }
function modelIds(models = []) { return models.map(model => model.id).sort(); }
async function management(request) {
  const result = await run(process.execPath, [managementPath], JSON.stringify(request), fixtureEnv());
  assert.ok(!result.stdout.includes("fixture-secret") && !result.stderr.includes("fixture-secret"), "Management process leaked a fixture secret");
  const response = JSON.parse(result.stdout); if (!response.ok) throw Object.assign(Error(response.error.code), { code: response.error.code }); return response.result;
}
async function expectError(request, code) { await assert.rejects(() => management(request), error => error?.code === code); }
function gatewayServe() { const child = command(gatewayPath, ["serve", "--config", configPath]); owned.add(child); return child; }
function command(path, args, options = {}) { return spawn(path.endsWith(".js") || path.endsWith(".mjs") ? process.execPath : path, path.endsWith(".js") || path.endsWith(".mjs") ? [path, ...args] : args, { detached: true, env: fixtureEnv(), stdio: ["ignore", "ignore", "ignore"], ...options }); }
async function gateway(args) { return run(gatewayPath.endsWith(".js") || gatewayPath.endsWith(".mjs") ? process.execPath : gatewayPath, gatewayPath.endsWith(".js") || gatewayPath.endsWith(".mjs") ? [gatewayPath, ...args] : args, undefined, fixtureEnv()); }
async function run(executable, args, input, env) {
  const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] }); let stdout = "", stderr = "";
  const collect = (stream, into) => stream.on("data", chunk => { if ((into === "stdout" ? stdout : stderr).length + chunk.length > 2 * 1024 * 1024) child.kill("SIGTERM"); else if (into === "stdout") stdout += chunk; else stderr += chunk; });
  collect(child.stdout, "stdout"); collect(child.stderr, "stderr"); if (input) child.stdin.end(input); else child.stdin.end();
  let timeout; let outcome;
  try { outcome = await Promise.race([once(child, "close"), new Promise((_, reject) => { timeout = setTimeout(() => { child.kill("SIGTERM"); reject(Error("Child process timed out")); }, 30000); })]); }
  finally { clearTimeout(timeout); }
  if (outcome[0] !== 0) throw Error("Child process failed"); return { stdout, stderr };
}
async function portAvailable(port) {
  const reservation = createServer();
  try { await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(port, "127.0.0.1", resolve); }); return true; }
  catch { return false; } finally { await new Promise(resolve => reservation.close(resolve)); }
}
async function waitForHealth(child, port) {
  await delay(100);
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error("Owned gateway exited before health check");
    if (await fetch(`http://127.0.0.1:${port}/health`).then(response => response.ok).catch(() => false)) return;
    await delay(100);
  }
  throw Error("Owned gateway health timed out");
}
async function nativeSentinels() { const codex = join(home, ".codex"); await mkdir(codex, { recursive: true, mode: 0o700 }); const config = join(codex, "config.toml"), auth = join(codex, "auth.json"); await writeFile(config, "model = \"native-sentinel\"\n", { mode: 0o600 }); await writeFile(auth, "{\"native\":true}\n", { mode: 0o600 }); return [config, auth]; }
async function digest(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function digests(paths) { return Promise.all(paths.map(digest)); }
async function assertMode(path, mode) { assert.equal((await stat(path)).mode & 0o777, mode); }
async function stop(child) { if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return; const done = once(child, "close"); try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } if (!await Promise.race([done.then(() => true), delay(3000).then(() => false)])) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await done; } }
async function closeServer(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function removeOwnedRoot() { await rm(root, { recursive: true, force: true }); }
function safe(value) { return String(value).replace(/fixture-secret[^\s"']*/g, "<redacted>").replace(/Bearer\s+\S+/gi, "Bearer <redacted>"); }
async function serveFixture() {
  await ensureExecutable(gatewayPath); await access(managementPath, constants.R_OK);
  const fixtureDirectory = join(home, ".app-wizard-fixture"); await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 }); await chmod(fixtureDirectory, 0o700);
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "app-wizard-fixture-cli.mjs"); const metadata = { home, configPath, realGateway: gatewayPath, node: process.execPath,
    path: `${dirname(process.execPath)}:${join(home, ".local", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin` };
  fixtureDaemonPath = join(fixtureDirectory, "daemon.json"); await writeFile(join(fixtureDirectory, "metadata.json"), JSON.stringify(metadata) + "\n", { mode: 0o600 });
  const launcher = join(home, ".local", "bin", "gateway"); await mkdir(dirname(launcher), { recursive: true, mode: 0o700 });
  await writeFile(launcher, `#!/bin/sh\n# Managed by subscription-gateway installer\nexec ${quote(process.execPath)} ${quote(cli)} \"$@\"\n`, { mode: 0o700 }); await chmod(launcher, 0o700);
  const publicMetadata = { root, home, configPath, baseUrl: upstream.baseUrl, managementPath, ready: true };
  await writeFile(join(root, "fixture.json"), JSON.stringify(publicMetadata, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify(publicMetadata) + "\n"); rootKept = true;
  await new Promise(() => {});
}
function quote(path) { return `'${path.replaceAll("'", "'\\''")}'`; }
async function stopPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  await delay(100);
}
async function signalCleanup() {
  for (const child of owned) await stop(child);
  if (fixtureDaemonPath) {
    const daemon = await readFile(fixtureDaemonPath, "utf8").then(JSON.parse).catch(() => undefined);
    if (daemon?.pid) await stopPid(daemon.pid);
  }
  if (upstream) await closeServer(upstream.server).catch(() => {});
  process.exit(143);
}
