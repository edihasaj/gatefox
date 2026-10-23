import type { GatewayConfig } from "../config.js";
import { discoverableKinds } from "./discovery.js";
import { pickerEntries, visibleFamilies, visibleModels } from "./planner.js";
import { readState, emptyStatus } from "./state.js";
import { rawAutoLatest } from "./settings.js";
import { autoLatestIntervalMinutes, type AutoLatestStatus } from "./types.js";

/**
 * The public, safe view of the setting: family names, labels and the last check. No model IDs, paths or errors. While the
 * setting is on, the families are the ones being watched. While it is off they are the ones turning it on would follow
 * (the recognizable families of the routes selected right now), so the screen can say so before the user decides.
 */
/** Read-only observation of the background job: one bounded launchctl query, nothing created or started. */
export type ScheduleObserver = (configPath: string) => Promise<{ scheduled: boolean; reason?: string }>;
const observeTimeoutMs = 4000;
const defaultObserver: ScheduleObserver = async configPath => (await import("./schedule.js")).getAutoLatestScheduleStatus(configPath);

/** What the job looks like right now, only while the setting is on. A failed or slow observation reports no claim at all. */
async function observedSchedule(configPath: string, observe: ScheduleObserver): Promise<Pick<AutoLatestStatus, "scheduled" | "scheduleReason">> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([observe(configPath), new Promise<undefined>(done => { timer = setTimeout(() => done(undefined), observeTimeoutMs); timer.unref?.(); })]);
    if (!result || typeof result.scheduled !== "boolean") return {};
    const reason = typeof result.reason === "string" && /^[a-z][a-z_]{0,40}$/.test(result.reason) ? result.reason : undefined;
    return { scheduled: result.scheduled, ...(reason ? { scheduleReason: reason } : {}) };
  } catch { return {}; } finally { if (timer) clearTimeout(timer); }
}

export async function autoLatestStatus(configPath: string, snapshot: { raw: Record<string, unknown>; config: GatewayConfig }, observe: ScheduleObserver = defaultObserver): Promise<AutoLatestStatus> {
  const settings = rawAutoLatest(snapshot.raw);
  const state = await readState(configPath);
  const enabled = settings?.enabled === true;
  const schedule = enabled ? await observedSchedule(configPath, observe) : {};
  const watched = (providerId: string, provider: GatewayConfig["providers"][number]): string[] =>
    enabled ? settings?.providers[providerId]?.families ?? [] : discoverableKinds.has(provider.type) ? visibleFamilies(visibleModels(provider)) : [];
  const picker = Array.isArray(snapshot.raw.nativeModelPicker) ? (snapshot.raw.nativeModelPicker as unknown[]).filter((item): item is string => typeof item === "string") : [];
  return { ...emptyStatus, enabled, intervalMinutes: autoLatestIntervalMinutes,
    families: snapshot.config.providers.flatMap(provider => { const families = watched(provider.id, provider); return families.length ? [{ providerId: provider.id, label: provider.label || provider.id, families: [...families] }] : []; }),
    nativeFamilies: enabled ? [...(settings?.native?.families ?? [])] : visibleFamilies(pickerEntries(picker, undefined)), ...state, ...schedule };
}
