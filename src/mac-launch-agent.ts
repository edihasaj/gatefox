import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Launchctl = (args: string[]) => Promise<unknown>;

/** Explicit registration repairs a persisted disabled flag without restarting live jobs. */
export async function ensureLaunchAgent(domain: string, label: string, path: string, alreadyLoaded: boolean,
  run: Launchctl = args => exec("/bin/launchctl", args, { timeout: 10000 })): Promise<void> {
  await run(["enable", `${domain}/${label}`]);
  if (!alreadyLoaded) await run(["bootstrap", domain, path]);
}
