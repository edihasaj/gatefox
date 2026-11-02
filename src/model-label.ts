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

/** `modelLabel` for an optional, possibly non-string metadata value. */
export function metadataLabel(value: unknown): string | undefined {
  return typeof value === "string" && value ? modelLabel(value) : undefined;
}
