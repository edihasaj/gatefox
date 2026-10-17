import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pushTimeoutMs, type Finding, type PushOutcome, type Verdict } from "./health-types.js";

/**
 * The alert path: one GET to a Uptime Kuma push monitor, whose URL lives only in a
 * private file. The URL is a credential, so it is never returned, printed, stored in a
 * report, or repeated in an error; the only thing that comes back from the network is
 * whether the monitor took the heartbeat, named from a list of three.
 *
 * `ok` and `warn` both send `status=up` — a lagging component is worth reading, not worth
 * a Discord ping — and only `fail` is `down`.
 */
export const pushUrlPath = (stateDirectory: string): string => resolve(stateDirectory, "alert-push-url");
/** The monitor's message limit, so a long reason list cannot make an unwieldy request. */
export const summaryLimit = 200;

export interface PushUrlReadResult { url?: string; error?: "missing" | "insecure" }
export type PushUrlReader = (path: string) => Promise<PushUrlReadResult>
/** Who may read the file, from its own inode. A test hands in the answer it is describing. */
export interface PushUrlPermissions { mode: number; uid: number; isFile: boolean }
export interface PushUrlDeps { stat?: (path: string) => Promise<PushUrlPermissions> }

/**
 * The push URL, and nothing else. The file must be a regular file this user owns with no
 * group or other bits: a monitor URL anyone can read is a monitor URL anyone can flip, so
 * anything wider is refused rather than used.
 */
export async function readPushUrl(path: string, deps: PushUrlDeps = {}): Promise<PushUrlReadResult> {
  let handle;
  // O_NONBLOCK so a fifo cannot park the run, O_NOFOLLOW so a planted link is refused, not followed.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
  try { handle = await open(path, flags); } catch (error) {
    // Only "there is no file here" is a quiet answer; anything else is a file this run cannot vouch for.
    return { error: (error as { code?: string })?.code === "ENOENT" ? "missing" : "insecure" };
  }
  try {
    const info = deps.stat ? await deps.stat(path) : await handle.stat().then(owned => ({ mode: owned.mode, uid: owned.uid, isFile: owned.isFile() }));
    if (!info.isFile || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) return { error: "insecure" };
    const text = (await handle.readFile("utf8")).trim();
    if (!text || /[\r\n]/.test(text) || text.length > 2048) return { error: "insecure" };
    // A URL is a URL: a written http(s) authority with a host in it, and a URL the parser reads
    // the same way. `https:///no-host` parses to a host called "no-host", so the shape is checked too.
    let parsed: URL;
    try { parsed = new URL(text); } catch { return { error: "insecure" }; }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.host) return { error: "insecure" };
    if (!/^https?:\/\/[^\s/?#]+/i.test(text)) return { error: "insecure" };
    return { url: text };
  } catch { return { error: "insecure" }; }
  finally { await handle.close().catch(() => undefined); }
}

/** The monitor's message: the verdict, then as many findings as the limit allows. */
export function pushSummary(verdict: Verdict, findings: Finding[], limit = summaryLimit): string {
  const head = `gateway ${verdict}`;
  const parts: string[] = [];
  let length = head.length;
  for (const reason of findings.filter(finding => finding.level !== "info").map(finding => finding.reason)) {
    if (length + reason.length + 1 > limit) break;
    parts.push(reason); length += reason.length + 1;
  }
  const text = parts.length ? `${head}: ${parts.join(" ")}` : head;
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * One monitor request, with the status and message already in its query. The three keys are
 * set, not appended: a URL copied out of Uptime Kuma already ends in `?status=up&msg=OK&ping=`,
 * and a second copy of each would leave the monitor reading the stale one. Whatever else the
 * URL carries is kept, and the query is written back with `%20` for a space rather than the
 * `+` that `URLSearchParams` would put there.
 */
export function pushRequest(url: string, status: "up" | "down", msg: string): string {
  const target = new URL(url);
  target.searchParams.set("status", status);
  target.searchParams.set("msg", msg);
  target.searchParams.set("ping", "");
  const query = [...target.searchParams].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  // The path is the token's own and is carried as it was given, down to its trailing slash.
  return `${target.origin}${target.pathname}${query ? `?${query}` : ""}`;
}

export interface PushTransportDeps {
  /** Sends one request and reports only whether the monitor took it. */
  send?: (url: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number }>;
  timeoutMs?: number;
}

/**
 * The heartbeat. A `send` that rejects with a timeout reads as `timeout`, a rejected
 * status as `http_<status>`, and anything else as `network` — the three ways this can
 * fail that are worth naming without ever quoting the monitor.
 */
export async function pushVerdict(url: string, verdict: Verdict, findings: Finding[], deps: PushTransportDeps = {}): Promise<PushOutcome> {
  const status = verdict === "fail" ? "down" : "up";
  const request = pushRequest(url, status, pushSummary(verdict, findings));
  const timeoutMs = deps.timeoutMs ?? pushTimeoutMs;
  const send = deps.send ?? ((target, signal) => fetch(target, { signal, redirect: "error" }).then(response => ({ ok: response.ok, status: response.status })));
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const answer = await send(request, signal);
    return answer.ok ? { state: "sent", up: status === "up" } : { state: "failed", error: `http_${answer.status}` };
  } catch (error) {
    const name = (error as { name?: string })?.name ?? "";
    return { state: "failed", error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
}

/** What the push section adds to the findings: its own outcome, never the monitor's URL. */
export function pushFindings(outcome: PushOutcome): Finding[] {
  if (outcome.state === "failed") return [{ level: "warn", reason: `alert push failed (${outcome.error ?? "network"})` }];
  if (outcome.state === "insecure") return [{ level: "fail", reason: "alert push url not private" }];
  if (outcome.state === "skipped") return [{ level: "info", reason: "alert push not configured" }];
  return [];
}
