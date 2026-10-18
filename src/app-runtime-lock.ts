import { constants } from "node:fs";
import { lstat, mkdir, open, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * This directory is also acquired by scripts/install.sh. Do not make it stale-breakable: an unknown installer must win.
 * SIGKILL cannot run cleanup; after confirming no publisher remains, an operator may remove that leftover directory manually.
 */
export const installationLockName = ".gateway-installation-lock";
const abortSignals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
type AbortSignal = typeof abortSignals[number];

export interface InstallationGuard { check(): void }
export class InstallationAborted extends Error {
  constructor(readonly signal: AbortSignal) { super(`Installation publication aborted by ${signal}`); this.name = "InstallationAborted"; }
}
export function installationAbortSignal(error: unknown): AbortSignal | undefined {
  return error instanceof InstallationAborted ? error.signal : undefined;
}

async function releaseOwnedLock(lock: string, ownerPath: string, owner: FileHandle): Promise<void> {
  try {
    const mine = await owner.stat({ bigint: true }); const current = await lstat(ownerPath, { bigint: true }).catch(() => undefined);
    if (!current || current.dev !== mine.dev || current.ino !== mine.ino) return;
    const directory = await lstat(lock, { bigint: true }).catch(() => undefined);
    if (!directory?.isDirectory()) return;
    await unlink(ownerPath).catch(() => undefined);
    const final = await lstat(lock, { bigint: true }).catch(() => undefined);
    if (final && final.dev === directory.dev && final.ino === directory.ino) await rmdir(lock).catch(() => undefined);
  } finally { await owner.close().catch(() => undefined); }
}

/** Serializes release and signed-runtime publications for one installer root. */
export async function withInstallationLock<T>(root: string, action: (guard: InstallationGuard) => Promise<T>): Promise<T> {
  const lock = join(root, installationLockName);
  let aborted: AbortSignal | undefined;
  const handlers = new Map<AbortSignal, () => void>();
  for (const signal of abortSignals) {
    const handler = () => { aborted ??= signal; };
    handlers.set(signal, handler); process.on(signal, handler);
  }
  const guard: InstallationGuard = { check: () => { if (aborted) throw new InstallationAborted(aborted); } };
  let owner: FileHandle | undefined; let ownerPath = ""; let value!: T; let failure: unknown;
  try {
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("The gateway installation is busy; retry."), { code: "ELOCKBUSY" });
      throw error;
    }
    // Do not check the signal until this receipt exists: a signal delivered just after mkdir still gets cleaned up.
    ownerPath = join(lock, `.owner-${randomUUID()}`); owner = await open(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await owner.writeFile(String(process.pid)); guard.check(); value = await action(guard); guard.check();
  } catch (error) { failure = error; }
  finally {
    if (owner) await releaseOwnedLock(lock, ownerPath, owner);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
  if (aborted) throw new InstallationAborted(aborted);
  if (failure) throw failure;
  return value;
}
