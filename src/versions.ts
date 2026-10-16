import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { defaultInstallRoot, userConfigPath } from "./paths.js";

/**
 * `gateway versions` answers one question: which release did each of my running
 * gateway processes actually load? A process started before an update keeps running
 * the release it loaded, so the `current` link in its command line says nothing about
 * it. The mapped text files that `lsof` reports for the process do, which is why this
 * module reads them and treats the command line only as a fallback.
 *
 * An inference process that upgraded itself in place keeps its old node runtime mapped, so
 * `lsof` names the release it started from rather than the code it serves. For that one role
 * the health endpoint answers, and its `X-Gateway-Release` header wins.
 *
 * `ps`, `lsof` and the config read are local, and each is injectable so the tests can feed
 * fixtures instead of the real binaries. The health probe is the only network call, and it
 * only ever dials `127.0.0.1`.
 */

export type VersionsRole = "service" | "inference" | "desktop-adapter" | "ssh-listener" | "ssh-proxy"
  | "executor-host" | "gateway-engine" | "native-relay" | "tunnel" | "other";

/** A process that runs from a checkout reports this instead of a release version. */
export const RELEASE_CHECKOUT = "checkout";
/** A release that neither `lsof` nor the command line could name. */
export const RELEASE_UNKNOWN = "unknown";

export interface ProcessRow { pid: number; uid: number; startedAt: string; command: string }
export interface VersionsProcess { role: VersionsRole; pid: number; startedAt: string; release: string }
export interface VersionsResult { installed: string | null; processes: VersionsProcess[]; lagging: number }

export interface VersionsExecutors {
  /** Runs `ps -axo pid,uid,lstart,command` and returns its stdout. */
  ps?: () => Promise<string>;
  /** Runs `lsof -a -p <pid> -d txt -Fn` and returns its stdout. */
  lsof?: (pid: number) => Promise<string>;
  /** Only rows owned by this uid are considered. Defaults to the current user. */
  uid?: number;
  /** The install folder this process runs from; undefined for a checkout run. */
  root?: string;
  /** The install folder a checkout run falls back to. Defaults to where the installer puts releases. */
  fallbackRoot?: string;
  /** The release `current` points at now; undefined when it cannot be read. */
  installed?: string;
  /** The release an inference process answers with on `/health`; the only call here that leaves the process. */
  health?: (port: number) => Promise<string | undefined>;
  /** The listen port a gateway configuration names; injectable so a test needs no config on disk. */
  configPort?: (path: string) => Promise<number | undefined>;
  /** Passed through so a caller can say which module the run started from. */
  moduleUrl?: string;
}

const exec = promisify(execFile);
const execTimeoutMs = 5000;
const psArgs = ["-axo", "pid,uid,lstart,command"];
const lsofBaseArgs = ["-a", "-p"];
const lsofTailArgs = ["-d", "txt", "-Fn"];
const healthTimeoutMs = 2000;
/** What a release folder may be named; a health header is only trusted when it fits. */
const releaseName = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,32}$/;

const realPs = async () => (await exec("ps", psArgs, { timeout: execTimeoutMs, maxBuffer: 16 * 1024 * 1024 })).stdout;
const realLsof = async (pid: number) => (await exec("lsof", [...lsofBaseArgs, String(pid), ...lsofTailArgs], { timeout: execTimeoutMs })).stdout;

/** The install folder this module runs from, derived the way `releaseState` derives a release. */
export function installRoot(moduleUrl = import.meta.url): string | undefined {
  try {
    const release = realpathSync(resolve(dirname(fileURLToPath(moduleUrl)), "../.."));
    if (basename(dirname(release)) !== "releases") return;
    return dirname(release);
  } catch { return; }
}

/** The release `<root>/current` points at now, or undefined when the link cannot be read. */
export function installedRelease(root = installRoot()): string | undefined {
  if (!root) return;
  try { return basename(realpathSync(resolve(root, "current"))); } catch { return; }
}

/**
 * Which install a report compares against, and how strictly. `own` is the tree this process
 * runs from, so a command that names another tree is not one of ours. A checkout run has no
 * own tree; it then falls back to the default install, whose `current` still names the
 * installed release, and stays loose because a checkout process cannot be told apart by path.
 */
export function locateInstall(moduleUrl = import.meta.url, fallback = defaultInstallRoot()): { root?: string; own: boolean } {
  const own = installRoot(moduleUrl);
  if (own) return { root: own, own: true };
  return installedRelease(fallback) ? { root: fallback, own: false } : { own: false };
}

/** A command line is one of ours when it names this install's `current` or a release under it. */
const strip = (path: string) => path.replace(/\/+$/, "");

