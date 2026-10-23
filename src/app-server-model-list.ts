import { AppServerRoutingError } from "./app-server-routing-error.js";

type ObjectValue = Record<string, unknown>;
/** The most native rows, and the most native pages, one `model/list` will read from the engine. */
const MAX_NATIVE_ROWS = 4096;
const MAX_NATIVE_PAGES = 4096;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};

/**
 * `model/list` with the native engine's models first, then the gateway rows, paged with a gateway cursor. The native
 * pages are read in full each time, so a native cursor never reaches the client. A saved gateway default is marked as
 * the default row; otherwise the native default stays.
 *
 * `nativeModelPicker` (config `nativeModelPicker`) is the user's own list of native model IDs. It narrows the native rows
 * only, by exact ID, before the rows are combined and paged; gateway rows, routing, the native catalog and the engine's
 * own list are untouched. A chosen row is returned as the engine wrote it, so a row the vendor hides stays hidden, and an
 * older ID spelled out in full (for example `gpt-5.6-terra`) stays offered and usable. A row the list leaves out is left
 * out of this response alone, never removed from the catalog: a chat already saved with it still resumes. When the caller
 * asked for hidden rows, an unchosen native row still arrives, as a copy with `hidden` set, so nothing of the engine's
 * row is rewritten.
 */
export async function gatewayModelList(params: ObjectValue, backend: (method: string, params: ObjectValue) => Promise<ObjectValue>,
  aliases: ReadonlySet<string>, extraModels: readonly ObjectValue[], preferred: unknown,
  nativeModelPicker?: readonly string[]): Promise<ObjectValue> {
  const cursor = params.cursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || !/^gateway-models:\d+$/.test(cursor))) throw new AppServerRoutingError("Invalid gateway model cursor");
  const limit = params.limit ?? 100;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 1000) throw new AppServerRoutingError("Model list limit must be 1 through 1000");
  const native: ObjectValue[] = []; let nextCursor: unknown = null; const chosen = nativeModelPicker && new Set(nativeModelPicker);
  let scanned = 0; let pages = 0; const seenCursors = new Set<string>();
  do {
    // The bounds count every row and page the engine hands over, never the rows the picker keeps: a catalog that is
    // excluded whole must stop like one that is kept whole. The row bound is checked after each read and before any
    // mapping, so an oversized final page, even one with no next cursor, cannot pass. The page bound and the repeated-cursor
    // check cover an engine that keeps answering with empty pages.
    if (++pages > MAX_NATIVE_PAGES) throw new AppServerRoutingError("Native catalog exceeds the gateway model limit");
    const page = await backend("model/list", { ...params, cursor: nextCursor, limit: 100 });
    if (!Array.isArray(page.data)) throw new AppServerRoutingError("Native engine returned an invalid model list");
    scanned += page.data.length;
    if (scanned > MAX_NATIVE_ROWS) throw new AppServerRoutingError("Native catalog exceeds the gateway model limit");
    native.push(...page.data.map(object).filter(model => !aliases.has(String(model.model))
      && (!chosen || chosen.has(String(model.model)) || params.includeHidden === true))); nextCursor = page.nextCursor;
    if (typeof nextCursor === "string" && nextCursor) {
      if (seenCursors.has(nextCursor)) throw new AppServerRoutingError("Native engine repeated a model list cursor");
      seenCursors.add(nextCursor);
    }
  } while (typeof nextCursor === "string" && nextCursor);
  // Marking, not filtering: an unchosen row survives only a request that already asked for hidden rows, and only as a copy.
  const picked = !chosen || params.includeHidden !== true ? native : native.map(model => chosen.has(String(model.model)) ? model : { ...model, hidden: true });
  const extra = extraModels.map(model => ({
    id: model.slug, model: model.slug, displayName: model.display_name, description: model.description,
    upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null, hidden: false,
    supportedReasoningEfforts: (model.supported_reasoning_levels as Array<{ effort: string; description: string }>).map(level => ({ reasoningEffort: level.effort, description: level.description })),
    defaultReasoningEffort: model.default_reasoning_level || "none", inputModalities: model.input_modalities || ["text"], supportsPersonality: false,
    multiAgentVersion: null, additionalSpeedTiers: model.additional_speed_tiers || [], serviceTiers: model.service_tiers || [], defaultServiceTier: model.default_service_tier ?? null, availableAccessPrograms: null, isDefault: false,
  }));
  let models: ObjectValue[] = [...picked, ...extra];
  if (typeof preferred === "string" && models.some(model => model.model === preferred)) {
    models = models.map(model => ({ ...model, isDefault: model.model === preferred }));
  }
  const offset = cursor ? Number(String(cursor).split(":")[1]) : 0;
  if (!Number.isSafeInteger(offset) || offset > models.length) throw new AppServerRoutingError("Invalid gateway model cursor");
  return { data: models.slice(offset, offset + Number(limit)), nextCursor: offset + Number(limit) < models.length ? `gateway-models:${offset + Number(limit)}` : null };
}
