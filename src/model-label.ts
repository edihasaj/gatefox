/**
 * Display label for one model row.
 *
 * Upstream catalogs often repeat the vendor inside the model name, for example
 * `DeepSeek: DeepSeek V4.1 Flash 1017`. The gateway already prints the provider
 * next to the label, so the repeated vendor is dropped once. Names that do not
 * repeat their vendor, including `Z.ai: GLM 5.3`, are returned unchanged.
 */
export function modelLabel(label: string): string {
  const match = /^([^:]{1,40}):\s+(.+)$/u.exec(label);
  if (!match) return label;
  const vendor = match[1].trim();
  return vendor && match[2].toLowerCase().startsWith(vendor.toLowerCase()) ? match[2] : label;
}

/**
 * The picker row name: `<account label> · <model>`, or the model alone when it already starts with the account label as a
 * whole word ("Gemini" with "Gemini 4 Neon" is "Gemini 4 Neon", not "Gemini · Gemini 4 Neon"). "Codex 3 · GPT-6.2-Sol" keeps both.
 */
export function pickerName(account: string, model: string): string {
  const prefix = account.trim();
  const lower = model.toLowerCase();
  if (prefix && lower.startsWith(prefix.toLowerCase()) && (model.length === prefix.length || /[\s·\-:]/u.test(model[prefix.length]!))) return model;
  return `${account} · ${model}`;
}

/** The longest provider description a picker row carries; longer vendor text is dropped, never cut mid-sentence. */
export const maxModelDescription = 200;

/**
 * The provider's own one-line description of a model ("Fastest for quick answers"), as its catalog reports it, or
 * undefined when the value is missing, empty, too long or carries control characters.
 */
export function modelDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxModelDescription && !/[\u0000-\u001f\u007f]/u.test(text) ? text : undefined;
}

/** `modelLabel` for an optional, possibly non-string metadata value. */
export function metadataLabel(value: unknown): string | undefined {
  return typeof value === "string" && value ? modelLabel(value) : undefined;
}
