import type { MeasuredUsage } from "./compaction-rollout.js";

/**
 * Which tokenizer counts a model's context. Codex decides compaction with the counters of the model that last ran,
 * so a chat measured by one tokenizer can be far larger when another one counts it.
 */
export function tokenFamily(model: string): string {
  const upstream = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  if (upstream.startsWith("claude-")) return "anthropic";
  if (/^(?:gpt-|o\d|codex-|chatgpt-)/.test(upstream)) return "openai";
  return /^[a-z0-9]+/.exec(upstream)?.[0] ?? "unknown";
}

/**
 * How much larger the same history can count after a switch. Measured on 30 Oct 2026: a chat that GPT-6.1-Terra counted
 * at 591,583 tokens exceeded Claude Sonnet 5.5's 1,000,000-token window. Claude counts the same text as more tokens than
 * the other families, so a switch away from Claude needs no allowance. Other cross-family switches keep a small margin.
 */
export function switchFactor(source: string, target: string): number | undefined {
  if (source === target || source === "anthropic") return;
  return target === "anthropic" ? 1.7 : 1.25;
}
export const largestSwitchFactor = 1.7;

export interface SwitchOverflow { sourceModel: string; targetModel: string; sourceFamily: string; targetFamily: string; measuredTokens: number; estimatedTokens: number; limitTokens: number }

/** A switch whose last measurement, recounted for the selected model, would not fit that model's usable window. */
export function switchOverflow(measured: MeasuredUsage, targetModel: string, limitTokens: number): SwitchOverflow | undefined {
  const sourceFamily = tokenFamily(measured.model); const targetFamily = tokenFamily(targetModel);
  const factor = switchFactor(sourceFamily, targetFamily);
  if (factor === undefined || !Number.isSafeInteger(limitTokens) || limitTokens <= 0) return;
  const estimatedTokens = Math.ceil(measured.lastTokens * factor);
  if (estimatedTokens < limitTokens) return;
  return { sourceModel: measured.model, targetModel, sourceFamily, targetFamily, measuredTokens: measured.lastTokens, estimatedTokens, limitTokens };
}

const thousands = (value: number) => `${Math.round(value / 1000)}K`;

/** What the person can do: the selected model would refuse this history, and only the model that measured it can compact it. */
export function switchOverflowMessage(overflow: SwitchOverflow): string {
  return `This chat is about ${thousands(overflow.measuredTokens)} tokens as ${overflow.sourceModel} counted it, which is likely more than ` +
    `${overflow.targetModel} can read: it counts the same history as about ${thousands(overflow.estimatedTokens)} tokens. ` +
    `Switch back to ${overflow.sourceModel}, run /compact, then switch to ${overflow.targetModel} again. Your chat is preserved and nothing was sent.`;
}
