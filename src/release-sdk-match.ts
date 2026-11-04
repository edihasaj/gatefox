import { resolve } from "node:path";
import { receiptGatewaySdkSha256 } from "./self-update.js";
import { locateInstall } from "./versions.js";

const canonical = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/;

/**
 * Whether two installed releases ship the same gateway SDK, by their build receipts. A desktop adapter on an older release
 * with the installed release's SDK waits for the app's next launch instead of exiting under it (src/shim-session.ts), so
 * rollout and health count it as retained rather than lagging. Unknown is false.
 */
export async function sameGatewaySdk(running: string, installed: string, root = locateInstall().roots[0]): Promise<boolean> {
  if (!root || !canonical.test(running) || !canonical.test(installed)) return false;
  const [mine, theirs] = await Promise.all([running, installed].map(release => receiptGatewaySdkSha256(resolve(root, "releases", release, "package")).catch(() => undefined)));
  return !!mine && mine === theirs;
}
