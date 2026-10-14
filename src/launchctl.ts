import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type LaunchctlRun = (args: string[], options: { timeout: number }) => Promise<unknown>;
const run: LaunchctlRun = (args, options) => exec("/bin/launchctl", args, options);

/** launchctl reports a job that is already gone as `3: No such process` (ESRCH). */
export function isNoSuchProcess(error: unknown): boolean {
  const failure = error as { stderr?: unknown; message?: unknown; code?: unknown } | undefined;
  return [failure?.stderr, failure?.message].some(text => typeof text === "string" && /No such process|\bESRCH\b/.test(text));
}

/** Stop a job. A job launchd no longer has is already stopped, so ESRCH is success; every other failure still throws. */
export async function bootoutJob(target: string, runner: LaunchctlRun = run): Promise<"stopped" | "already_stopped"> {
  try { await runner(["bootout", target], { timeout: 10000 }); return "stopped"; }
  catch (error) { if (isNoSuchProcess(error)) return "already_stopped"; throw error; }
}
