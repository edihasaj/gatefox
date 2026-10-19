/** Reads the model, tier and effort fields of a Codex app-server request, in every place the protocol carries them. */
type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
export const requestedModel = (params: ObjectValue): unknown => object(object(params.collaborationMode).settings).model ?? params.model ?? object(params.config).model;
export const tierSelection = (params: ObjectValue): { value: unknown } | undefined => Object.hasOwn(params, "serviceTier") && params.serviceTier !== undefined
  ? { value: params.serviceTier } : Object.hasOwn(object(params.config), "service_tier") ? { value: object(params.config).service_tier } : undefined;
export const tierId = (value: unknown): unknown => value === "fast" ? "priority" : value;
export const savedTier = (value: string | null): string | null => value === "default" ? null : tierId(value) as string | null;
// An effort can arrive as a turn setting or inside the collaboration mode that carries it.
export const requestedEffort = (params: ObjectValue): unknown => params.effort ?? object(object(params.collaborationMode).settings).reasoning_effort;
export const configEffort = (params: ObjectValue): unknown => object(params.config).model_reasoning_effort;
export const enumEffort = (value: unknown): string | undefined => typeof value === "string" && ["none","minimal","low","medium","high","xhigh","max","ultra"].includes(value) ? value : undefined;
