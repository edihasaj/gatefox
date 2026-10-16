import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultInstallRoot } from "./paths.js";

/**
 * `gateway versions` answers one question: which release did each of my running
 * gateway processes actually load? A process started before an update keeps running
 * the release it loaded, so the `current` link in its command line says nothing about
 * it. The mapped text files that `lsof` reports for the process do, which is why this
 * module reads them and treats the command line only as a fallback.
 *
 * A command line is only read for the one thing it can prove: the executable the
 * kernel started, at argv position 0 (or the script at position 1, behind a node
 * binary). Anything those paths merely appear inside — a quoted wrapper, a value of a
 * flag, another product's folder — is not one of ours.
 *
 * An inference process that upgraded itself in place keeps its old node runtime mapped, so
 * `lsof` names the release it started from rather than the code it serves. For that one role
 * the health endpoint answers, and its `X-Gateway-Release` header wins. The port it dials
 * comes from the process's own listening socket, never from its arguments.
 *
 * `ps` and the two `lsof` runs are local, and each is injectable so the tests can feed
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

/**
 * Which install a report compares against. `roots` are the folders whose `current` and
 * `releases/<v>` entries name our processes, in every form a command line can use them.
 * `checkoutCli` is the script of the checkout this run started from, which has no install
 * root of its own; it is only set for a checkout run.
 */
export interface InstallScope { roots: string[]; installed?: string; checkoutCli?: string[] }

export interface VersionsExecutors {
  /** Runs `ps -axo pid,uid,lstart,command` and returns its stdout. */
  ps?: () => Promise<string>;
  /** Runs `lsof -a -p <pid> -d txt -Fn` (mapped files) and returns its stdout. */
  lsof?: (pid: number) => Promise<string>;
  /** Runs `lsof -a -p <pid> -iTCP -sTCP:LISTEN -P -n -Fn` (listening sockets) and returns its stdout. */
  sockets?: (pid: number) => Promise<string>;
  /** Only rows owned by this uid are considered. Defaults to the current user. */
  uid?: number;
  /** The install folder this process runs from; undefined for a checkout run. */
  root?: string;
  /** The install folder a checkout run falls back to. Defaults to where the installer puts releases. */
  fallbackRoot?: string;
  /** The release `current` points at now; undefined when it cannot be read. */
  installed?: string;
  /** The script of the checkout this run started from, when it started from one. */
  checkoutCli?: string;
  /** The release an inference process answers with on `/health`; the only call here that leaves the process. */
  health?: (port: number) => Promise<string | undefined>;
  /** Passed through so a caller can say which module the run started from. */
  moduleUrl?: string;
}

const exec = promisify(execFile);
const execTimeoutMs = 5000;
const psArgs = ["-axo", "pid,uid,lstart,command"];
const lsofTxtArgs = (pid: number) => ["-a", "-p", String(pid), "-d", "txt", "-Fn"];
const lsofSocketArgs = (pid: number) => ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fn"];
const healthTimeoutMs = 2000;
/** What a release folder may be named; a health header is only trusted when it fits. */
const releaseName = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,32}$/;

const realPs = async () => (await exec("ps", psArgs, { timeout: execTimeoutMs, maxBuffer: 16 * 1024 * 1024 })).stdout;
const realLsof = async (pid: number) => (await exec("lsof", lsofTxtArgs(pid), { timeout: execTimeoutMs })).stdout;
const realSockets = async (pid: number) => (await exec("lsof", lsofSocketArgs(pid), { timeout: execTimeoutMs })).stdout;
const realHealth = async (port: number) => (await fetch(`http://127.0.0.1:${port}/health`,
  { signal: AbortSignal.timeout(healthTimeoutMs) })).headers.get("x-gateway-release") ?? undefined;

const strip = (path: string) => path.replace(/\/+$/, "");
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A folder in both forms a command line can name it: as written, and with its links resolved. */
function pathForms(path: string): string[] {
  const lexical = strip(path);
  try {
    const real = strip(realpathSync(lexical));
    return real === lexical ? [lexical] : [lexical, real];
  } catch { return [lexical]; }
}

