#!/usr/bin/env node
// End-to-end check: a private Harness Gateway instance driven by the native Claude Code CLI.
// Reads the caller's config, clones it into a throwaway sandbox, and proves one Read + Write
// tool round-trip through the gateway. Nothing secret is logged: failures print a fixed stage.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";

const USAGE = "usage: GATEWAY_E2E_CONFIG=<gateway.json> GATEWAY_E2E_MODEL=<model alias> "
  + "[GATEWAY_E2E_CLAUDE=<claude binary>] node scripts/e2e-claude.mjs";

const sourceConfigPath = process.env.GATEWAY_E2E_CONFIG;
const model = process.env.GATEWAY_E2E_MODEL;
if (!sourceConfigPath || !model) {
  process.stderr.write(USAGE + "\n");
  process.exit(1);
}
const claudeBinary = process.env.GATEWAY_E2E_CLAUDE || "claude";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(repoRoot, "dist", "cli.js");
const TIME_LIMITS = { generateMs: 15_000, serveMs: 30_000, nativeMs: 120_000, overallMs: 180_000 };
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

class StageError extends Error {
  constructor(stage) { super(stage); this.stage = stage; }
}
const fail = (stage) => { throw new StageError(stage); };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

const tracked = new Set();
let cleanupPromise = null;
let finishPromise = null;
let overallTimer;
let sandbox;

function remember(child) {
  const entry = { child, pid: child.pid, exited: false };
  entry.onExit = () => { entry.exited = true; };
  child.once("exit", entry.onExit);
  tracked.add(entry);
  return entry;
}

function signal(entry, signalName) {
  if (!entry.pid) return;
  // The group is targeted so orphaned descendants die even after the leader exits.
  try { process.kill(-entry.pid, signalName); } catch { /* group already gone */ }
  if (entry.exited) return;
  try { entry.child.kill(signalName); } catch { /* already gone */ }
}

async function cleanup() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      const entries = [...tracked];
      for (const entry of entries) signal(entry, "SIGTERM");
      await delay(2_000);
      for (const entry of entries) signal(entry, "SIGKILL");
      tracked.clear();
    })();
  }
  await cleanupPromise;
}

// Streams stdout. With `onLine`, every line is handed to the callback as it arrives and nothing
// is retained; without it, stdout is collected for the caller. Byte bounds are enforced while the
// chunks land so a chatty child cannot grow the buffer past the caps.
function capture(child, stage, timeoutMs, onLine) {
  const chunks = [];
  let total = 0;
  let partial = "";
  let partialBytes = 0;
  let settled = false;
  let timer;
  return new Promise((resolve, reject) => {
    const stop = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(error);
    };
    const emit = (line) => {
      try { onLine(line); return true; }
      catch (error) { stop(error instanceof StageError ? error : new StageError(`${stage}-parse`)); return false; }
    };
    const overflow = () => stop(new StageError(`${stage}-line-overflow`));
    timer = setTimeout(() => stop(new StageError(`${stage}-timeout`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      total += Buffer.byteLength(chunk);
      if (total > MAX_STDOUT_BYTES) { stop(new StageError(`${stage}-overflow`)); return; }
      if (!onLine) { chunks.push(chunk); return; }
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        if (newline === -1) break;
        const line = partial + chunk.slice(start, newline);
        partial = "";
        partialBytes = 0;
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) { overflow(); return; }
        if (!emit(line) || settled) return;
        start = newline + 1;
      }
      const rest = chunk.slice(start);
      if (rest) {
        partial += rest;
        partialBytes += Buffer.byteLength(rest);
        if (partialBytes > MAX_LINE_BYTES) overflow();
      }
    });
    child.stdout.on("error", () => stop(new StageError(`${stage}-stdout`)));
    child.on("error", () => stop(new StageError(stage)));
    child.on("close", (code) => {
      if (settled) return;
      if (onLine && partial) {
        const line = partial;
        partial = "";
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) { overflow(); return; }
        if (!emit(line)) return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: onLine ? "" : chunks.join("") });
    });
  });
}

