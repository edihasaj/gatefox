import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { hostname, release as osRelease } from "node:os";
import { basename, join } from "node:path";

/**
 * Exceptions only, sent to the private GlitchTip project. Nothing here runs on a
 * request path: handled errors are posted in the background, and a crashing
 * process spools its event synchronously for the next start to send. Events
 * carry the exception type, a scrubbed message and file/function/line frames.
 * The DSN lives in `<state>/glitchtip.dsn` (mode 0600); without it nothing is sent.
 */
interface Target { url: string; auth: string }
let target: Target | undefined; let spool: string | undefined;
let component = "gateway"; let version = "unknown"; let machine = "unknown";
const seen = new Map<string, number>(); let sentThisHour = 0; let hourStarted = Date.now();

export function parseDsn(value: string): Target | undefined {
  try {
    const dsn = new URL(value.trim()); const project = dsn.pathname.replace(/^\/+|\/+$/g, "");
    const loopback = dsn.protocol === "http:" && ["127.0.0.1", "localhost"].includes(dsn.hostname);
    if ((dsn.protocol !== "https:" && !loopback) || !dsn.username || !/^\d+$/.test(project)) return;
    return { url: `${dsn.origin}/api/${project}/store/`, auth: `Sentry sentry_version=7, sentry_client=harness-gateway/1, sentry_key=${dsn.username}` };
  } catch { return; }
}

/** Reduces text to something safe to store: no credentials, long secrets, or home paths. */
export function scrub(text: string): string {
  return text.slice(0, 600)
    .replace(/(bearer|basic|token|key|secret|password|authorization)([\s:=]+)\S+/gi, "$1$2[redacted]")
    .replace(/\b(sk|pk|rk|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]")
    .replace(/\/Users\/[^\s'"]+/g, path => ".../" + basename(path))
    .replace(/https?:\/\/[^\s'"]+/g, url => { try { return new URL(url).origin; } catch { return "[url]"; } })
    .slice(0, 300);
}

function frames(stack: string | undefined): Array<Record<string, unknown>> {
  return (stack || "").split("\n").slice(1, 40).flatMap(line => {
    const match = /at (?:(.+?) \()?(?:file:\/\/)?([^()]+?):(\d+):(\d+)\)?$/.exec(line.trim());
    if (!match) return [];
    const file = match[2]; const ours = /\/dist\/|\/src\//.test(file) && !file.includes("node_modules");
    return [{ function: match[1] ? scrub(match[1]) : "<anonymous>", filename: ours ? file.replace(/^.*\/(dist|src)\//, "$1/") : basename(file), lineno: Number(match[3]), colno: Number(match[4]), in_app: ours }];
  }).reverse();
}

export function exceptionEvent(error: unknown, where: string, fatal = false): Record<string, unknown> {
  const failure = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Non-error value thrown");
  const type = scrub(failure.name || "Error").slice(0, 80);
  return {
    event_id: randomUUID().replaceAll("-", ""), timestamp: new Date().toISOString(), platform: "node", level: fatal ? "fatal" : "error",
    logger: component, release: `harness-gateway@${version}`, environment: "production", server_name: machine,
    tags: { component, where: scrub(where).slice(0, 80), node: process.version, os: `macOS ${osRelease()}` },
    // JSON parser messages quote the text they failed on, which can be tool arguments or model output.
    exception: { values: [{ type, value: failure instanceof SyntaxError || /is not valid JSON|in JSON at position/i.test(failure.message) ? "JSON parse failed" : scrub(failure.message || ""), stacktrace: { frames: frames(failure.stack) } }] },
  };
}

async function post(event: Record<string, unknown>): Promise<boolean> {
  if (!target) return false;
  try {
    const response = await fetch(target.url, { method: "POST", headers: { "Content-Type": "application/json", "X-Sentry-Auth": target.auth }, body: JSON.stringify(event), signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch { return false; }
}

/** Sends a handled exception in the background; repeats of the same failure within ten minutes are dropped. */
export function reportException(error: unknown, where: string): void {
  if (!target || process.env.GATEWAY_ERROR_REPORTS === "off") return;
  const now = Date.now(); if (now - hourStarted > 3600000) { hourStarted = now; sentThisHour = 0; }
  const failure = error instanceof Error ? error : undefined;
  const key = `${where}|${failure?.name}|${failure?.stack?.split("\n")[1]?.trim() ?? failure?.message}`;
  if ((seen.get(key) ?? 0) > now - 600000 || sentThisHour >= 30) return;
  seen.set(key, now); if (seen.size > 500) seen.delete(seen.keys().next().value!); sentThisHour++;
  void post(exceptionEvent(error, where));
}

function spoolCrash(error: unknown, origin: string): void {
  if (!spool || !target) return;
  try {
    // Write then rename, so a reader never sees a half-written report.
    mkdirSync(spool, { recursive: true, mode: 0o700 }); const name = join(spool, `${Date.now()}-${process.pid}`);
    writeFileSync(`${name}.tmp`, JSON.stringify(exceptionEvent(error, `crash:${origin}`, true)), { mode: 0o600 }); renameSync(`${name}.tmp`, `${name}.json`);
  } catch { /* A crash report never masks the crash. */ }
}

async function sendSpooled(): Promise<void> {
  if (!spool) return;
  const names = (await readdir(spool).catch(() => [] as string[])).filter(name => name.endsWith(".json")).sort();
  for (const name of names.slice(0, 20)) {
    const path = join(spool, name);
    const event = await readFile(path, "utf8").then(text => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return undefined; } }, () => undefined);
    const old = (await stat(path).catch(() => undefined))?.mtimeMs ?? 0;
    if (!event || await post(event) || Date.now() - old > 7 * 86400000) await rm(path, { force: true }).catch(() => {});
  }
  for (const name of names.slice(20)) await rm(join(spool, name), { force: true }).catch(() => {});
}

/** Enables reporting for a long-running process. The crash monitor never changes Node's crash behavior. */
export function startErrorReports(stateDirectory: string, name: string): void {
  component = name; spool = join(stateDirectory, "error-spool");
  try { version = String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version); } catch { version = "unknown"; }
  machine = "mac-" + createHash("sha256").update(hostname()).digest("hex").slice(0, 8);
  try {
    const path = join(stateDirectory, "glitchtip.dsn"); const info = statSync(path);
    // A DSN readable by other users is ignored rather than trusted.
    target = info.isFile() && info.uid === process.getuid?.() && !(info.mode & 0o077) ? parseDsn(readFileSync(path, "utf8")) : undefined;
  } catch { target = undefined; }
  if (!target || process.env.GATEWAY_ERROR_REPORTS === "off") { target = undefined; return; }
  if (!process.listeners("uncaughtExceptionMonitor").includes(spoolCrash)) process.on("uncaughtExceptionMonitor", spoolCrash);
  void sendSpooled().catch(() => {});
}
