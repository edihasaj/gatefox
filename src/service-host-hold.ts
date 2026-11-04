import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Whether an app is attached to this Mac's gateway: a desktop adapter (ChatGPT's own app-server connection, or a relay
 * session) or an SSH listener serving a remote app. Each holds a control connection to the execution host, and moving the
 * host closes it: the adapter then ends its session and ChatGPT 26.1029 restarts with "hit a snag". The process list is
 * enough, and far cheaper than `gateway versions` (no lsof); a listener retires itself once it has no session.
 */
export function attachedFromPs(output: string): boolean {
  return output.split("\n").some(line => /\bcli\.js codex-shim\b/.test(line) && (!/\s--ssh(\s|$)/.test(line) || !/\sproxy(\s|$)/.test(line)));
}

export async function appsAttached(ps: () => Promise<string> = async () => (await exec("/bin/ps", ["-U", String(process.getuid?.() ?? 0), "-o", "command="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })).stdout): Promise<boolean> {
  try { return attachedFromPs(await ps()); } catch { return true; } // Unknown is attached: holding a move is the safe answer.
}
