import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { executionHostHome, startExecutionHost } from "./execution-host.js";

/** Explicit foreground command for isolated SDK and adapter verification. */
export async function runExecutionHostCommand(configPath: string, codex?: string, nativeHome?: string): Promise<void> {
  if (!codex || !nativeHome) throw new Error("executor-host requires explicit --codex and --native-home paths");
  const config = await loadConfig(configPath);
  let stopping = false; let stopped: () => void = () => {};
  const done = new Promise<void>(resolve => { stopped = resolve; });
  const stop = () => { stopping = true; stopped(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
  try {
    host = await startExecutionHost({ config, configPath, codex: resolve(codex), nativeHome: resolve(nativeHome) });
    process.stdout.write(JSON.stringify({ pid: process.pid, executionHome: executionHostHome(configPath, nativeHome) }) + "\n");
    if (!stopping) await done;
  } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); await host?.close(); }
}