async function runCaptured(args, stage, timeoutMs, env) {
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: repoRoot, detached: true, stdio: ["ignore", "pipe", "ignore"], env,
    });
  } catch {
    fail(stage);
  }
  remember(child);
  const result = await capture(child, stage, timeoutMs);
  if (result.code !== 0) fail(`${stage}-exit`);
  return result.stdout;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new StageError("port")));
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string" || !address.port) { probe.close(); reject(new StageError("port")); return; }
      probe.close(() => resolve(address.port));
    });
  });
}

function parseLine(line, counts) {
  if (!line.trim()) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== "object") return;
  if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
    for (const part of event.message.content) {
      if (part && part.type === "tool_use" && (part.name === "Read" || part.name === "Write") && typeof part.id === "string") {
        counts.pending.set(part.id, part.name);
      }
    }
    return;
  }
  if (event.type === "user" && event.message && Array.isArray(event.message.content)) {
    for (const part of event.message.content) {
      if (!part || part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
      const name = counts.pending.get(part.tool_use_id);
      if (!name) continue;
      counts.pending.delete(part.tool_use_id);
      if (part.is_error !== true) counts.succeeded.add(name);
      else counts.failed.add(name);
    }
    return;
  }
  if (event.type === "result") {
    counts.result = { subtype: event.subtype, isError: event.is_error };
  }
}

async function waitForHealth(port, tokenPath, readClientToken) {
  const deadline = Date.now() + TIME_LIMITS.serveMs;
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() < deadline) {
    let token;
    try { token = await readClientToken(tokenPath); } catch { await delay(250); continue; }
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body && body.status === "ok") return;
      }
    } catch { /* not up yet */ }
    await delay(250);
  }
  fail("health");
}

