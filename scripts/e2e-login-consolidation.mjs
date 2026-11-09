#!/usr/bin/env node
// Usage: node scripts/e2e-login-consolidation.mjs /absolute/installed/bin/gateway
// Actual launchd proof; only this invocation's namespaced fixture jobs are changed.
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile), script = fileURLToPath(import.meta.url);
let interrupted = false;
const delay = ms => new Promise(done => setTimeout(done, ms));
const hash = value => createHash("sha256").update(value).digest("hex");
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const present = path => access(path).then(() => true, () => false);
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = async (path, value) => { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); await chmod(path, 0o600); };
const failure = error => /activates only in its primary launchd process/.test(error.message) ? "PRIMARY_OWNERSHIP"
  : /earlier gateway login job remains loaded/.test(error.message) ? "RETIRED_JOB_LOADED" : "PROMOTION_FAILED";
function requireProof(value, code) { if (!value) throw new Error(code); }
async function status(label) {
  try {
    const { stdout } = await exec("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`]);
    return { loaded: true, pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || null,
      state: stdout.match(/^\s*state = ([a-zA-Z ]+)$/m)?.[1] || null,
      exit: stdout.match(/^\s*last exit code = (\d+)$/m)?.[1] === undefined ? null : Number(stdout.match(/^\s*last exit code = (\d+)$/m)[1]),
      runs: Number(stdout.match(/^\s*runs = (\d+)$/m)?.[1] || 0) };
  } catch (error) {
    if (/Could not find (?:specified )?service/.test(error.stderr || "")) return { loaded: false, pid: null };
    throw new Error("STATUS_FAILED");
  }
}
async function waitFor(read, accept) {
  for (let n = 0; n < 100; n++) { requireProof(!interrupted, "INTERRUPTED"); const value = await read(); if (accept(value)) return value; await delay(100); }
  throw new Error("WAIT_TIMEOUT");
}
async function fileHash(path) {
  if (!await present(path)) return "ABSENT";
  const digest = createHash("sha256"); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest("hex");
}
async function nativeSnapshot() {
  const home = join(homedir(), ".codex"), binary = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  // The official embedded CLI can be unsigned; its enclosing app is signed.
  try { await exec("/usr/bin/codesign", ["--verify", "--strict", "/Applications/ChatGPT.app"]); }
  catch { throw new Error("SIGNED_APP_VERIFY_FAILED"); }
  const databases = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort();
  const rows = [];
  for (const name of databases) {
    const query = "SELECT account_id, app_server_client_name, environment_id, server_id, server_name, remote_control_enabled FROM remote_control_enrollments WHERE app_server_client_name = 'Codex Desktop' ORDER BY account_id, environment_id";
    try { rows.push([name, (await exec("/usr/bin/sqlite3", ["-readonly", "-json", join(home, name), query])).stdout.trim()]); }
    catch { throw new Error("NATIVE_METADATA_READ_FAILED"); }
  }
  requireProof(rows.length > 0 && rows.some(([, value]) => value && value !== "[]"), "NATIVE_METADATA_MISSING");
  return { signedBinary: await fileHash(binary), config: await fileHash(join(home, "config.toml")),
    installation: await fileHash(join(home, "installation_id")), enrollment: hash(JSON.stringify(rows)) };
}
function overrides(context) {
  // Keep installed status/list/inspect/disabled/discard implementations real.
  return { label: context.label, directory: context.directory, command: { command: context.gateway, args: [] } };
}
async function controller(path, args) {
  const context = await json(path), module = await import(pathToFileURL(context.module));
  requireProof(JSON.stringify(args) === JSON.stringify(["daemon", "--config", context.config]), "CONTROLLER_ARGUMENTS");
  try {
    const plan = await module.activatePendingLoginConsolidation(context.config, overrides(context));
    await save(context.result, { ok: true, pid: process.pid, kinds: plan.components.map(item => item.kind).sort() });
    setInterval(() => {}, 1000);
  } catch (error) { await save(context.result, { ok: false, pid: process.pid, failure: failure(error) }); process.exitCode = 1; }
}
async function main(prefixArgument) {
  const result = { ok: false, failure: "NOT_STARTED", productionModified: false }, tracked = [], ownedPids = new Set();
  process.once("SIGINT", () => { interrupted = true; }); process.once("SIGTERM", () => { interrupted = true; });
  let context, root, before;
  try {
    requireProof(process.platform === "darwin" && prefixArgument, "MACOS_PREFIX_REQUIRED");
    const input = await realpath(resolve(prefixArgument)), base = (await stat(input)).isDirectory() ? input : dirname(dirname(input));
    const candidates = [base, join(base, "share/gatefox/current"), join(base, "share/subscription-gateway/current")];
    const prefix = await realpath(await waitFor(async () => {
      for (const candidate of candidates) if (await present(join(candidate, "package/dist/mac-login-consolidate.js"))) return candidate;
      return null;
    }, value => value !== null)), node = join(prefix, "runtime/bin/node");
    const modulePath = join(prefix, "package/dist/mac-login-consolidate.js");
    requireProof((await stat(node)).isFile() && await present(modulePath), "INSTALLED_MODULE_MISSING");
    const module = await import(pathToFileURL(modulePath));
    before = await nativeSnapshot();
    root = await mkdtemp(join(tmpdir(), "gateway-login-e2e-")); await chmod(root, 0o700);
    const label = "com.edihasaj.subscription-gateway.e2e-" + process.pid + "-" + randomBytes(6).toString("hex");
    const directory = join(homedir(), "Library/LaunchAgents"), state = join(root, "state"), bin = join(root, "bin");
    await mkdir(bin, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
    const config = join(root, "gateway.json"), gateway = join(bin, "gateway"), native = join(bin, "gateway-native-relay");
    context = { label, directory, state, config, gateway, module: modulePath, result: join(root, "controller-result.json") };
    const contextPath = join(root, "context.json"); await save(contextPath, context);
    await save(config, { version: 1, port: 0, stateDirectory: state,
      providers: [{ id: "fixture", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "FIXTURE_UNUSED_KEY", models: { fixture: "fixture" } }] });
    const timer = `exec ${quote(node)} -e 'setInterval(() => {}, 1000)'\n`;
    await writeFile(native, "#!/bin/sh\n" + timer, { mode: 0o700 });
    await writeFile(gateway, `#!/bin/sh\ncase "$1" in\ndesktop-restore) exit 0 ;;\nserve) ${timer};;\ndaemon) exec ${quote(node)} ${quote(script)} --controller ${quote(contextPath)} "$@" ;;\n*) exit 1 ;;\nesac\n`, { mode: 0o700 });
    const definitions = [
      { label, kind: "inference", args: [gateway, "serve", "--config", config], keepAlive: true },
      { label: label + ".native", kind: "native", args: [native, "--native-home", join(root, "native-home"), "--relay-home", join(root, "relay-home"), "--gateway", gateway, "--gateway-config", config, "--codex", node, "--daemon"], keepAlive: true },
      { label: label + ".desktop", kind: "desktop", args: [gateway, "desktop-restore", "--config", config, "--app", "/Applications/ChatGPT.app"], keepAlive: false },
    ];
    const mutate = async (command, name, path) => {
      requireProof(!interrupted, "INTERRUPTED");
      requireProof(name === label || definitions.some(item => item.label === name), "UNOWNED_TARGET");
      await exec("/bin/launchctl", [command, command === "bootstrap" ? `gui/${process.getuid()}` : `gui/${process.getuid()}/${name}`, ...(path ? [path] : [])]);
    };
    for (const definition of definitions) {
      const path = join(directory, definition.label + ".plist");
      requireProof(!await present(path) && !(await status(definition.label)).loaded, "FIXTURE_COLLISION");
      const text = `<?xml version="1.0"?><!-- Managed by subscription-gateway --><plist version="1.0"><dict><key>Label</key><string>${xml(definition.label)}</string><key>ProgramArguments</key><array>${definition.args.map(value => `<string>${xml(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/>${definition.keepAlive ? "<key>KeepAlive</key><true/>" : ""}</dict></plist>`;
      await writeFile(path, text, { mode: 0o600, flag: "wx" }); tracked.push(definition.label); await mutate("bootstrap", definition.label, path);
    }
    const old = {};
    for (const definition of definitions) old[definition.kind] = await waitFor(() => status(definition.label), value => definition.keepAlive ? value.pid && value.state === "running" : value.loaded && !value.pid && value.runs > 0 && value.exit === 0);
    for (const value of Object.values(old)) if (value.pid) ownedPids.add(value.pid);
    await delay(500);
    const collect = async () => {
      const jobs = await Promise.all(definitions.map(async definition => ({ path: join(directory, definition.label + ".plist"), label: definition.label,
        text: await readFile(join(directory, definition.label + ".plist"), "utf8"), loaded: true, kind: definition.kind,
        component: { id: definition.kind, kind: definition.kind, command: definition.args[0], args: definition.args.slice(1), log: join(state, definition.kind + ".log") } })));
      return { jobs, plan: { version: 1, config, components: jobs.map(job => job.component) } };
    };
    const staged = await module.stageLoginConsolidation(config, { ...overrides(context), collect });
    const pendingPath = module.pendingLoginConsolidationPath(state), pending = await json(pendingPath);
    requireProof(staged.staged && !await present(join(state, "service-plan.json")), "STAGING_FAILED");
    result.oldPidsPreserved = (await status(label)).pid === old.inference.pid && (await status(label + ".native")).pid === old.native.pid;
    result.oneFuturePlist = (await readdir(directory)).filter(name => name === label + ".plist" || name.startsWith(label + ".")).length === 1;
    requireProof(result.oldPidsPreserved && result.oneFuturePlist, "STAGING_CHANGED_LIVE_JOBS");
    try { await module.activatePendingLoginConsolidation(config, overrides(context)); throw new Error("MANUAL_PROMOTION_ACCEPTED"); }
    catch (error) { requireProof(failure(error) === "PRIMARY_OWNERSHIP", "MANUAL_PROMOTION_NOT_REFUSED"); result.manualPromotionRefused = true; }
    await mutate("bootout", label); await mutate("bootstrap", label, join(directory, label + ".plist"));
    const blocked = await waitFor(() => json(context.result).catch(() => null), value => value !== null);
    if (blocked.pid) ownedPids.add(blocked.pid);
    requireProof(!blocked.ok && blocked.failure === "RETIRED_JOB_LOADED" && !await present(join(state, "service-plan.json")), "LIVE_JOB_PROMOTION_NOT_REFUSED");
    result.liveJobPromotionRefused = true; await mutate("bootout", label);
    for (const definition of definitions.slice(1)) await mutate("bootout", definition.label);
    await exec("/usr/bin/trash", ["-s", context.result]);
    await mutate("bootstrap", label, join(directory, label + ".plist"));
    const promoted = await waitFor(() => json(context.result).catch(() => null), value => value !== null);
    if (promoted.pid) ownedPids.add(promoted.pid);
    const primary = await status(label), plan = await json(join(state, "service-plan.json"));
    result.selfPidMatched = promoted.ok && promoted.pid === primary.pid;
    result.planPreserved = JSON.stringify(plan) === JSON.stringify(pending.plan);
    result.pendingArchived = !await present(pendingPath) && (await readdir(pending.backup)).some(name => name.startsWith("login-activated."));
    result.responsibilities = promoted.kinds;
    requireProof(result.selfPidMatched && result.planPreserved && result.pendingArchived, "PROMOTION_PROOF_FAILED");
    const after = await nativeSnapshot(); result.nativeUnchanged = JSON.stringify(before) === JSON.stringify(after); result.nativeHashes = after;
    requireProof(result.nativeUnchanged, "NATIVE_STATE_CHANGED"); result.ok = true; result.failure = null;
  } catch (error) { result.failure = /^[A-Z_]+$/.test(error.message) ? error.message : "FIXTURE_FAILED"; }
  finally {
    result.cleanup = true;
    for (const label of tracked.reverse()) {
      try {
        requireProof(context && (label === context.label || label.startsWith(context.label + ".")), "UNOWNED_CLEANUP");
        if ((await status(label)).loaded) await exec("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`]);
        const path = join(context.directory, label + ".plist"); if (await present(path)) await exec("/usr/bin/trash", ["-s", path]);
        requireProof(!(await status(label)).loaded && !await present(path), "CLEANUP_FAILED");
      } catch { result.cleanup = false; }
    }
    for (const pid of ownedPids) {
      let stopped = false;
      for (let n = 0; n < 50; n++) {
        const output = await exec("/bin/ps", ["-p", String(pid), "-o", "pid="]).catch(() => ({ stdout: "" }));
        if (!output.stdout.trim()) { stopped = true; break; } await delay(100);
      }
      if (!stopped) result.cleanup = false;
    }
    if (root && result.cleanup) { try { await exec("/usr/bin/trash", ["-s", root]); } catch { result.cleanup = false; } }
    if (root && !result.cleanup) result.fixtureRoot = root;
    if (!result.cleanup) { result.ok = false; result.failure = "CLEANUP_FAILED"; }
    process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.ok ? 0 : 1;
  }
}
if (process.argv[2] === "--controller") await controller(process.argv[3], process.argv.slice(4));
else await main(process.argv[2]);
