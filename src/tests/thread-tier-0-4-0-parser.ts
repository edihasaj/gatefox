/**
 * The 0.4.0 build's strict tier-store parser, copied from release commit 4a8bb9e (src/thread-service-tiers.ts).
 * A file this build writes must still pass it, or a downgrade would make every gateway chat fail to read its tier.
 * Do not change it to match new behavior; it is the old build.
 */
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");
const fields = (value: Record<string, unknown>, keys: string[], optional: string[] = []) => keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const invalid = () => new Error("Private thread tier store is invalid or unsafe");
const maxThreads = 16384;

function row(value: unknown) {
  if (!object(value) || !fields(value, ["model", "serviceTier"], ["revision", "emittedAtMs", "uncertainBeforeMs"]) || !text(value.model)) throw invalid();
  const tier = value.serviceTier;
  if (tier !== null && (typeof tier !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/.test(tier) || tier === "auto")) throw invalid();
  for (const key of ["revision", "emittedAtMs", "uncertainBeforeMs"]) if (Object.hasOwn(value, key) && !integer(value[key])) throw invalid();
  return { model: value.model, serviceTier: tier === "fast" ? "priority" : tier === "default" || tier === "standard" ? null : tier };
}

/** Parses a parsed JSON store as 0.4.0 does; throws when 0.4.0 would reject the whole file. Returns the rows it would load. */
export function oldBuildAccepts(value: unknown): Record<string, { model: string; serviceTier: string | null }> {
  if (!object(value) || !fields(value, ["version", "threads"]) || value.version !== 1 || !object(value.threads)) throw invalid();
  const entries = Object.entries(value.threads);
  if (entries.length > maxThreads) throw invalid();
  const threads: Record<string, { model: string; serviceTier: string | null }> = Object.create(null);
  for (const [id, row_] of entries) { if (!text(id)) throw invalid(); threads[id] = row(row_); }
  return threads;
}
