import { rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderConfig } from "../config.js";
import { CopilotRPC } from "./copilot-rpc.js";
import { directoryPrefix, ensureCopilotParent, type DirectoryKind } from "./copilot-directories.js";
import { ProviderError } from "./provider.js";

export function copilotEnvironment(authDirectory?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("COPILOT_PROVIDER_") || ["COPILOT_MODEL", "COPILOT_OFFLINE", "COPILOT_HOME", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NODE_DEBUG"].includes(key)) delete env[key];
  }
  if (authDirectory) env.COPILOT_HOME = authDirectory;
  return env;
}

/** Every client this module copy opened whose folder still exists: from its creation until its removal, starting and closing included. */
const open = new Set<{ directory: string; rpc?: CopilotRPC }>();
let exitHandler = false;

/**
 * For a process that is exiting right now: kills every Copilot CLI process group this module started and removes
 * every private folder, with synchronous calls only. It is the process's `exit` handler; the next gateway's
 * startup sweep covers a process that is killed outright.
 */
export function stopCopilotClientsNow(): void {
  for (const entry of open) {
    entry.rpc?.kill();
    try { rmSync(entry.directory, { recursive: true, force: true }); } catch { /* Best effort; the next gateway sweeps it. */ }
  }
  open.clear();
}

export interface OpenOptions {
  /** `live` for a long-lived session, `run` (the default) for a single request; both folder names carry this gateway's pid and start time. */
  kind?: DirectoryKind;
}

/**
 * Starts one CLI process in a new private folder (0700) that is its configuration folder, its log folder and,
 * through TMPDIR, its temp folder, so nothing it writes outlives `close`.
 */
export async function openCopilot(config: ProviderConfig, signal?: AbortSignal, options: OpenOptions = {}) {
  if (signal?.aborted) throw new ProviderError("cancelled", "Request cancelled", 499);
  // The folder lives in the dedicated parent (0700), so the startup sweep reads only that. mkdtemp creates the directory 0700.
  // The CLI writes its event log (which holds prompts) here, so the mode is also enforced.
  const directory = await mkdtemp(join(await ensureCopilotParent(), await directoryPrefix(options.kind ?? "run")));
  const entry: { directory: string; rpc?: CopilotRPC } = { directory }; open.add(entry);
  if (!exitHandler) { exitHandler = true; process.once("exit", stopCopilotClientsNow); }
  let rpc: CopilotRPC | undefined;
  const abort = () => rpc?.stop(); signal?.addEventListener("abort", abort, { once: true });
  let closing: Promise<void> | undefined;
  // `hard` ends the process at once (SIGKILL of its group) instead of asking it to exit: a live session being closed must not make another model call.
  const close = (sessionId?: string, hard = false) => closing ??= (async () => {
    signal?.removeEventListener("abort", abort);
    if (sessionId && !signal?.aborted && !hard) await rpc?.request("session.delete", { sessionId }, 3000).catch(() => {});
    if (hard) rpc?.kill(); else rpc?.stop();
    await rpc?.exited; await rm(directory, { recursive: true, force: true });
    open.delete(entry);
  })();
  try {
    await chmod(directory, 0o700);
    const env = copilotEnvironment(config.authDirectory);
    const tmp = join(directory, "tmp"); await mkdir(tmp, { mode: 0o700 }); env.TMPDIR = tmp;
    rpc = entry.rpc = new CopilotRPC(env, directory);
    if (signal?.aborted) rpc.stop();
    const connected = await rpc.request("connect");
    if (connected.protocolVersion !== 3) throw new ProviderError("unsupported_protocol", "Copilot requires verified SDK protocol version 3");
    const auth = await rpc.request("auth.getStatus");
    if (auth.isAuthenticated !== true) throw new ProviderError("authentication", "Copilot subscription requires login", 401);
    // The caller's signal only guards startup for a live session; the session outlives the request.
    return { rpc, directory, close, release: () => signal?.removeEventListener("abort", abort) };
  } catch (error) { await close(); if (signal?.aborted) throw new ProviderError("cancelled", "Request cancelled", 499); throw error; }
}
export type CopilotClient = Awaited<ReturnType<typeof openCopilot>>;
