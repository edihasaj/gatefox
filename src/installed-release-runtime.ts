import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRegularFile } from "./service-claude-io.js";
import { releaseState } from "./self-update.js";
import { retainRunningRelease, type ReleaseLease } from "./release-retention.js";
import type { GatewaySdkRuntime } from "./gateway-sdk-runtime.js";

/**
 * The gateway SDK of the installed (newer) release, verified by that release's own `gateway-sdk-runtime.js`. A running host
 * cannot verify a newer SDK with its own pins: a release changes its SDK exactly when those pins change. So it imports the
 * installed release's verifier the way the live supervisor loader imports its controller (service-supervisor-runtime.ts):
 * only a regular, owned module inside the very release `current` names, held by a retention lease so the installer never
 * prunes code a running engine came from. The verifier then hashes and checks that release's SDK as its own service would.
 */
export interface InstalledReleaseRuntime { release: string; runtime: GatewaySdkRuntime; lease: ReleaseLease }
type RuntimeModule = { gatewaySdkRuntime?: (packageDirectory?: string) => Promise<GatewaySdkRuntime | undefined> };

/**
 * The compiled modules and data that turn a descriptor into an engine's settings and configuration file. The forwarded engine
 * is prepared by this older host's copies, so forwarding requires the installed release's copies to be byte-identical: a
 * release that changes the feature schema or its normalization keeps the release skew refusal instead of running its SDK
 * with settings trimmed to another schema.
 */
export const preparationFiles = ["gateway-feature-schema-data.json", "gateway-feature-schema.js", "gateway-feature-fields.js",
  "gateway-feature-toml.js", "codex-feature-compat.js", "gateway-engine-home.js", "executor-identity.js"] as const;

async function samePreparation(runningDist: string, installedDist: string): Promise<boolean> {
  for (const name of preparationFiles) {
    const [mine, theirs] = await Promise.all([readRegularFile(resolve(runningDist, name), 1024 * 1024, false), readRegularFile(resolve(installedDist, name), 1024 * 1024, false)]);
    if (!mine || !theirs || !mine.bytes.equals(theirs.bytes)) return false;
  }
  return true;
}

export async function installedReleaseRuntime(release: string, moduleUrl = import.meta.url): Promise<InstalledReleaseRuntime | undefined> {
  try {
    if (releaseState(moduleUrl)?.installed !== release) return;
    const releases = realpathSync(resolve(dirname(fileURLToPath(moduleUrl)), "../../.."));
    const file = realpathSync(resolve(releases, "../current/package/dist/gateway-sdk-runtime.js"));
    if (file !== resolve(releases, release, "package/dist/gateway-sdk-runtime.js")) return;
    if (!await readRegularFile(file, 256 * 1024, false)) return;
    if (!await samePreparation(realpathSync(dirname(fileURLToPath(moduleUrl))), dirname(file))) return;
    const lease = retainRunningRelease(pathToFileURL(file).href);
    if (lease.releaseName !== release) { lease.release(); return; }
    try {
      const candidate = await import(pathToFileURL(file).href) as RuntimeModule;
      const runtime = typeof candidate.gatewaySdkRuntime === "function" ? await candidate.gatewaySdkRuntime(resolve(releases, release, "package")) : undefined;
      if (!runtime) { lease.release(); return; }
      return { release, runtime, lease };
    } catch { lease.release(); return; }
  } catch { return; }
}
