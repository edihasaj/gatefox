/**
 * Release-time metadata and picker visibility for models, shared by discovery, the catalog and the model lists.
 *
 * `releasedAt` is UTC seconds from an explicit vendor field only. The time the gateway first saw a model is never a
 * release date and is never read here. Nothing in this file logs or returns raw vendor metadata.
 */

/** Earliest and latest accepted release instants, UTC seconds: 2010-01-01T00:00:00Z and 2100-01-01T00:00:00Z (exclusive). */
export const minimumReleasedAt = Date.UTC(2010, 0, 1) / 1000;
export const maximumReleasedAt = Date.UTC(2100, 0, 1) / 1000;

/** Vendor fields that state a release date, strongest first. */
const explicitFields = ["released_at", "releasedAt", "release_date", "releaseDate", "released"] as const;
/**
 * Creation times (`created`, `created_at`) are deliberately not read: OpenAI documents `created` as the model's creation
 * time, not its release, so presenting it as a release date would be wrong.
 */

const inRange = (seconds: number): number | undefined =>
  Number.isFinite(seconds) && seconds >= minimumReleasedAt && seconds < maximumReleasedAt ? Math.floor(seconds) : undefined;

/** An epoch number: seconds, or milliseconds when it is too large to be a plausible seconds value. */
function epoch(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return inRange(value < 1e11 ? value : value / 1000);
}

const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/** An ISO-8601 date or date-time. A date alone, or a time without an offset, is UTC. Impossible calendar dates are refused. */
function isoSeconds(value: string): number | undefined {
  const match = iso.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map(part => part === undefined ? 0 : Number(part));
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  let offset = 0;
  const zone = match[7];
  if (zone && zone !== "Z") {
    const digits = zone.replace(":", "");
    const zoneHours = Number(digits.slice(1, 3)); const zoneMinutes = Number(digits.slice(3, 5));
    if (zoneHours > 23 || zoneMinutes > 59) return undefined;
    offset = (zone.startsWith("-") ? -1 : 1) * (zoneHours * 3600 + zoneMinutes * 60);
  }
  return inRange(date.getTime() / 1000 - offset);
}

/** Normalize one vendor time value (epoch number, digit string, or ISO text) to UTC seconds, or `undefined` when unusable. */
export function normalizeReleasedAt(value: unknown): number | undefined {
  if (typeof value === "number") return epoch(value);
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 40) return undefined;
  if (/^\d{9,15}$/.test(text)) return epoch(Number(text));
  return isoSeconds(text);
}

/**
 * `releasedAt` from a vendor model row: the first explicit release field that parses. Creation and first-seen times are never
 * used. Returns an empty object when nothing usable exists, so a caller can spread it and keep an earlier value.
 */
export function releasedAtMetadata(row: unknown): { releasedAt?: number } {
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  const fields = row as Record<string, unknown>;
  for (const name of explicitFields) {
    const seconds = normalizeReleasedAt(fields[name]);
    if (seconds !== undefined) return { releasedAt: seconds };
  }
  return {};
}

/** Whether a model's metadata hides it from the normal picker. Routing is never affected. */
export function pickerHidden(metadata: object | undefined): boolean {
  return (metadata as { pickerHidden?: unknown } | undefined)?.pickerHidden === true;
}

/** Aliases the normal picker, `/v1/models` and the shared catalog leave out; their routes stay configured. */
export function pickerHiddenAliases(config: { providers: ReadonlyArray<{ modelMetadata?: Record<string, object | undefined> }> }): Set<string> {
  const hidden = new Set<string>();
  for (const provider of config.providers) {
    for (const [alias, metadata] of Object.entries(provider.modelMetadata || {})) if (pickerHidden(metadata)) hidden.add(alias);
  }
  return hidden;
}
