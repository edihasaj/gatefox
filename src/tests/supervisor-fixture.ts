import { after } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceComponent } from "../service-plan.js";

const exec = promisify(execFile);
const pidFiles = new Set<string>();
const pidFile = (directory: string) => join(directory, "fixture-pids");

/**
 * A supervised test child that cannot outlive its test. It records its pid in `<directory>/fixture-pids`, which
 * killFixtures SIGKILLs whatever the test's outcome (a child that ignores SIGTERM included), and it exits by itself once
 * the process that started it is gone, so even a test process that is killed leaves no orphan behind.
 */
export function fixtureComponent(directory: string, id: string, kind: ServiceComponent["kind"], source: string): ServiceComponent {
  const pids = pidFile(directory); pidFiles.add(pids);
  const guard = `require('node:fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n'); { const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 250).unref(); }`;
  // Relay flags appended by a test belong to the evaluated fixture, not to the Node interpreter.
  return { id, kind, command: process.execPath, args: ["-e", `${guard} ${source}`, "--"], log: join(directory, id + ".log") };
}

/**
 * SIGKILLs every fixture child still running, of one folder or of every folder this file used. A pid is signalled only
 * while its command line still names that folder's pid file, so a pid the system gave to another process is never touched.
 */
export async function killFixtures(directory?: string): Promise<void> {
  for (const file of directory ? [pidFile(directory)] : [...pidFiles]) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const pid of new Set(text.split("\n").map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1))) {
      const command = await exec("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)]).then(result => result.stdout, () => "");
      if (!command.includes(file)) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
}

/** Call once at the top of a test file that starts fixture children: every one left is killed when the file's tests end. */
export function killFixturesAfterTests(): void { after(() => killFixtures()); }
