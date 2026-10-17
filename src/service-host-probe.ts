import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { readOwner, sameSocketIdentity, sdkIdentity, socketIdentity, type HostOwner } from "./execution-host-storage.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";

/**
 * Why a running execution host failed its probe, from a fixed vocabulary:
 * - `receipt_mismatch`: `owner.json` no longer says this process runs the host at its control socket;
 * - `socket_mismatch`: the control link, or the SDK socket it names, is gone or is another socket than the receipt's;
 * - `status_timeout`: `execution/status` did not answer within the probe's limit (5 s);
 * - `status_failed`: the control socket refused the connection, or answered for another process;
 * - `sdk_changed`: the app engine a shared native host was verified against was replaced under it.
 */
export type HostProbeReason = "receipt_mismatch" | "socket_mismatch" | "status_timeout" | "status_failed" | "sdk_changed";

export interface HostProbeTarget {
  /** The host folder (`executionHostHome`). */
  home: string;
  /** The process the host runs in: the supervisor itself. */
  pid: number;
  /** The app engine to compare with the receipt; given only when the plan shares native chats. */
  codex?: string;
  timeoutMs?: number;
}

/**
 * What the last probe saw of the app engine file, so a file that did not change is hashed once per host start instead
 * of once a minute. The probe updates it; the supervisor resets it whenever a new host starts.
 */
export interface SdkBaseline { file?: string; sha256?: string }

/** Probes a running host; undefined means it is healthy. Nothing it reads is ever reported, only the reason. */
export async function probeExecutionHost(target: HostProbeTarget, baseline: SdkBaseline = {}): Promise<HostProbeReason | undefined> {
  const socketPath = resolve(target.home, "host.sock");
  const owner = await readOwner(resolve(target.home, "owner.json")).catch(() => undefined);
  if (!owner || owner.state !== "running" || owner.pid !== target.pid || owner.socketPath !== socketPath) return "receipt_mismatch";
  // A cleaned /tmp drops the SDK socket the link names: in-process the host still looks fine, but no adapter can reach it.
  const socket = await socketIdentity(socketPath).catch(() => undefined);
  if (!socket || !owner.socket || !sameSocketIdentity(socket, owner.socket)) return "socket_mismatch";
  const answer = await executionStatus(socketPath, target.timeoutMs ?? 5000);
  if (answer === "timeout") return "status_timeout";
  if (!answer || answer.pid !== target.pid || answer.version !== 1) return "status_failed";
  if (target.codex && await sdkChanged(target.codex, owner, baseline)) return "sdk_changed";
  return undefined;
}

/** One `execution/status` round trip on a short-lived client that holds no lease. */
async function executionStatus(socketPath: string, timeoutMs: number): Promise<{ pid?: unknown; version?: unknown } | "timeout" | undefined> {
  let connection: SocketAppServerConnection | undefined; let timer: NodeJS.Timeout | undefined;
  try {
    connection = new SocketAppServerConnection(socketPath, async () => {});
    const opened = connection;
    // Settled on its own, so a late answer or a late refusal after the timeout is never an unhandled rejection.
    const answer = opened.ready.then(() => opened.request("execution/status", {})).catch(() => undefined);
    const timeout = new Promise<"timeout">(done => { timer = setTimeout(() => done("timeout"), timeoutMs); });
    return await Promise.race([answer, timeout]);
  } catch { return undefined; }
  finally { clearTimeout(timer); connection?.stop(); }
}

/**
 * Whether the app engine differs from the one the host verified at its start. A path that now resolves elsewhere, or a
 * file that is gone, has changed. The file is hashed only when its `dev:ino:size:mtime:ctime` differs from the last
 * matching look, so an unchanged engine costs one hash per host start.
 */
async function sdkChanged(codex: string, owner: HostOwner, baseline: SdkBaseline): Promise<boolean> {
  const real = await realpath(codex).catch(() => undefined);
  if (!real || real !== owner.codex) return true;
  const info = await lstat(real, { bigint: true }).catch(() => undefined);
  if (!info?.isFile()) return true;
  const file = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  if (baseline.file === file && baseline.sha256 === owner.sdkSha256) return false;
  const identity = await sdkIdentity(codex).catch(() => undefined);
  if (!identity || identity.codex !== owner.codex || identity.sdkSha256 !== owner.sdkSha256) return true;
  baseline.file = file; baseline.sha256 = owner.sdkSha256;
  return false;
}