/** The install folder this module runs from in every form, or nothing when it runs from a checkout. */
export function installRoots(moduleUrl = import.meta.url): string[] {
  const release = resolve(dirname(fileURLToPath(moduleUrl)), "../..");
  const roots = new Set<string>();
  for (const form of pathForms(release)) if (basename(dirname(form)) === "releases") roots.add(strip(dirname(form)));
  return [...roots];
}

/** The release `<root>/current` points at now, or undefined when the link cannot be read. */
export function installedRelease(root?: string): string | undefined {
  for (const form of root ? pathForms(root) : installRoots()) {
    try { return basename(realpathSync(resolve(form, "current"))); } catch { /* the other form may read */ }
  }
  return;
}

/** Which install a report compares against, from the folder this run started in. */
export function locateInstall(moduleUrl = import.meta.url, fallback = defaultInstallRoot()): InstallScope {
  const roots = installRoots(moduleUrl);
  if (roots.length) return { roots, installed: installedRelease(roots[0]) };
  const installed = installedRelease(fallback);
  return { roots: installed ? pathForms(fallback) : [], installed, checkoutCli: pathForms(resolve(dirname(fileURLToPath(moduleUrl)), "cli.js")) };
}

/** Rows from `ps -axo pid,uid,lstart,command`. `lstart` is the five fields
 * `Mon Oct 12 09:14:02 2026`, so the year ends the timestamp and the command is what is
 * left over. The header line and anything that does not fit that shape are skipped.
 */
export function parsePs(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3} [A-Za-z]{3} +\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(\S.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), uid: Number(match[2]), startedAt: startIso(match[3]!), command: match[4]!.trim() });
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

/**
 * Whether everything before an entry path is one node interpreter. `ps` prints the whole
 * command line as one string with no quoting, so this matches the known shape of a node
 * path rather than splitting it: it may hold spaces, but a second word that is a bare
 * command name, or any flag, means the entry sits inside someone else's command string.
 * A `zsh -c` wrapper that only mentions one of our paths never becomes a component.
 */
function isNodeBinary(prefix: string): boolean {
  const tokens = prefix.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  if (tokens.some(token => token.startsWith("-"))) return false;
  if (tokens.length > 1 && !tokens[0]!.startsWith("/")) return false;
  // A later word that starts with "/" is a new argument, not the rest of a node path with spaces
  // (`/usr/bin/time /opt/node/bin/node ...`): the program is then the wrapper, never node.
  if (tokens.slice(1).some(token => token.startsWith("/"))) return false;
  return /^(?:node|nodejs)[0-9._-]*$/i.test(basename(tokens[tokens.length - 1]!));
}

/** What a process runs, from its command line alone, or nothing when it runs none of ours. */
export interface Classified { role: VersionsRole; release: string }

type EntryKind = "cli" | "engine" | "native";
interface Candidate { at: number; kind: EntryKind; path: string; release: string }

/** The three things a gateway process can be: the CLI script and the two binaries of a release. */
const entryKinds: [EntryKind, string][] = [
  ["cli", "package/dist/cli\\.js"],
  ["engine", "package/gateway-sdk/gateway-codex"],
  ["native", "package/native/[^/\\s]+"],
];

/**
 * Which component this command line runs and the release its own path names. Only argv
 * positions are read: the entry is argv[0], or the script at argv[1] behind a node binary.
 * Each install root is matched in both of its forms, so a tree reached through a link is
 * still recognized, and a checkout run also accepts the `dist/cli.js` of the checkout it
 * started from. Nothing else in the line is searched: another product's `releases/`
 * folder, or one of our paths inside a quoted wrapper, runs none of ours.
 */
