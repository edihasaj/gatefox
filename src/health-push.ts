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

/**
 * The push URL, and nothing else. The file must be a regular file this user owns with no
 * group or other bits: a monitor URL anyone can read is a monitor URL anyone can flip, so
 * anything wider is refused rather than used.
 */
export const readPushUrl: PushUrlReader = async path => {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); } catch { return { error: "missing" }; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) return { error: "insecure" };
    const text = (await handle.readFile("utf8")).trim();
    if (!text || /[\r\n]/.test(text) || !/^https?:\/\/\S{1,2046}$/.test(text)) return { error: "insecure" };
    return { url: text };
  } catch { return { error: "insecure" }; }
  finally { await handle.close().catch(() => undefined); }
};

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

/** One monitor request, with the status and message already in its query. */
export function pushRequest(url: string, status: "up" | "down", msg: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}status=${status}&msg=${encodeURIComponent(msg)}&ping=`;
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
