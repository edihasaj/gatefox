import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { readOwnedJson, writeOwnedJson } from "../app-management/storage.js";
import { autoLatestOutcomes, type AutoLatestOutcome } from "./types.js";

/**
 * Last-check facts, the cross-process job lock and the schedule lock live beside the configuration, never inside it. The
 * name carries a hash of the configuration's resolved path (links followed on its folder), so two configurations in one
 * folder never share a file, and one configuration spelled two ways (/tmp or /private/tmp) always finds the same file.
 */
async function sibling(configPath: string, prefix: string): Promise<string> {
  const absolute = resolve(configPath);
  const directory = await realpath(dirname(absolute)).catch(() => dirname(absolute));
  const digest = createHash("sha256").update(resolve(directory, basename(absolute))).digest("hex").slice(0, 16);
  return resolve(directory, `${prefix}-${digest}.json`);
}
export const statePath = (configPath: string): Promise<string> => sibling(configPath, "app-auto-latest");
/** The file whose lock serializes installing and removing the background job for one configuration. */
export const schedulePath = (configPath: string): Promise<string> => sibling(configPath, "app-auto-latest-schedule");
/** The per-configuration heartbeat of the in-process maintenance owner (see maintenance.ts). */
export const maintenancePath = (configPath: string): Promise<string> => sibling(configPath, "app-auto-latest-maintenance");

export async function readState(configPath: string): Promise<{ lastCheckedAt?: number; lastOutcome?: AutoLatestOutcome }> {
  try {
    const value = await readOwnedJson<{ lastCheckedAt?: unknown; lastOutcome?: unknown }>(await statePath(configPath));
    const at = value?.lastCheckedAt; const outcome = value?.lastOutcome;
    return { ...(typeof at === "number" && Number.isSafeInteger(at) && at > 0 ? { lastCheckedAt: at } : {}),
      ...(typeof outcome === "string" && autoLatestOutcomes.includes(outcome) ? { lastOutcome: outcome as AutoLatestOutcome } : {}) };
  } catch { return {}; }
}

/** Best effort: a folder the gateway cannot write privately must not fail a check. */
export async function writeState(configPath: string, lastCheckedAt: number, lastOutcome: AutoLatestOutcome): Promise<void> {
  try { await writeOwnedJson(await statePath(configPath), { version: 1, lastCheckedAt, lastOutcome }); } catch { /* ignored */ }
}

export const emptyStatus = { enabled: false, intervalMinutes: 5, families: [] as Array<{ providerId: string; label: string; families: string[] }>, nativeFamilies: [] as string[] };
