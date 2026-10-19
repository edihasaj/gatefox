import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A private folder whose path is short enough to hold a Unix socket (macOS allows 104 bytes, and its own temp folder takes 48
 * of them), inside the folder `npm test` gave the suite so that nothing outlives the run. Outside the runner it is under /tmp.
 */
export async function shortFolder(prefix: string): Promise<{ directory: string; remove: () => Promise<void> }> {
  const base = process.env.GATEWAY_TEST_TMPDIR ?? (process.platform === "win32" ? tmpdir() : "/tmp");
  const directory = await mkdtemp(join(base, prefix));
  return { directory, remove: () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}
