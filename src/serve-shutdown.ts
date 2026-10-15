import { serveExitDeadlineMs } from "./runtime-activity.js";
import { flushRecords } from "./usage-ledger.js";

/** What a stopping server process needs from its server. */
export interface StoppingServer {
  close(callback?: (error?: Error) => void): unknown;
  closeAllConnections(): void;
  /** Records the requests still running as they stand; returns how many (server.ts `recordPending`). */
  recordPending(): number;
}

/**
 * Stops `server`: it closes after its drain and shutdown hooks, then the telemetry and the ledger are flushed and the
 * process exits. If the close takes longer than the exit deadline (a request whose provider stays silent), the requests
 * still running are recorded as they stand, with the usage their provider reported so far, before the flush and the exit,
 * so the spend of a request stopped at shutdown is not lost with the process.
 */
export function stopServing(server: StoppingServer, exit: (code: number) => void = code => process.exit(code), deadlineMs = serveExitDeadlineMs()): void {
  let finished = false;
  const finish = () => { if (finished) return; finished = true; void flushRecords().finally(() => exit(0)); };
  const deadline = setTimeout(() => { server.recordPending(); server.closeAllConnections(); finish(); }, deadlineMs).unref();
  server.close(() => { clearTimeout(deadline); finish(); });
}
