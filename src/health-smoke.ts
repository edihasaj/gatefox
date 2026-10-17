import { spawn } from "node:child_process";
import { locateInstall } from "./versions.js";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safePhase, smokeKillGraceMs, smokeTimeoutMs, type AppInfo } from "./health-types.js";

/**
 * The compatibility run: the packaged fast-mode check against the installed release and
 * the app's own signed engine, with a mock upstream and isolated homes. It is the only
 * part of the watchdog that can prove an app update did not break the gateway, and it is
 * slow, so it runs once per app change and its answer is kept in the state file.
 *
 * Only two things are ever taken from it: whether it passed, and the name of the phase it
 * stopped in. Its stdout and stderr otherwise go nowhere, because a failing check prints
 * engine text, paths and arguments.
 */
export interface SmokeLaunch {
  /** The Node runtime the check runs on, and the script it runs. */
  runtime: string; script: string;
  /** The installed gateway command, its package root, and the app's signed engine. */
  gateway: string; packageRoot: string; codex: string;
  /** The private run folder, and how long the check may take before its group is stopped. */
  root: string; timeoutMs: number;
  /** How long a stopped group gets to take its own children down before SIGKILL. */
  graceMs?: number;
  /** Asking early (a service shutting down) stops the group the same way. */
  signal?: AbortSignal;
  /** PATH, HOME, TMPDIR and LANG, and nothing else. */
  env: Record<string, string>;
}
export type SmokeAnswer = { result: "pass" } | { result: "fail"; phase?: string } | { result: "unavailable" };
export type SmokeRunner = (launch: SmokeLaunch) => Promise<SmokeAnswer>;

/** The check ships with the package, one folder up from the compiled code. */
export const smokeScript = (moduleUrl = import.meta.url): string => resolve(dirname(fileURLToPath(moduleUrl)), "../scripts/e2e-fast-mode.mjs");
export const smokeRoot = (stateDirectory: string, at: number): string => resolve(stateDirectory, "health", `smoke-${at}`);
/** The environment the check may see: no provider key, no proxy, no inherited gateway state. */
export function smokeEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG"] as const) if (typeof env[key] === "string") kept[key] = env[key] as string;
  return kept;
}

export interface SmokeDeps {
  run?: SmokeRunner;
  /** The installed release's own paths; nothing when there is no installed release to check. */
  targets?: () => Promise<{ gateway: string; packageRoot: string } | undefined>;
  exists?: (path: string) => Promise<boolean>;
  makeRoot?: (path: string) => Promise<void>;
  dropRoot?: (path: string) => Promise<void>;
  moduleUrl?: string;
  now?: () => number;
  runtime?: string;
  /** Stopping the check: the group's SIGTERM grace, injectable so a test can shorten it. */
  graceMs?: number;
  /** A shutdown aborts a running check; its group is stopped and its folder removed. */
  signal?: AbortSignal;
}

/** Runs the check for this app pair, or says plainly why it could not. */
export async function runSmoke(app: AppInfo, stateDirectory: string, deps: SmokeDeps = {}): Promise<SmokeAnswer> {
  // A service that is already stopping starts nothing: no folder, no child.
  if (deps.signal?.aborted) return { result: "unavailable" };
  const at = deps.now?.() ?? Date.now();
  const script = smokeScript(deps.moduleUrl);
  const present = deps.exists ?? (path => stat(path).then(info => info.isFile(), () => false));
  if (app.state !== "found" || !app.enginePath) return { result: "unavailable" };
  if (!await present(script)) return { result: "unavailable" };
  const install = await (deps.targets ?? installedPaths)().catch(() => undefined);
  if (!install || deps.signal?.aborted) return { result: "unavailable" };
  const root = smokeRoot(stateDirectory, at);
  const make = deps.makeRoot ?? ((path: string) => mkdir(path, { recursive: true, mode: 0o700 }).then(() => undefined));
  await make(root).catch(() => undefined);
  const launch: SmokeLaunch = {
    runtime: deps.runtime ?? process.execPath, script, root, timeoutMs: smokeTimeoutMs,
    graceMs: deps.graceMs ?? smokeKillGraceMs, signal: deps.signal,
    gateway: install.gateway, packageRoot: install.packageRoot, codex: app.enginePath,
    env: smokeEnvironment(),
  };
  try {
    return await (deps.run ?? launchSmoke)(launch);
  } catch {
    return { result: "unavailable" };
  } finally {
    const drop = deps.dropRoot ?? ((path: string) => rm(path, { recursive: true, force: true }).then(() => undefined));
    await drop(root).catch(() => undefined);
  }
}

