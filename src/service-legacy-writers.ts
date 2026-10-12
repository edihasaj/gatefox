import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

interface ProcessRow { pid: number; parent: number; args: string }
export interface LegacyWriter { pid: number; kind: "adapter" | "executor" }

/** Process arguments stay private; callers receive only PID and managed role. */
export function externalLegacyWriters(snapshot: string, configPath: string, stateDirectory: string, supervisorPid?: number): LegacyWriter[] {
  const rows = snapshot.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/); return match ? [{ pid: Number(match[1]), parent: Number(match[2]), args: match[3] }] : [];
  });
  const parents = new Map(rows.map(row => [row.pid, row.parent]));
  const owned = (row: ProcessRow) => {
    if (!supervisorPid) return false;
    let pid = row.pid; const seen = new Set<number>();
    while (pid > 0 && !seen.has(pid)) { if (pid === supervisorPid) return true; seen.add(pid); pid = parents.get(pid) || 0; }
    return false;
  };
  const containsPath = (args: string, path: string) => args.includes(resolve(path)) || args.includes(JSON.stringify(resolve(path)).slice(1, -1));
  return rows.flatMap<LegacyWriter>(row => {
    if (owned(row) || !/(?:^|\s)app-server(?:\s|$)/.test(row.args)) return [];
    if (row.args.includes("model_catalog_json=") && containsPath(row.args, stateDirectory)) return [{ pid: row.pid, kind: "executor" as const }];
    if (/(?:^|\s)codex-shim(?:\s|$)/.test(row.args) && containsPath(row.args, configPath)) return [{ pid: row.pid, kind: "adapter" as const }];
    return [];
  });
}

export async function inspectLegacyWriters(configPath: string, stateDirectory: string, supervisorPid?: number): Promise<LegacyWriter[]> {
  try {
    const { stdout } = await promisify(execFile)("/bin/ps", ["-axo", "pid=,ppid=,args="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    return externalLegacyWriters(stdout, configPath, stateDirectory, supervisorPid);
  } catch { throw new Error("Cannot verify legacy gateway writers; the existing service was preserved"); }
}
