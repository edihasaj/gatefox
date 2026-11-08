import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { gatewaySdkRuntime } from "./gateway-sdk-runtime.js";
import type { ExecutionProbeChildInput, ExecutionProbeChildResult } from "./execution-probe.js";

const sha = /^[a-f0-9]{64}$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function input(value: unknown): ExecutionProbeChildInput | undefined {
  const row = object(value);
  if (!row || typeof row.executable !== "string" || !row.executable.startsWith("/") || typeof row.packageDirectory !== "string" || !row.packageDirectory.startsWith("/")
    || typeof row.root !== "string" || !row.root.startsWith("/")
    || typeof row.sdkSha256 !== "string" || !sha.test(row.sdkSha256) || typeof row.catalogFingerprint !== "string" || !sha.test(row.catalogFingerprint)) return;
  return { executable: row.executable, packageDirectory: row.packageDirectory, sdkSha256: row.sdkSha256, catalogFingerprint: row.catalogFingerprint, root: row.root };
}

async function line(): Promise<ExecutionProbeChildInput | undefined> {
  let bytes = "";
  for await (const chunk of process.stdin) {
    bytes += String(chunk);
    if (Buffer.byteLength(bytes) > 16 * 1024) return;
  }
  const rows = bytes.trim().split("\n");
  if (rows.length !== 1 || !rows[0]) return;
  try { return input(JSON.parse(rows[0])); } catch { return; }
}

function environment(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SHELL"]) if (typeof process.env[key] === "string") clean[key] = process.env[key];
  return clean;
}

async function regular(path: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => undefined);
  return !!entry?.isFile() && !entry.isSymbolicLink() && entry.uid === process.getuid?.() && !(entry.mode & 0o022);
}

async function privateDirectory(path: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => undefined);
  return !!entry?.isDirectory() && !entry.isSymbolicLink() && entry.uid === process.getuid?.() && !(entry.mode & 0o077);
}

async function verifiedRuntime(value: ExecutionProbeChildInput): Promise<boolean> {
  try {
    const runtime = await gatewaySdkRuntime(value.packageDirectory);
    if (!runtime || runtime.binarySha256 !== value.sdkSha256 || runtime.executable !== value.executable) return false;
    return await realpath(runtime.executable) === await realpath(value.executable);
  } catch { return false; }
}

function fixedResult(value: unknown): ExecutionProbeChildResult | undefined {
  const row = object(value);
  const rows = object(row?.nativeRows);
  if (!row || row.passed !== true || row.paidInferenceRequests !== 0 || row.configReadVerified !== true || row.nativeConfigUnchanged !== true || row.nativeAuthAbsent !== true
    || row.completedChildTurns !== 2 || !Array.isArray(row.chats) || row.chats.length !== 2
    || !row.chats.every(chat => object(chat)?.commandContinuationObserved === true && ["gatefox", "subscription_gateway"].includes(String(object(chat)?.provider)))
    || !rows || Object.keys(rows).length !== 2 || !Object.values(rows).every(mode => mode === "direct")) return;
  return { sdkVerified: true, configVerified: true, directToolVerified: true, completedTurn: true, commandVerified: true };
}

/**
 * The release keeps this conformance script beside the package. It launches only the verified pinned SDK
 * with a mock loopback provider and a disposable git repository; it never sees a live gateway config or auth.
 */
async function canary(value: ExecutionProbeChildInput): Promise<ExecutionProbeChildResult | undefined> {
  // The host's own package fixes canary logic. A selected SDK may be recovered from
  // another verified release, but it never supplies executable test code.
  const hostPackage = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const script = resolve(hostPackage, "scripts", "e2e-direct-tools.mjs");
  if (!await regular(script)) return;
  const root = resolve(value.root);
  const marker = join(root, ".execution-probe-root");
  if (!await privateDirectory(root) || !await regular(marker) || await readFile(marker, "utf8").catch(() => "") !== "harness-gateway-execution-probe\n") return;
  try {
    const evidence = join(root, "evidence");
    // Keep the helper in this child's process group. The parent owns this group and can
    // terminate the script, its test gateway and its SDK together on timeout/host close.
    const child = spawn(process.execPath, [script, "--package", value.packageDirectory, "--code", hostPackage, "--root", evidence], {
      cwd: root, env: environment(), stdio: "ignore",
    });
    await once(child, "close");
    if (child.exitCode !== 0) return;
    const resultPath = join(evidence, "result.json");
    const info = await lstat(resultPath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 64 * 1024) return;
    const result = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
    return fixedResult(result);
  } catch { return; }
}

const supplied = await line();
const sdkVerified = !!supplied && await verifiedRuntime(supplied);
const result = sdkVerified && supplied ? await canary(supplied) : undefined;
const output: ExecutionProbeChildResult = result ?? {
  sdkVerified,
  configVerified: false,
  directToolVerified: false,
  completedTurn: false,
  commandVerified: false,
};
process.stdout.write(JSON.stringify(output) + "\n");