async function main() {
  const { loadConfig, writePrivateJson, readClientToken } = await import("../dist/config.js");
  const source = await loadConfig(path.resolve(sourceConfigPath)).catch(() => fail("config-load"));
  if (source.clientOnly) fail("config-client-only");
  const matching = source.providers.filter((provider) => Object.keys(provider.models).includes(model));
  if (!matching.length) fail("model-not-found");

  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-claude-"));
  sandbox = home;
  const stateDirectory = path.join(home, "state");
  // The config, settings, and token live next to the sandbox root, so Claude runs in a dedicated
  // workspace that holds nothing but the proof file it is allowed to touch.
  const workspacePath = path.join(home, "workspace");
  const claudeHome = path.join(home, "claude-home");
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  // Match the canonical cwd Claude sees (macOS /var is a /private/var symlink).
  const workspace = await realpath(workspacePath);
  await mkdir(claudeHome, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const candidate = {
    version: 1,
    port,
    stateDirectory,
    maxConcurrent: 1,
    providers: source.providers.map((provider) => ({ ...provider })),
  };
  const candidatePath = path.join(home, "gateway-config.json");
  await writePrivateJson(candidatePath, candidate);

  const serveChild = spawn(process.execPath, [cliEntry, "serve", "--config", candidatePath], {
    cwd: repoRoot, detached: true, stdio: "ignore", env: process.env,
  });
  remember(serveChild);
  serveChild.on("error", () => { /* surfaced by the health poll */ });

  await waitForHealth(port, path.join(stateDirectory, "client-token"), readClientToken);

  const generated = await runCaptured(
    [cliEntry, "claude-config", "--config", candidatePath, "--model", model],
    "generate", TIME_LIMITS.generateMs,
  );
  let settings;
  try { settings = JSON.parse(generated); } catch { fail("generate-parse"); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) fail("generate-parse");

  const proofPath = path.join(workspace, "proof.txt");
  const matcher = proofPath.startsWith("/") ? `//${proofPath.slice(1)}` : proofPath;
  const readRule = `Read(${matcher})`;
  // Claude uses Edit(path) permission rules for the Write tool too.
  const editRule = `Edit(${matcher})`;
  settings.permissions = { ...settings.permissions, allow: [readRule, editRule] };
  const settingsPath = path.join(home, "claude-settings.json");
  await writePrivateJson(settingsPath, settings);

  const uuid = randomUUID();
  const prompt = [
    "This is an automated connectivity proof. Work only inside the current working directory.",
    `1. Use the Write tool to create the file proof.txt whose entire contents are exactly this line followed by a single newline: ${uuid}`,
    "2. Use the Read tool to read proof.txt and confirm it matches.",
    "Do not use Bash or any other tool. Do not create other files. Reply with the single word done.",
  ].join("\n");

  const nativeEnv = { ...process.env };
  for (const key of Object.keys(nativeEnv)) {
    if (key.startsWith("ANTHROPIC_")) delete nativeEnv[key];
  }
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "GATEWAY_E2E_CONFIG"]) {
    delete nativeEnv[key];
  }
  nativeEnv.CLAUDE_CONFIG_DIR = claudeHome;
  nativeEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

  const claudeArgs = [
    "--settings", settingsPath,
    "--setting-sources", "",
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--model", model,
    "--tools", "Read,Write",
    // Headless proof: only the exact pre-approved fixture paths may run.
    "--permission-mode", "dontAsk",
    "--allowedTools", `${readRule},${editRule}`,
    "--max-turns", "8",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
  ];
  let claude;
  try {
    claude = spawn(claudeBinary, claudeArgs, {
      cwd: workspace, detached: true, env: nativeEnv, stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    fail("claude-spawn");
  }
  remember(claude);
  claude.stdin.on("error", () => { /* closed by the child */ });
  claude.stdin.end(prompt);

  const counts = { pending: new Map(), succeeded: new Set(), failed: new Set(), result: null };
  const streamed = await capture(claude, "claude", TIME_LIMITS.nativeMs, (line) => parseLine(line, counts));
  if (!counts.succeeded.has("Write")) fail("write-tool");
  if (!counts.succeeded.has("Read")) fail("read-tool");
  if (!counts.result || counts.result.subtype !== "success" || counts.result.isError !== false) fail("claude-result");
  if (streamed.code !== 0) fail("claude-exit");

  const written = await readFile(proofPath, "utf8").catch(() => fail("proof-read"));
  if (written !== `${uuid}\n`) fail("proof-contents");

  process.stdout.write("ok e2e-claude\n");
  process.stdout.write(`  model: ${model}\n`);
  process.stdout.write(`  providers: ${matching.map((provider) => provider.id).join(", ")}\n`);
  process.stdout.write(`  sandbox: ${home}\n`);
  process.stdout.write(`  write tool calls: ${counts.succeeded.has("Write") ? 1 : 0} ok\n`);
  process.stdout.write(`  read tool calls: ${counts.succeeded.has("Read") ? 1 : 0} ok\n`);
}

const finish = (code, stage) => {
  if (!finishPromise) {
    finishPromise = (async () => {
      clearTimeout(overallTimer);
      try { await cleanup(); } catch { /* best effort: the children are already signalled */ }
      if (stage) {
        process.stderr.write(`e2e-claude: failed at ${stage}\n`);
        if (sandbox) process.stderr.write(`  sandbox: ${sandbox}\n`);
      }
      process.exit(code);
    })();
  }
  return finishPromise;
};

overallTimer = setTimeout(() => { void finish(1, "overall-timeout"); }, TIME_LIMITS.overallMs);
for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => { void finish(1, `interrupted-${signalName.toLowerCase()}`); });
}

try {
  await main();
  await finish(0);
} catch (error) {
  await finish(1, error instanceof StageError ? error.stage : "unexpected");
}
