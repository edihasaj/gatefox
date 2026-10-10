import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../config.js";
import { CopilotRPC } from "./copilot-rpc.js";
import { ProviderError } from "./provider.js";

export function copilotEnvironment(authDirectory?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("COPILOT_PROVIDER_") || ["COPILOT_MODEL", "COPILOT_OFFLINE", "COPILOT_HOME", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NODE_DEBUG"].includes(key)) delete env[key];
  }
  if (authDirectory) env.COPILOT_HOME = authDirectory;
  return env;
}

export async function openCopilot(config: ProviderConfig, signal?: AbortSignal) {
  if (signal?.aborted) throw new ProviderError("cancelled", "Request cancelled", 499);
  const directory = await mkdtemp(join(tmpdir(), "gateway-copilot-"));
  const rpc = new CopilotRPC(copilotEnvironment(config.authDirectory), directory);
  const abort = () => rpc.stop(); signal?.addEventListener("abort", abort, { once: true });
  let closed = false;
  const close = async (sessionId?: string) => {
    if (closed) return; closed = true;
    signal?.removeEventListener("abort", abort);
    if (sessionId && !signal?.aborted) await rpc.request("session.delete", { sessionId }, 3000).catch(() => {});
    rpc.stop(); await rpc.exited; await rm(directory, { recursive: true, force: true });
  };
  try {
    const connected = await rpc.request("connect");
    if (connected.protocolVersion !== 3) throw new ProviderError("unsupported_protocol", "Copilot requires verified SDK protocol version 3");
    const auth = await rpc.request("auth.getStatus");
    if (auth.isAuthenticated !== true) throw new ProviderError("authentication", "Copilot subscription requires login", 401);
    return { rpc, directory, close };
  } catch (error) { await close(); if (signal?.aborted) throw new ProviderError("cancelled", "Request cancelled", 499); throw error; }
}
