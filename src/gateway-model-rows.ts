type ObjectValue = Record<string, unknown>;
type Level = { effort: string; description: string };

/**
 * The effort a gateway row advertises in `model/list` and the effort a new chat gets
 * when nothing else applies: the row's declared default if it offers it, else medium
 * if offered, else the first supported level, else none.
 */
export function rowDefaultEffort(metadata: ObjectValue): string {
  const levels = (metadata.supported_reasoning_levels as Level[]).map(level => level.effort);
  const declared = metadata.default_reasoning_level;
  return typeof declared === "string" && levels.includes(declared) ? declared : levels.includes("medium") ? "medium" : levels[0] || "none";
}

/** A gateway catalog row as the desktop's `model/list` reads it. */
export function gatewayModelRow(model: ObjectValue): ObjectValue {
  return {
    id: model.slug, model: model.slug, displayName: model.display_name, description: model.description,
    upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null, hidden: false,
    supportedReasoningEfforts: (model.supported_reasoning_levels as Level[]).map(level => ({ reasoningEffort: level.effort, description: level.description })),
    defaultReasoningEffort: rowDefaultEffort(model), inputModalities: model.input_modalities || ["text"], supportsPersonality: false,
    multiAgentVersion: null, additionalSpeedTiers: model.additional_speed_tiers || [], serviceTiers: model.service_tiers || [],
    // The desktop starts every new draft with a row's Fast default, so a gateway row never advertises one.
    defaultServiceTier: null, availableAccessPrograms: null, isDefault: false,
  };
}
