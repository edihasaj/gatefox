import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";

export interface LegacyNativeWriter { pid: number; kind: "native-sdk" | "gateway-sdk" }

/** Native SDK children under the relay cannot be treated as idle from HTTP usage. */
export function legacyNativeWriters(snapshot: string, configPath: string, codex: string, managedNativePid?: number): LegacyNativeWriter[] {
  const rows = snapshot.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), args: match[3] }] : [];
  });
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const config = resolve(configPath);
  const selected = resolve(codex);
  const executables = [selected, ...(selected.endsWith("/bin/codex") ? [resolve(dirname(selected), "../CodexCLI.app/Contents/MacOS/codex")] : [])];
  const containsConfig = (args: string) => args.includes(config) || args.includes(JSON.stringify(config).slice(1, -1));
  return rows.flatMap<LegacyNativeWriter>(row => {
    if (row.pid === managedNativePid || !/(?:^|\s)app-server(?:\s|$)/.test(row.args) || /(?:^|\s)proxy(?:\s|$)/.test(row.args)) return [];
    if (/(?:^|\s)codex-shim(?:\s|$)/.test(row.args)) return [];
    let parent = byPid.get(row.parent); const seen = new Set<number>(); let belongs = false;
    while (parent && !seen.has(parent.pid)) {
      seen.add(parent.pid);
      if (/(?:^|\s)codex-shim(?:\s|$)/.test(parent.args) && containsConfig(parent.args)) { belongs = true; break; }
      parent = byPid.get(parent.parent);
    }
    // A same-SDK native app-server without a declared home is ambiguous. Refuse
    // migration rather than inspect credentials or assume it belongs elsewhere.
    const sameSdk = executables.some(path => row.args.startsWith(path + " ") || row.args.startsWith('"' + path + '" '));
    if (!belongs && !sameSdk) return [];
    return [{ pid: row.pid, kind: row.args.includes("model_catalog_json=") ? "gateway-sdk" : "native-sdk" }];
  });
}

export async function inspectNativeWriters(configPath: string, codex: string, managedNativePid?: number): Promise<LegacyNativeWriter[]> {
  try {
    const { stdout } = await promisify(execFile)("/bin/ps", ["-axo", "pid=,ppid=,args="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    return legacyNativeWriters(stdout, configPath, codex, managedNativePid);
  } catch { throw new Error("Cannot verify legacy native writers; the existing service was preserved"); }
}
