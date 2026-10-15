import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../config.js";
import { CopilotRPC } from "./copilot-rpc.js";
import { directoryPrefix, type DirectoryKind } from "./copilot-directories.js";
import { ProviderError } from "./provider.js";

export function copilotEnvironment(authDirectory?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("COPILOT_PROVIDER_") || ["COPILOT_MODEL", "COPILOT_OFFLINE", "COPILOT_HOME", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NODE_DEBUG"].includes(key)) delete env[key];
  }
  if (authDirectory) env.COPILOT_HOME = authDirectory;
  return env;
}

export interface OpenOptions {
  /** `live` for a long-lived session, `run` (the default) for a single request; both folder names carry this gateway's pid, so a later gateway can sweep a dead one's leftovers. */
  kind?: DirectoryKind;
  /** Point the CLI's TMPDIR at a private folder inside its directory, so nothing it stages outside the directory survives the session. */
  privateTmp?: boolean;
}

export async function openCopilot(config: ProviderConfig, signal?: AbortSignal, options: OpenOptions = {}) {
  if (signal?.aborted) throw new ProviderError("cancelled", "Request cancelled", 499);
  // mkdtemp creates the directory 0700. The CLI writes its event log (which holds prompts) here, so the mode is also enforced.
  const directory = await mkdtemp(join(tmpdir(), directoryPrefix(options.kind ?? "run")));
  let rpc: CopilotRPC | undefined;
  const abort = () => rpc?.stop(); signal?.addEventListener("abort", abort, { once: true });
  let closed = false;
  // `hard` ends the process at once (SIGKILL of its group) instead of asking it to exit: a live session being closed must not make another model call.
  const close = async (sessionId?: string, hard = false) => {
    if (closed) return; closed = true;
    signal?.removeEventListener("abort", abort);
    if (sessionId && !signal?.aborted && !hard) await rpc?.request("session.delete", { sessionId }, 3000).catch(() => {});
    if (hard) rpc?.kill(); else rpc?.stop();
    await rpc?.exited; await rm(directory, { recursive: true, force: true });
  };
  try {
    await chmod(directory, 0o700);
    const env = copilotEnvironment(config.authDirectory);
    if (options.privateTmp) { const tmp = join(directory, "tmp"); await mkdir(tmp, { mode: 0o700 }); env.TMPDIR = tmp; }
    rpc = new CopilotRPC(env, directory);
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
