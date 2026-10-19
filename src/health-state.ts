import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writePrivateJson } from "./config.js";
import { safePhase, type AppVersions } from "./health-types.js";

/**
 * What the watchdog remembers between runs, in `<state>/health-state.json` (0600).
 * Two things live here: the last app build seen, which is what makes an update an
 * event rather than background noise, and the last compatibility answer with the
 * pair it was earned against, which is what keeps the smoke to one run per change.
 * Nothing else is stored: no paths, no arguments, no failure text.
 */
export interface HealthState {
  version: 1;
  app?: AppVersions & { seenAt: string };
  smoke?: { result: "pass" | "fail"; phase?: string; at: string } & AppVersions;
}

export const healthStatePath = (stateDirectory: string): string => resolve(stateDirectory, "health-state.json");

const versionValue = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(value) ? value : null;

/** The recorded pair, reduced to version strings; anything malformed reads as no record. */
function recordedPair(value: unknown): AppVersions | undefined {
  if (!value || typeof value !== "object") return;
  const entry = value as Record<string, unknown>;
  if (!("bundle" in entry) && !("engine" in entry)) return;
  return { bundle: versionValue(entry.bundle), engine: versionValue(entry.engine) };
}

export async function readHealthState(stateDirectory: string, read: (path: string) => Promise<string> = path => readFile(path, "utf8")): Promise<HealthState | undefined> {
  let parsed: unknown;
  try { parsed = JSON.parse(await read(healthStatePath(stateDirectory))); } catch { return; }
  if (!parsed || typeof parsed !== "object" || (parsed as HealthState).version !== 1) return;
  const state = parsed as Partial<HealthState>;
  const app = recordedPair(state.app);
  const smoke = recordedPair(state.smoke);
  return { version: 1,
    ...(app ? { app: { ...app, seenAt: typeof state.app?.seenAt === "string" ? state.app.seenAt : "" } } : {}),
    ...(smoke && (state.smoke?.result === "pass" || state.smoke?.result === "fail")
      ? { smoke: { ...smoke, result: state.smoke.result, ...(safePhase(state.smoke.phase) ? { phase: safePhase(state.smoke.phase) as string } : {}), at: typeof state.smoke.at === "string" ? state.smoke.at : "" } } : {}) };
}

export async function writeHealthState(stateDirectory: string, state: HealthState, write: (path: string, value: unknown) => Promise<void> = writePrivateJson): Promise<void> {
  await write(healthStatePath(stateDirectory), state);
}

/** Whether the pair seen now differs from the one recorded, or nothing was recorded yet. */
export function appPairChanged(seen: HealthState["app"] | undefined, current: AppVersions): boolean {
  if (!seen) return true;
  return seen.bundle !== current.bundle || seen.engine !== current.engine;
}

/** Whether the recorded smoke answer already belongs to this exact pair. */
export function smokeCovers(seen: HealthState["smoke"] | undefined, current: AppVersions): boolean {
  if (!seen) return false;
  return seen.bundle === current.bundle && seen.engine === current.engine;
}
