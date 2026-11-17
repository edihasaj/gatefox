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

/**
 * `launchctl bootout` can return while launchd is still removing the job. Bootstrapping the same
 * label before removal finishes fails with `Bootstrap failed: 5: Input/output error`, so wait until
 * launchd no longer reports any of the labels.
 */
export async function waitForJobsUnloaded(labels: string[], isLoaded: (label: string) => Promise<boolean>, wait: (ms: number) => Promise<unknown>, attempts = 50, intervalMs = 200): Promise<void> {
  let remaining = labels;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    const still: string[] = [];
    for (const label of remaining) if (await isLoaded(label)) still.push(label);
    if (!still.length) return;
    remaining = still;
    if (attempt < attempts) await wait(intervalMs);
  }
  throw new Error(`launchd still has ${remaining.join(", ")} after bootout`);
}
