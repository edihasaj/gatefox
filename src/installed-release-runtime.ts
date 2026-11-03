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
/**
 * How a forwarded generation is prepared: the installed release's own engine-home writer and spawn-argument trim, so its
 * settings are cut to that release's feature schema rather than this older host's. See `preparationFiles`.
 */
export interface ReleasePreparation {
  engineHome: (state: string, settings: Record<string, unknown>, options: { nativeHome?: string; sharedWriterLocks?: boolean; preserveConfig?: boolean }) => Promise<string>;
  trimArgs: (input: string[], settings: Record<string, unknown>) => string[];
}
export interface InstalledReleaseRuntime { release: string; runtime: GatewaySdkRuntime; lease: ReleaseLease; preparation: ReleasePreparation }
type RuntimeModule = { gatewaySdkRuntime?: (packageDirectory?: string) => Promise<GatewaySdkRuntime | undefined> };

/**
 * The compiled modules that turn a descriptor into an engine's settings and configuration file. A forwarded engine is prepared
 * by the installed release's own copies of them, imported from that release, so its settings are trimmed to the schema its
 * SDK accepts. The code must still be byte-identical to this host's, which keeps the interface this host calls unchanged; a
 * release that changes that code keeps the release skew refusal. The schema data (`schemaDataFile`) may differ: it changes
 * with every SDK update, and the imported modules read the installed release's own copy.
 */
export const preparationFiles = ["gateway-feature-schema.js", "gateway-feature-fields.js",
  "gateway-feature-toml.js", "codex-feature-compat.js", "gateway-engine-home.js", "executor-identity.js"] as const;
export const schemaDataFile = "gateway-feature-schema-data.json";
type PreparationModules = {
  engine: { gatewayEngineHome?: unknown };
  schema: { trimGatewayFeatureArgs?: unknown; trimmedGatewayFeatures?: unknown };
  compat: { normalizeCodexFeatureArgs?: unknown };
};
/** The installed release's preparation, from its own modules; undefined when any of them is missing its export. */
async function releasePreparation(installedDist: string): Promise<ReleasePreparation | undefined> {
  if (!await readRegularFile(resolve(installedDist, schemaDataFile), 4 * 1024 * 1024, false)) return;
  const load = (name: string) => import(pathToFileURL(resolve(installedDist, name)).href);
  const modules: PreparationModules = { engine: await load("gateway-engine-home.js"), schema: await load("gateway-feature-schema.js"), compat: await load("codex-feature-compat.js") };
  const { gatewayEngineHome } = modules.engine; const { trimGatewayFeatureArgs, trimmedGatewayFeatures } = modules.schema; const { normalizeCodexFeatureArgs } = modules.compat;
  if (typeof gatewayEngineHome !== "function" || typeof trimGatewayFeatureArgs !== "function" || typeof trimmedGatewayFeatures !== "function" || typeof normalizeCodexFeatureArgs !== "function") return;
  return {
    engineHome: (state, settings, options) => gatewayEngineHome(state, settings, options) as Promise<string>,
    trimArgs: (input, settings) => trimmedGatewayFeatures("spawn", (stats: unknown) => trimGatewayFeatureArgs(normalizeCodexFeatureArgs(input, settings), stats)) as string[],
  };
}

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
      const preparation = await releasePreparation(dirname(file));
      if (!preparation) { lease.release(); return; }
      return { release, runtime, lease, preparation };
    } catch { lease.release(); return; }
  } catch { return; }
}
