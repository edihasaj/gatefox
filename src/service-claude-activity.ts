import { execFile } from "node:child_process";
import { processStartMs } from "./boot-identity.js";
import type { ServiceComponent } from "./service-plan.js";

/** The two tunnel ids are adopted from the pinned Claude Desktop migration, not a namespace for arbitrary SSH children. */
const claudeTunnelIds = new Set(["claude-inference-tunnel", "claude-inference-studio"]);

/** Claude components are the loopback adapter, private inference, and precisely the two adopted Claude forwards. */
export const isClaudeComponent = (component: ServiceComponent): boolean =>
  component.kind === "claude-adapter" || component.kind === "claude-inference" ||
  component.kind === "tunnel" && claudeTunnelIds.has(component.id);

/** Answers whether it is safe to restart while these process ids run. Anything the check cannot prove must answer false. */
export type ClaudeIdle = (pids: number[]) => Promise<boolean>;

/** What one lsof run did: its captured output, and how it ended (`code` is a string such as "ENOENT" when it never ran). */
export interface LsofRun { stdout: string; stderr: string; code: number | string | null; killed: boolean }

/**
 * The single stderr shape this probe may look past: the three lines lsof prints for a file system it cannot `stat()`, when that
 * file system is the per-user CoreDevice `devicefs` mount. Apple's lsof emits the block once per un-stat-able mount from its mount
 * table walk (`lsof/dialects/darwin/libproc/dmnt.c`) and the text says only that *file* information may be incomplete. The socket
 * answers this probe asks for are read from `proc_pidfdinfo(PROC_PIDFDSOCKETINFO)` in `dsock.c`, so the block cannot hide an
 * established TCP connection and cannot invent one: a busy pid still prints it next to its socket line, and an idle pid still
 * exits 1 with empty stdout. Nothing else is excused -- the whole of stderr must be built out of these blocks, so a missing line,
 * an altered word, another file system type, a mount point outside `/Users/<one component>/Library/Developer/CoreDevice/DeviceFS`,
 * or any other diagnostic (a truncated block, a `proc_pidfdinfo` error, a mix of the two) keeps failing closed.
 */
const coreDeviceStatBlock = [
  "lsof: WARNING: can't stat\\(\\) devicefs file system /Users/[^/\\r\\n]+/Library/Developer/CoreDevice/DeviceFS\\n",
  " {6}Output information may be incomplete\\.\\n",
  " {6}assuming \"dev=[0-9a-fA-F]{1,16}\" from mount table\\n",
].join("");
const coreDeviceStatWarning = new RegExp(`^(?:${coreDeviceStatBlock})+$`);

/** Whether stderr asks no question of its own: silence, or nothing but whole recognized CoreDevice mount-stat blocks. */
const isIgnorableStderr = (stderr: string): boolean => stderr.trim() === "" || coreDeviceStatWarning.test(stderr);

export interface ClaudeIdleDeps {
  /** Runs one lsof probe and reports how it ended; it resolves for any exit, and rejects only for what it cannot describe. */
  run?: (file: string, args: string[]) => Promise<LsofRun>;
  /** `process.kill(pid, 0)`: returns while the pid is signalable and throws like `process.kill` otherwise (ESRCH gone, EPERM foreign). */
  signal?: (pid: number) => void;
  /** When the operating system says the pid started; undefined when that is unknown. */
  start?: (pid: number) => Promise<number | undefined>;
}

const runLsof = (file: string, args: string[]): Promise<LsofRun> => new Promise(resolve => {
  execFile(file, args, { timeout: 5000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
    resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: failure ? failure.code ?? null : 0, killed: failure?.killed === true });
  });
});
const signalPid = (pid: number): void => { process.kill(pid, 0); };
const readStart = (pid: number): Promise<number | undefined> => processStartMs(pid).catch(() => undefined);

/**
 * A Claude subprocess is provably idle only when lsof lists no established TCP connection for it. The Claude desktop app being
 * open is not the measure (an idle window holds no loopback connection; an agent-driven request holds one with the window
 * closed), and the pinned runtimes expose no idle guard of their own, so their sockets are the only external evidence. This is
 * a conservative snapshot of those sockets, not an atomic request drain: a request may begin the moment after it.
 *
 * The probe is `lsof -nP -a -p PID -iTCP -sTCP:ESTABLISHED`; without `-a` lsof ORs the selections and lists every process's TCP
 * sockets. A pid is idle only on a run that finished and said so: exit 0 with no output, or exit 1 (lsof's no-match exit) with
 * no stdout, and no stderr beyond the CoreDevice mount-stat block that this file proves irrelevant to the TCP answer -- and the run
 * was not killed. Every other end (a timeout, a missing binary, another exit code, any other warning on stderr, a probe that throws)
 * is an unanswered question and keeps the restart away. A pid that is gone (ESRCH) owns no
 * connection and is skipped, but one that cannot be signalled (EPERM) or whose start time is unknown, or differs before and
 * after the probe (the pid was reused), is refused: the question was not about the process the supervisor started.
 */
export function claudeIdleChecker(deps: ClaudeIdleDeps = {}): ClaudeIdle {
  const run = deps.run ?? runLsof;
  const signal = deps.signal ?? signalPid;
  const start = deps.start ?? readStart;
  const gone = (pid: number): boolean | undefined => {
    try { signal(pid); return false; }
    catch (error) { return (error as NodeJS.ErrnoException)?.code === "ESRCH" ? true : undefined; }
  };
  return async pids => {
    for (const pid of pids) {
      try {
        if (!Number.isSafeInteger(pid) || pid <= 1) return false;
        const missing = gone(pid);
        if (missing === undefined) return false;
        if (missing) continue;
        const before = await start(pid);
        if (before === undefined) return false;
        const result = await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:ESTABLISHED"]);
        const after = await start(pid);
        if (after !== before) {
          // A process that exited during the probe is gone; any other change or an unknown start is not the same process.
          if (after === undefined && gone(pid) === true) continue;
          return false;
        }
        if (result.killed || result.stdout.trim() !== "") return false;
        if (!isIgnorableStderr(result.stderr)) return false;
        if (result.code !== 0 && result.code !== 1) return false;
      } catch { return false; }
    }
    return true;
  };
}

export const establishedTcpClaudeIdle = claudeIdleChecker();
