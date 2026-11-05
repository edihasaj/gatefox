import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { GatewaySdkRuntime } from "./gateway-sdk-runtime.js";

/**
 * The adapter asks which gateway SDK to use on every request for an unloaded gateway chat, and the full answer hashes a file of
 * several hundred MiB. A reconnecting app asking about dozens of chats spent half a minute on that alone. So the adapter keeps
 * the verified answer while the SDK's files stay the same ones, and concurrent callers share one verification.
 *
 * This is only safe because the adapter's answer never decides what runs. It names the SDK, and whatever spawns one verifies
 * the bytes first: the execution host hashes on every spawn (`selectedRuntime` in execution-host.ts) and refuses a digest that
 * does not match, and the adapter's own private executors do the same (`gateway()` in app-server-backends.ts). A change a stat
 * cannot see, such as a write through a shared mapping, therefore ends in a refusal rather than in the changed file running.
 * Do not use this for a decision to execute.
 */
export type RuntimeIdentity = (runtime: GatewaySdkRuntime) => Promise<string>;

/** Device, inode, size, times, owner and mode of the files a verification read; a missing companion is part of the identity. */
export const runtimeFilesIdentity: RuntimeIdentity = async runtime => {
  const directory = dirname(runtime.executable);
  const required = await lstat(runtime.executable, { bigint: true });
  const part = (stat: Awaited<ReturnType<typeof entry>>) => stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.uid, stat.mode].join(":") : "none";
  const entry = (name: string) => lstat(resolve(directory, name), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return [runtime.executable, part(required), part(await entry("build.json")), part(await entry("codex-code-mode-host"))].join("\0");
};

/** Wraps a verifying resolver. An answer without readable files, or no answer, is never kept, so the next caller verifies again. */
export function memoizedRuntime(verify: () => Promise<GatewaySdkRuntime | undefined>, identity: RuntimeIdentity = runtimeFilesIdentity): () => Promise<GatewaySdkRuntime | undefined> {
  let known: { runtime: GatewaySdkRuntime; identity: string } | undefined;
  let flight: Promise<GatewaySdkRuntime | undefined> | undefined;
  return async () => {
    const remembered = known;
    if (remembered) {
      const current = await identity(remembered.runtime).catch(() => undefined);
      if (current === remembered.identity) return remembered.runtime;
      // Another caller may have replaced it while this one looked.
      if (known === remembered) known = undefined;
    }
    flight ??= (async () => {
      const runtime = await verify();
      const current = runtime && await identity(runtime).catch(() => undefined);
      if (runtime && current !== undefined) known = { runtime, identity: current };
      return runtime;
    })().finally(() => { flight = undefined; });
    return flight;
  };
}
