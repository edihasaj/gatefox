import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { locateInstall } from "./versions.js";

/** The native relay binary of a release, hashed; undefined when it cannot be read. */
async function relayDigest(root: string, release: string): Promise<string | undefined> {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/.test(release)) return;
  try { return createHash("sha256").update(await readFile(resolve(root, "releases", release, "package/native/gateway-native-relay"))).digest("hex"); }
  catch { return; }
}

/** Whether two releases ship the same relay bytes. A release reuses the relay of an earlier one, so its label alone proves nothing. */
export async function sameRelayBinary(running: string, installed: string): Promise<boolean> {
  const root = locateInstall().roots[0]; if (!root) return false;
  const [mine, theirs] = await Promise.all([relayDigest(root, running), relayDigest(root, installed)]);
  return !!mine && mine === theirs;
}