export function classifyCommand(command: string, scope: InstallScope): Classified | undefined {
  // One substring pass first: a line that names none of these paths holds no entry point at all.
  const entries = [...scope.roots, ...(scope.checkoutCli ?? [])];
  if (!entries.some(entry => command.includes(entry))) return;
  const found: Candidate[] = [];
  const add = (body: string, kind: EntryKind, release: (path: string) => string, script: boolean) => {
    const hit = new RegExp(`(?<=^|\\s)(${body})(?=\\s|$)`).exec(command);
    if (!hit) return;
    const path = hit[1]!;
    // A binary is only one of ours as argv[0]; a script also counts behind a node interpreter.
    if (hit.index > 0 && !(script && isNodeBinary(command.slice(0, hit.index).trimEnd()))) return;
    found.push({ at: hit.index, kind, path, release: release(path) });
  };
  for (const root of scope.roots) {
    for (const [kind, tail] of entryKinds) {
      const head = `${escapeRe(strip(root))}/`;
      add(`${head}current/${tail}`, kind, () => scope.installed ?? RELEASE_UNKNOWN, kind === "cli");
      add(`${head}releases/[^/\\s]+/${tail}`, kind, path => releaseSegment(path) ?? RELEASE_UNKNOWN, kind === "cli");
    }
  }
  for (const cli of scope.checkoutCli ?? []) add(escapeRe(strip(cli)), "cli", () => RELEASE_CHECKOUT, true);
  if (!found.length) return;
  // The entry the kernel started is the first one in the line; one that only appears later is an argument.
  const entry = found.reduce((left, right) => left.at <= right.at ? left : right);
  const argv = command.slice(entry.at + entry.path.length).trim().split(/\s+/).filter(Boolean);
  const role = entry.kind === "engine" ? "gateway-engine" : entry.kind === "native" ? "native-relay" : cliRole(argv);
  return { role, release: entry.release };
}

/** The `<v>` of a `releases/<v>/package/...` path. */
const releaseSegment = (path: string) => /(?:^|\/)releases\/([^/]+)\/package\//.exec(path)?.[1];

