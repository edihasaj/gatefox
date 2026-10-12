import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { withPrivateFileLock } from "./private-file-lock.js";

/** Serialize registration changes with next-login consolidation. */
export async function withLoginRegistrationLock<T>(state: string, action: () => Promise<T>): Promise<T> {
  await mkdir(state, { recursive: true, mode: 0o700 });
  return withPrivateFileLock(resolve(state, "service-login"), action);
}