/**
 * Rows from `ps -axo pid,uid,lstart,command`. `lstart` is the five fields
 * `Mon Oct 12 09:14:02 2026`, so the year ends the timestamp and the command is what is
 * left over. The header line and anything that does not fit that shape are skipped.
 */
export function parsePs(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3} [A-Za-z]{3} +\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(\S.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), uid: Number(match[2]), startedAt: startIso(match[3]), command: match[4]!.trim() });
  }
  return rows;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `lstart` is local wall-clock time; keep it as an instant rather than as a string. */
function startIso(lstart: string): string {
  const match = /^(\w{3}) (\w{3}) +(\d+) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(lstart.trim());
  if (!match) return lstart.trim();
  const month = months.indexOf(match[2]!);
  if (month < 0) return lstart.trim();
  const started = new Date(Number(match[7]), month, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  return Number.isNaN(started.getTime()) ? lstart.trim() : started.toISOString();
}

/** What a process is doing, from the subcommand and the binaries it names. */
export function classifyRole(command: string): VersionsRole {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.some(token => token.includes("package/native/"))) return "native-relay";
  if (tokens.some(token => token.includes("package/gateway-sdk/gateway-codex"))) return "gateway-engine";
  const cli = tokens.findIndex(token => token === "cli.js" || token.endsWith("/cli.js"));
  if (cli < 0) return "other";
  const sub = tokens[cli + 1] ?? "";
  if (sub === "daemon") return "service";
  if (sub === "serve") return "inference";
  if (sub === "tunnel") return "tunnel";
  if (sub === "executor-host") return "executor-host";
  if (sub !== "codex-shim") return "other";
  // Everything after the `--` separator is what Codex itself was asked to run.
  const separator = tokens.indexOf("--", cli);
  const forwarded = separator < 0 ? [] : tokens.slice(separator + 1);
  if (!tokens.includes("--ssh")) return "desktop-adapter";
  const listen = forwarded.findIndex(token => token === "--listen" || token.startsWith("--listen="));
  if (listen >= 0 && (forwarded[listen]!.includes("unix://") || forwarded[listen + 1]?.startsWith("unix://"))) return "ssh-listener";
  // The listener is the only other reason to run an SSH shim, but a `proxy` call is its client.
  if (forwarded.includes("proxy")) return "ssh-proxy";
  return "ssh-listener";
}

/**
 * The release segment of a process's mapped files, from `lsof -a -p <pid> -d txt -Fn`.
 * Names arrive as `n<path>` lines. Nothing mapped, and an unreadable or failed run, both
 * come back as `unknown` so the caller can decide what else it knows.
 */
export function parseLsofTxt(out: string): string {
  for (const line of out.split("\n")) {
    if (!line.startsWith("n")) continue;
    const match = /(?:^|\/)releases\/([^/]+)\//.exec(line);
    if (match?.[1]) return match[1];
  }
  return RELEASE_UNKNOWN;
}

/**
 * The release this command line names, or undefined when it is not one of ours. A
 * `current` path is the installed release, because the link is resolved at exec time.
 * `loose` says the report does not run from the tree it matched, so a command that names
 * no release at all is still one of ours: a checkout run.
 */
export function commandRelease(command: string, root: string | undefined, installed: string | undefined, loose = root === undefined): string | undefined {
  if (root && !loose) {
    const releases = `${strip(root)}/releases/`;
    if (command.includes(releases)) { const version = /releases\/([^/]+)\//.exec(command); return version?.[1] ?? RELEASE_UNKNOWN; }
    if (command.includes(`${strip(root)}/current/`)) return installed ?? RELEASE_UNKNOWN;
    return;
  }
  if (root && command.includes(`${strip(root)}/current/`)) return installed ?? RELEASE_UNKNOWN;
  const match = /(?:^|\/)releases\/([^/]+)\//.exec(command);
  if (match?.[1]) return match[1];
  return classifyRole(command) === "other" ? undefined : RELEASE_CHECKOUT;
}

/** The value an option was given in this command line, as `--opt VALUE` or `--opt=VALUE`. */
function commandOption(command: string, option: string): string | undefined {
  const tokens = command.split(/\s+/);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === option) return tokens[index + 1]?.startsWith("-") ? undefined : tokens[index + 1];
    if (token.startsWith(`${option}=`)) return token.slice(option.length + 1) || undefined;
  }
  return;
}