/**
 * The installed release's command and package folder, from the same `current` link
 * `gateway versions` reads. A checkout run has no installed release of its own to check,
 * so the smoke has nothing to point at and the answer is `unavailable`.
 */
async function installedPaths(): Promise<{ gateway: string; packageRoot: string } | undefined> {
  const scope = locateInstall();
  const root = scope.roots[0];
  if (!root || !scope.installed) return;
  const packageRoot = resolve(root, "releases", scope.installed, "package");
  return { packageRoot, gateway: resolve(packageRoot, "dist", "cli.js") };
}

/** The phase the check's last JSON line says it stopped in; a row without one is still a failure. */
function failingPhase(tail: string): string | undefined {
  const line = tail.split("\n").filter(Boolean).pop();
  if (!line) return;
  try {
    return safePhase((JSON.parse(line) as { failedPhase?: unknown }).failedPhase) ?? "unknown";
  } catch { return "unknown"; }
}

/** The real runner: one detached check, stopped as a group, read only for its last phase. */
export const launchSmoke: SmokeRunner = launch => new Promise<SmokeAnswer>(resolveAnswer => {
  // Asked to stop before it began: nothing is started at all.
  if (launch.signal?.aborted) return resolveAnswer({ result: "unavailable" });
  let child;
  try {
    child = spawn(launch.runtime, [launch.script, "--gateway", launch.gateway, "--package", launch.packageRoot,
      "--codex", launch.codex, "--transports", "stdio", "--root", launch.root],
      { cwd: dirname(launch.script), env: launch.env, stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" });
  } catch { return resolveAnswer({ result: "unavailable" }); }
  let tail = ""; let answered = false; let stopping: "timeout" | "abort" | undefined;
  // The check's children run in groups of their own, so the script leads: ask its whole group
  // to stop, and only a group that ignores the ask gets SIGKILLed after the grace.
  const group = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
  };
  const grace = launch.graceMs ?? smokeKillGraceMs;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: "timeout" | "abort") => {
    if (answered || stopping) return;
    stopping = reason;
    group("SIGTERM");
    killer = setTimeout(() => { killer = undefined; group("SIGKILL"); }, grace);
    killer.unref();
  };
  const timer = setTimeout(() => stop("timeout"), launch.timeoutMs);
  timer.unref();
  const signal = launch.signal;
  const onAbort = () => stop("abort");
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    // Only the newest complete line is kept: the check prints one JSON row per phase.
    tail = (tail + chunk).split("\n").slice(-2).join("\n");
    if (tail.length > 16384) tail = tail.slice(-4096);
  });
  const settle = (answer: SmokeAnswer) => {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    if (killer) clearTimeout(killer);
    if (signal) signal.removeEventListener("abort", onAbort);
    resolveAnswer(answer);
  };
  child.once("error", () => settle({ result: "unavailable" }));
  child.once("close", code => {
    // The script is gone, but a child it left in its group is not: sweep the group before answering.
    if (stopping) group("SIGKILL");
    // A stopped run says nothing about the pair, so it is not recorded; a timeout still is a failure.
    if (stopping === "abort") return settle({ result: "unavailable" });
    if (stopping === "timeout") return settle({ result: "fail", phase: "timeout" });
    if (code === 0) return settle({ result: "pass" });
    const phase = failingPhase(tail);
    settle({ result: "fail", ...(phase ? { phase } : {}) });
  });
});
