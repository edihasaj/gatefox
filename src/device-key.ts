import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withPrivateFileLock } from "./private-file-lock.js";

const saltName = "device-key-salt";

/** A stable, host-local pseudonym for an SSH peer. Nothing outside this process sees the address. */
export async function deviceKey(stateDirectory: string, sshConnection = process.env.SSH_CONNECTION): Promise<string | undefined> {
  const address = sshConnection?.trim().split(/\s+/, 1)[0];
  if (!address) return undefined;
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = join(stateDirectory, saltName);
  const salt = await withPrivateFileLock(path, async () => {
    try {
      const current = await readFile(path);
      if (current.length !== 32) throw new Error("Invalid device key salt");
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const created = randomBytes(32); const file = await open(path, "wx", 0o600);
      try { await file.writeFile(created); await file.sync(); }
      finally { await file.close(); }
      return created;
    }
  });
  return deviceKeyForAddress(salt, address);
}

export function deviceKeyForAddress(salt: Uint8Array, address: string): string {
  return createHash("sha256").update(salt).update(address).digest("hex").slice(0, 32);
}
