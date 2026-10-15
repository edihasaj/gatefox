import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, symlink, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTelemetry } from "../telemetry.js";
import { gatewayToken } from "../config.js";
import { cliFailureMessage } from "../cli.js";

test("npm-style CLI symlinks execute help and version without a provider configuration", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-cli-"));
  const entry = join(directory, "gateway");
  await symlink(fileURLToPath(new URL("../cli.js", import.meta.url)), entry);
  const run = promisify(execFile);
  const options = { env: { ...process.env, GATEWAY_CONFIG: join(directory, "absent.json") }, cwd: directory };
  const version = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version;
  assert.equal((await run(process.execPath, [entry, "--version"], options)).stdout.trim(), version);
  assert.match((await run(process.execPath, [entry, "--help"], options)).stdout, /gateway codex-config/);
  await assert.rejects(run(process.execPath, [entry, "providers"], options), /Configuration file is unreadable/);
});

async function serve(drainMs: string) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-cli-shutdown-"));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; probe.close();
  const config = join(directory, "gateway.json"); const state = join(directory, "state");
  await writeFile(config, JSON.stringify({ version: 1, port, stateDirectory: state, providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_CLI_SHUTDOWN_FIXTURE_KEY", models: { fixture: "upstream" } }] }), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../cli.js", import.meta.url)), "serve", "--config", config], {
    env: { ...process.env, GATEWAY_SHUTDOWN_DRAIN_MS: drainMs, GATEWAY_ERROR_REPORTS: "off", GATEWAY_TELEMETRY: "" }, stdio: ["ignore", "ignore", "pipe"] });
  const cleanup = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit").catch(() => {}); } await rm(directory, { recursive: true, force: true }); };
  try { await new Promise<void>((resolve, reject) => { child.stderr!.on("data", chunk => { if (String(chunk).includes("Listening")) resolve(); }); child.once("exit", code => reject(new Error(`server exited ${code}`))); }); }
  catch (error) { await cleanup(); throw error; }
  const stop = async (signal: NodeJS.Signals) => { const started = Date.now(); const exited = once(child, "exit"); child.kill(signal); const [code] = await exited; return { code, elapsed: Date.now() - started }; };
  const signals = async () => (await readTelemetry(state, Date.now() - 600000)).filter(event => event.event === "server_shutdown_signal").map(event => event.signal);
  return { port, state, stop, signals, cleanup };
}

test("serve records the shutdown signal before it exits", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const server = await serve("8000");
  try {
    const { code, elapsed } = await server.stop("SIGTERM");
    assert.equal(code, 0); assert.ok(elapsed < 5000, `an idle server exits at once (${elapsed} ms)`);
    assert.deepEqual(await server.signals(), ["SIGTERM"]);
  } finally { await server.cleanup(); }
});

test("serve waits the drain deadline for a connection that never finishes", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const server = await serve("1000"); let socket: Socket | undefined;
  try {
    socket = connect(server.port, "127.0.0.1"); await once(socket, "connect");
    // An unfinished body upload keeps its connection open through server.close().
    socket.write(`POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${await gatewayToken(server.state)}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    for (let attempt = 0; ((await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as { active: number }).active !== 1; attempt++) {
      assert.ok(attempt < 100, "upload did not reach the handler"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const { code, elapsed } = await server.stop("SIGINT");
    assert.equal(code, 0);
    assert.ok(elapsed >= 2400, `the deadline is the drain plus 1.5 s, not a fixed 2 s (${elapsed} ms)`);
    assert.deepEqual(await server.signals(), ["SIGINT"]);
  } finally { socket?.destroy(); await server.cleanup(); }
});

test("cliFailureMessage hides what a JSON parse error quoted from the file", () => {
  let broken: unknown; let leaked: unknown;
  try { JSON.parse("{bad"); } catch (error) { broken = error; }
  try { JSON.parse('{"wrapper": gh_pat_secret_value'); } catch (error) { leaked = error; }
  assert.ok(broken instanceof SyntaxError && leaked instanceof SyntaxError);
  assert.equal(cliFailureMessage(broken), "Invalid JSON data");
  assert.equal(cliFailureMessage(leaked), "Invalid JSON data");
  assert.equal(cliFailureMessage(new Error("Unknown command; run gateway --help")), "Unknown command; run gateway --help");
  assert.equal(cliFailureMessage(undefined), "Command failed");
});

test("desktop status reports a corrupt registration as invalid JSON only", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-cli-json-"));
  const home = join(directory, "home"); const state = join(directory, "state");
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(state, { recursive: true, mode: 0o700 });
  const config = join(directory, "gateway.json");
  await writeFile(config, JSON.stringify({ version: 1, port: 3457, stateDirectory: state, providers: [{ id: "api", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_CLI_JSON_FIXTURE_KEY", models: { fixture: "upstream" } }] }), { mode: 0o600 });
  await writeFile(join(state, "desktop-registration.json"), '{"wrapper": gh_pat_secret_value', { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../cli.js", import.meta.url)), "desktop", "status", "--config", config], {
    env: { ...process.env, GATEWAY_CONFIG: config, HOME: home, GATEWAY_TELEMETRY: "off", GATEWAY_ERROR_REPORTS: "off" },
    stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout!.on("data", chunk => { stdout += chunk; }); child.stderr!.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  await rm(directory, { recursive: true, force: true });
  assert.equal(code, 2);
  assert.equal(stderr, "gateway: Invalid JSON data\n");
  assert.equal(stdout, "");
});
