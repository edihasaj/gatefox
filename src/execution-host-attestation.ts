import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseState } from "./self-update.js";

export interface ExecutionHostIdentity {
  hostPid: number;
  startedAtMs: number;
  runningRelease: string;
  sourceCommit: string;
}

const release = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/;
const source = /^[a-f0-9]{40}$/;

/**
 * Reads only this process's immutable release receipt. A checkout and an
 * unreadable, swapped, or mismatched receipt deliberately provide no proof.
 */
export async function executionHostIdentity(startedAtMs: number | undefined, moduleUrl = import.meta.url): Promise<ExecutionHostIdentity | undefined> {
  const state = releaseState(moduleUrl);
  const started = startedAtMs;
  if (!state || !release.test(state.running) || typeof started !== "number" || !Number.isSafeInteger(started) || started < 1) return;
  const path = resolve(dirname(fileURLToPath(moduleUrl)), "..", "release.json");
  let file;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) || info.size > 16 * 1024) return;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await file.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev || current.uid !== process.getuid?.() || (current.mode & 0o022) || current.size !== info.size) return;
    const receipt = JSON.parse(await file.readFile("utf8")) as Record<string, unknown>;
    if (receipt.version !== state.running || typeof receipt.source !== "string" || !source.test(receipt.source)) return;
    return { hostPid: process.pid, startedAtMs: started, runningRelease: state.running, sourceCommit: receipt.source };
  } catch { return; }
  finally { await file?.close(); }
}
