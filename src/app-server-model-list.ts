import { AppServerRoutingError } from "./app-server-routing-error.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};

/**
 * `model/list` with the native engine's models first, then the gateway rows, paged with a gateway cursor. The native
 * pages are read in full each time, so a native cursor never reaches the client. A saved gateway default is marked as
 * the default row; otherwise the native default stays.
 */
export async function gatewayModelList(params: ObjectValue, backend: (method: string, params: ObjectValue) => Promise<ObjectValue>,
  aliases: ReadonlySet<string>, extraModels: readonly ObjectValue[], preferred: unknown): Promise<ObjectValue> {
  const cursor = params.cursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || !/^gateway-models:\d+$/.test(cursor))) throw new AppServerRoutingError("Invalid gateway model cursor");
  const limit = params.limit ?? 100;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 1000) throw new AppServerRoutingError("Model list limit must be 1 through 1000");
  const native: ObjectValue[] = []; let nextCursor: unknown = null;
  do {
    if (native.length >= 4096) throw new AppServerRoutingError("Native catalog exceeds the gateway model limit");
    const page = await backend("model/list", { ...params, cursor: nextCursor, limit: 100 });
    if (!Array.isArray(page.data)) throw new AppServerRoutingError("Native engine returned an invalid model list");
    native.push(...page.data.map(object).filter(model => !aliases.has(String(model.model)))); nextCursor = page.nextCursor;
  } while (typeof nextCursor === "string" && nextCursor);
  const extra = extraModels.map(model => ({
    id: model.slug, model: model.slug, displayName: model.display_name, description: model.description,
    upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null, hidden: false,
    supportedReasoningEfforts: (model.supported_reasoning_levels as Array<{ effort: string; description: string }>).map(level => ({ reasoningEffort: level.effort, description: level.description })),
    defaultReasoningEffort: model.default_reasoning_level || "none", inputModalities: model.input_modalities || ["text"], supportsPersonality: false,
    multiAgentVersion: null, additionalSpeedTiers: model.additional_speed_tiers || [], serviceTiers: model.service_tiers || [], defaultServiceTier: model.default_service_tier ?? null, availableAccessPrograms: null, isDefault: false,
  }));
  let models: ObjectValue[] = [...native, ...extra];
  if (typeof preferred === "string" && models.some(model => model.model === preferred)) {
    models = models.map(model => ({ ...model, isDefault: model.model === preferred }));
  }
  const offset = cursor ? Number(String(cursor).split(":")[1]) : 0;
  if (!Number.isSafeInteger(offset) || offset > models.length) throw new AppServerRoutingError("Invalid gateway model cursor");
  return { data: models.slice(offset, offset + Number(limit)), nextCursor: offset + Number(limit) < models.length ? `gateway-models:${offset + Number(limit)}` : null };
}
