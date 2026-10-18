#!/usr/bin/env node
// Private command shim for the native setup-wizard fixture. It never touches launchd.
import { spawn } from "node:child_process";
import { access, chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const home = process.env.HOME;
const metadataPath = home && join(home, ".app-wizard-fixture", "metadata.json");
if (!metadataPath) fail("Fixture home is unavailable.");
let metadata;
try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); } catch { fail("Fixture metadata is unavailable."); }

const args = process.argv.slice(2);
const configIndex = args.lastIndexOf("--config");
if (configIndex < 0 || configIndex !== args.length - 2 || args.filter(value => value === "--config").length !== 1 ||
  resolve(args[configIndex + 1]) !== metadata.configPath) fail("Fixture command arguments are invalid.");
const command = args.slice(0, configIndex);
const daemonPath = join(home, ".app-wizard-fixture", "daemon.json");
const desktopPath = join(home, ".app-wizard-fixture", "desktop.json");

if (same(command, ["service", "status", "--json"])) {
  const daemon = await privateJson(daemonPath); const running = daemon && alive(daemon.pid);
  process.stdout.write(JSON.stringify({ installed: Boolean(running), ...(running ? { pid: daemon.pid } : {}) }) + "\n");
} else if (same(command, ["service", "install"])) {
  await install();
} else if (same(command, ["desktop", "status", "--json"])) {
  const desktop = await privateJson(desktopPath);
  process.stdout.write(JSON.stringify({ registered: desktop?.registered === true, activeForFutureLaunches: desktop?.registered === true,
    forceCliSet: false, staleWrapper: false }) + "\n");
} else if (same(command, ["desktop", "register"])) {
  await privateWrite(desktopPath, { registered: true });
} else {
  fail("Fixture command is not supported.");
}

function same(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function alive(pid) { if (!Number.isInteger(pid) || pid <= 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function fail(message) { process.stderr.write(message + "\n"); process.exit(64); }
async function privateJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
}
async function privateWrite(path, value) {
  await writeFile(path, JSON.stringify(value) + "\n", { mode: 0o600 }); await chmod(path, 0o600);
}
async function install() {
  const previous = await privateJson(daemonPath);
  if (previous && alive(previous.pid)) return;
  let config;
  try { config = JSON.parse(await readFile(metadata.configPath, "utf8")); } catch { fail("Fixture configuration is unavailable."); return; }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) { fail("Fixture configuration is invalid."); return; }
  const gateway = metadata.realGateway;
  try { await access(gateway, constants.X_OK); } catch { fail("Fixture gateway is unavailable."); return; }
  const gatewayArgs = gateway.endsWith(".js") || gateway.endsWith(".mjs") ? [gateway, "serve", "--config", metadata.configPath] : ["serve", "--config", metadata.configPath];
  const executable = gatewayArgs[0] === gateway ? metadata.node : gateway;
  const child = spawn(executable, gatewayArgs, { detached: true, stdio: "ignore", env: {
    HOME: metadata.home, USER: process.env.USER || "fixture", LOGNAME: process.env.LOGNAME || "fixture", TMPDIR: "/tmp",
    PATH: metadata.path,
  } });
  if (!child.pid) { fail("Fixture gateway did not start."); return; }
  child.unref(); await privateWrite(daemonPath, { pid: child.pid, configPath: metadata.configPath });
  const baseUrl = `http://127.0.0.1:${config.port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(baseUrl + "/health").then(response => response.ok).catch(() => false)) return;
    if (!alive(child.pid)) break;
    await delay(100);
  }
  await stop(child.pid); await unlink(daemonPath).catch(() => {}); fail("Fixture gateway did not become healthy.");
}
async function stop(pid) {
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  await delay(100);
}