/** The port this inference process serves on: its own `--port`, else the port its configuration names. */
async function servePort(command: string, deps: VersionsExecutors): Promise<number | undefined> {
  const explicit = Number(commandOption(command, "--port") ?? "");
  if (Number.isInteger(explicit) && explicit > 0 && explicit <= 65535) return explicit;
  const read = deps.configPort ?? ((path: string) => loadConfig(path).then(config => config.port || undefined, () => undefined));
  return read(commandOption(command, "--config") ?? userConfigPath());
}

/** The release an inference process actually serves, from its health header; undefined when it cannot answer. */
async function servedRelease(command: string, deps: VersionsExecutors): Promise<string | undefined> {
  try {
    const port = await servePort(command, deps);
    if (!port) return;
    const probe = deps.health ?? (async (target: number) => (await fetch(`http://127.0.0.1:${target}/health`,
      { signal: AbortSignal.timeout(healthTimeoutMs) })).headers.get("x-gateway-release") ?? undefined);
    const release = await probe(port);
    return release && releaseName.test(release) ? release : undefined;
  } catch { return; }
}

/** List this user's running gateway processes with the release each one loaded. */
export async function runVersions(deps: VersionsExecutors = {}): Promise<VersionsResult> {
  const ps = deps.ps ?? realPs;
  const lsof = deps.lsof ?? realLsof;
  const uid = deps.uid ?? (process.getuid?.() ?? 0);
  const located = deps.root !== undefined ? { root: deps.root, own: true } : locateInstall(deps.moduleUrl, deps.fallbackRoot);
  const root = located.root;
  const installed = deps.installed ?? installedRelease(root);
  const rows = parsePs(await ps()).filter(row => row.uid === uid);
  const processes: VersionsProcess[] = [];
  for (const row of rows) {
    const named = commandRelease(row.command, root, installed, !located.own);
    if (named === undefined) continue;
    const role = classifyRole(row.command);
    // An inference process that upgraded in place keeps its old runtime mapped, so its health answer wins.
    const served = role === "inference" ? await servedRelease(row.command, deps) : undefined;
    if (served) { processes.push({ role, pid: row.pid, startedAt: row.startedAt, release: served }); continue; }
    const mapped = await lsof(row.pid).then(parseLsofTxt, () => RELEASE_UNKNOWN as string);
    processes.push({ role, pid: row.pid, startedAt: row.startedAt, release: mapped === RELEASE_UNKNOWN ? named : mapped });
  }
  processes.sort((left, right) => left.role.localeCompare(right.role) || left.pid - right.pid);
  return { installed: installed ?? null, processes, lagging: processes.filter(row => row.release !== installed).length };
}

/** A short table for a terminal: what is installed, what is running, and whether they match. */
export function formatHuman(result: VersionsResult): string {
  const lines = [`installed ${result.installed ?? "unknown"}`, ""];
  if (!result.processes.length) return `${lines.join("\n")}no gateway processes running\n`;
  const role = Math.max(...result.processes.map(row => row.role.length));
  const pid = Math.max(...result.processes.map(row => String(row.pid).length));
  for (const row of result.processes) {
    lines.push(`  ${row.role.padEnd(role)}  ${String(row.pid).padStart(pid)}  ${row.startedAt.replace("T", " ").slice(0, 16)}  ${row.release}`);
  }
  lines.push("");
  // One mention per distinct role and release, so a fleet of stale adapters is one line.
  const behind = [...new Set(result.processes.filter(row => row.release !== result.installed).map(row => `${row.role}@${row.release}`))];
  lines.push(behind.length ? `${behind.length} lagging: ${behind.join(" ")}` : `all on ${result.installed}`);
  return lines.join("\n") + "\n";
}

export interface VersionsCommandDeps extends VersionsExecutors {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  moduleUrl?: string;
}

/**
 * `gateway versions [--json] [--check]`. A process loaded a release older than `current` fails
 * the check with exit 1. A run that names no installed release at all, from a checkout with no
 * default install beside it, cannot be compared and exits 2; `--json` still prints it, with
 * `installed` null. A bad flag, or a process list `ps` cannot read, also exits 2.
 */
export async function versionsCommand(args: string[], deps: VersionsCommandDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.some(arg => arg !== "--json" && arg !== "--check")) {
    err("Usage: gateway versions [--json] [--check]\n");
    return 2;
  }
  let result: VersionsResult;
  try {
    result = await runVersions(deps);
  } catch (error) {
    err(`versions: ${error instanceof Error ? error.message : "could not read the process list"}\n`);
    return 2;
  }
  if (args.includes("--json")) out(JSON.stringify(result, null, 2) + "\n");
  else out(formatHuman(result));
  if (!args.includes("--check")) return 0;
  if (result.installed === null) { err("versions: no installed release to compare against\n"); return 2; }
  return result.lagging > 0 ? 1 : 0;
}
