import { mutateConfig, type ConfigSnapshot } from "./storage.js";
import { ManagementError, throwIfCancelled } from "./errors.js";

/** Where the local native GPT fallback models appear in the model picker. Presentation only. */
export type NativePickerPlacement = "first" | "last" | "hidden";

const placements: readonly string[] = ["first", "last", "hidden"];

export function isNativePickerPlacement(value: unknown): value is NativePickerPlacement {
  return typeof value === "string" && placements.includes(value);
}

/** The placement the local native adapter applies for this raw configuration: absent means first. A recognised value is returned as saved; anything else is an invalid configuration (readSnapshot already refuses it). */
export function effectivePlacement(raw: Record<string, unknown>): NativePickerPlacement {
  const value = raw.nativeModelPickerPlacement;
  if (value === undefined) return "first";
  if (!isNativePickerPlacement(value)) throw new ManagementError("invalid_configuration");
  return value;
}

/**
 * Saves only the presentation placement of the local native picker. It edits no provider, credential, alias or order,
 * so it is allowed on client-only configurations too: the setting belongs to this Mac's execution host.
 * Asking for the placement already in effect while the field is absent (first) or identical leaves the bytes untouched.
 */
export async function setNativePickerPlacement(
  configPath: string,
  placement: unknown,
  revision: unknown,
  signal?: AbortSignal,
): Promise<{ snapshot: ConfigSnapshot; changed: boolean }> {
  if (typeof revision !== "string" || !revision || !isNativePickerPlacement(placement)) throw new ManagementError("invalid_request");
  let changed = false;
  const snapshot = await mutateConfig(configPath, revision, current => {
    throwIfCancelled(signal);
    if (!current) throw new ManagementError("not_found");
    const stored = current.raw.nativeModelPickerPlacement;
    if (stored === placement || (stored === undefined && placement === "first")) return current.raw;
    changed = true;
    return { ...structuredClone(current.raw), nativeModelPickerPlacement: placement };
  }, signal);
  return { snapshot, changed };
}
