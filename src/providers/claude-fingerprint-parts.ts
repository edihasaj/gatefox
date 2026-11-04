import { createHash } from "node:crypto";

/**
 * The parts a live Claude session's fingerprint is made of, kept per session so a `fingerprint_changed` reseed can say which
 * part changed. Diagnostics only: the fingerprint itself is unchanged, and nothing here decides whether a session continues.
 * Tool names stay in memory for the comparison; telemetry receives only part names and counts.
 */
export interface FingerprintParts { model: string; thinking: boolean; fast: boolean; instructions: string; tools: Map<string, string> }
export interface FingerprintChange { changed: string; toolsAdded?: number; toolsRemoved?: number; toolsEdited?: number }

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function fingerprintParts(input: { model: string; effort?: string; fast: boolean; instructionsDigest: string; mcpCatalog: Array<{ name: string }> }): FingerprintParts {
  return { model: input.model, thinking: input.effort !== undefined, fast: input.fast, instructions: input.instructionsDigest,
    tools: new Map(input.mcpCatalog.map(tool => [tool.name, sha(JSON.stringify(tool))])) };
}

/** Which parts differ, as a fixed comma-separated vocabulary, with tool counts; `unknown` when the old parts were not kept. */
export function fingerprintChange(before: FingerprintParts | undefined, after: FingerprintParts): FingerprintChange {
  if (!before) return { changed: "unknown" };
  const changed: string[] = [];
  if (before.model !== after.model) changed.push("model");
  if (before.thinking !== after.thinking) changed.push("thinking");
  if (before.fast !== after.fast) changed.push("fast");
  if (before.instructions !== after.instructions) changed.push("instructions");
  let toolsAdded = 0, toolsRemoved = 0, toolsEdited = 0;
  for (const [name, digest] of after.tools) {
    const old = before.tools.get(name);
    if (old === undefined) toolsAdded++; else if (old !== digest) toolsEdited++;
  }
  for (const name of before.tools.keys()) if (!after.tools.has(name)) toolsRemoved++;
  if (toolsAdded || toolsRemoved || toolsEdited) changed.push("tools");
  // Every part matched: only the replay contract revision can differ, i.e. a release changed the fingerprint's meaning.
  if (!changed.length) changed.push("contract");
  return { changed: changed.join(","), ...(changed.includes("tools") ? { toolsAdded, toolsRemoved, toolsEdited } : {}) };
}