/** The role of a gateway script run, from the subcommand and the shim flags that follow it. */
function cliRole(argv: string[]): VersionsRole {
  const sub = argv[0] ?? "";
  if (sub === "daemon") return "service";
  if (sub === "serve") return "inference";
  if (sub === "tunnel") return "tunnel";
  if (sub === "executor-host") return "executor-host";
  if (sub !== "codex-shim") return "other";
  const args = argv.slice(1);
  if (!args.includes("--ssh")) return "desktop-adapter";
  // Everything after the `--` separator is what Codex itself was asked to run.
  const separator = args.indexOf("--");
  const forwarded = separator < 0 ? [] : args.slice(separator + 1);
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

/** The loopback ports a process listens on, from `lsof -a -p <pid> -iTCP -sTCP:LISTEN -P -n -Fn`. */
export function parseListenPorts(out: string): number[] {
  const ports = new Set<number>();
  for (const line of out.split("\n")) {
    const match = /^n(?:\[?(127\.0\.0\.1|localhost)\]?):(\d{1,5})(?:\s+\(LISTEN\))?$/.exec(line);
    const port = Number(match?.[2]);
    if (match && Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/** The release an inference process actually serves: whichever of its sockets answers with a header. */
async function servedRelease(pid: number, deps: VersionsExecutors): Promise<string | undefined> {
  const read = deps.sockets ?? realSockets;
  let ports: number[];
  try { ports = parseListenPorts(await read(pid)); } catch { return; }
  const probe = deps.health ?? realHealth;
  for (const port of ports) {
    try {
      const release = await probe(port);
      if (release && releaseName.test(release)) return release;
    } catch { /* the next socket, or `lsof`, may still answer */ }
  }
  return;
}

/** List this user's running gateway processes with the release each one loaded. */
export async function runVersions(deps: VersionsExecutors = {}): Promise<VersionsResult> {
  const ps = deps.ps ?? realPs;
  const lsof = deps.lsof ?? realLsof;
  const uid = deps.uid ?? (process.getuid?.() ?? 0);
  const scope: InstallScope = deps.root !== undefined
    ? { roots: pathForms(deps.root), installed: deps.installed ?? installedRelease(deps.root) }
    : locateInstall(deps.moduleUrl, deps.fallbackRoot ?? defaultInstallRoot());
  if (deps.installed !== undefined) scope.installed = deps.installed;
  if (deps.checkoutCli) scope.checkoutCli = pathForms(deps.checkoutCli);
  const rows = parsePs(await ps()).filter(row => row.uid === uid && row.pid !== process.pid);
  const processes: VersionsProcess[] = [];
  for (const row of rows) {
    const named = classifyCommand(row.command, scope);
    if (!named) continue;
    // An inference process that upgraded in place keeps its old runtime mapped, so its health answer wins.
    const served = named.role === "inference" ? await servedRelease(row.pid, deps) : undefined;
    if (served) { processes.push({ role: named.role, pid: row.pid, startedAt: row.startedAt, release: served }); continue; }
    const mapped = await lsof(row.pid).then(parseLsofTxt, () => RELEASE_UNKNOWN as string);
    processes.push({ role: named.role, pid: row.pid, startedAt: row.startedAt, release: mapped === RELEASE_UNKNOWN ? named.release : mapped });
  }
  processes.sort((left, right) => left.role.localeCompare(right.role) || left.pid - right.pid);
  return { installed: scope.installed ?? null, processes, lagging: processes.filter(row => row.release !== scope.installed).length };
}

/** A start time for a terminal, in the reader's own clock; the JSON keeps its ISO instant. */
export function formatStart(iso: string): string {
  const started = new Date(iso);
  if (Number.isNaN(started.getTime())) return iso.replace("T", " ").slice(0, 16);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())} ${pad(started.getHours())}:${pad(started.getMinutes())}`;
}

/** A short table for a terminal: what is installed, what is running, and whether they match. */
export function formatHuman(result: VersionsResult): string {
  const lines = [`installed ${result.installed ?? "unknown"}`, ""];
  if (!result.processes.length) return `${lines.join("\n")}no gateway processes running\n`;
  const role = Math.max(...result.processes.map(row => row.role.length));
  const pid = Math.max(...result.processes.map(row => String(row.pid).length));
  for (const row of result.processes) {
    lines.push(`  ${row.role.padEnd(role)}  ${String(row.pid).padStart(pid)}  ${formatStart(row.startedAt)}  ${row.release}`);
  }
  lines.push("");
  // One mention per distinct role and release, so a fleet of stale adapters is one line.
  const behind = [...new Set(result.processes.filter(row => row.release !== result.installed).map(row => `${row.role}@${row.release}`))];
  lines.push(behind.length ? `${behind.length} lagging: ${behind.join(" ")}` : `all on ${result.installed}`);
  return lines.join("\n") + "\n";
}

export const versionsUsage = "Usage: gateway versions [--json] [--check]\n";

export interface VersionsCommandDeps extends VersionsExecutors {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/**
 * `gateway versions [--json] [--check]`. A process loaded a release older than `current` fails
 * the check with exit 1. A run that names no installed release at all, from a checkout with no
 * default install beside it, cannot be compared and exits 2; `--json` still prints it, with
 * `installed` null. A bad flag, or a process list `ps` cannot read, also exits 2. `--help`,
 * with the two long flags or on its own, prints the usage line and exits 0.
 */
export async function versionsCommand(args: string[], deps: VersionsCommandDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.includes("--help") || args.includes("-h")) { out(versionsUsage); return 0; }
  if (args.some(arg => arg !== "--json" && arg !== "--check")) { err(versionsUsage); return 2; }
  let result: VersionsResult;
  try {
    result = await runVersions(deps);
  } catch {
    err("versions: could not read the process list\n");
    return 2;
  }
  if (args.includes("--json")) out(JSON.stringify(result, null, 2) + "\n");
  else out(formatHuman(result));
  if (!args.includes("--check")) return 0;
  if (result.installed === null) { err("versions: no installed release to compare against\n"); return 2; }
  return result.lagging > 0 ? 1 : 0;
}
