import { resolve } from "node:path";
import { readRolloutReasoning } from "./rollout-reasoning.js";
import { isReasoningEffort, type ThreadReasoningStore } from "./thread-reasoning.js";
import { telemetry } from "./telemetry.js";

export type ReasoningSource = "record" | "rollout" | "thread";
export interface ReasoningChoice { effort: string; summary?: string }
export interface RecoveredReasoning { effort: string; summary?: string; source: ReasoningSource }
export interface ReasoningLevels { levels: string[]; defaultLevel?: string }
/** What the engine's own chat read reported: its rollout path and current effort. */
export interface ThreadReasonSnapshot { path?: unknown; effort?: unknown }

// Weakest to strongest; used only to pick a lower level when a model lacks the saved one.
const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Keep a saved level the model offers; otherwise the closest level below it, then the model's own default. */
export function fitEffort(effort: string, levels: string[], defaultLevel?: string): { effort: string; adjusted: boolean } {
  if (levels.length === 0 || levels.includes(effort)) return { effort, adjusted: false };
  const rank = order.indexOf(effort);
  if (rank >= 0) {
    const below = levels.filter(level => order.indexOf(level) >= 0 && order.indexOf(level) <= rank);
    const selected = below.sort((a, b) => order.indexOf(a) - order.indexOf(b)).at(-1);
    if (selected) return { effort: selected, adjusted: true };
  }
  for (const fallback of [defaultLevel, "medium", levels[0]]) if (fallback && levels.includes(fallback)) return { effort: fallback, adjusted: true };
  return { effort, adjusted: false };
}

/** Recovers a chat's reasoning after a reload, from gateway state first, then the chat's own rollout. */
export class ResumeReasoning {
  constructor(private readonly store: ThreadReasoningStore, private readonly nativeHome: string) {}
  async recover(threadId: string, model: string | undefined, thread: () => Promise<ThreadReasonSnapshot>): Promise<RecoveredReasoning | undefined> {
    const saved = await this.store.read(threadId).catch(() => undefined);
    if (saved && (!model || saved.model === model)) return { effort: saved.effort, ...(saved.summary ? { summary: saved.summary } : {}), source: "record" };
    const chat = await thread().catch(() => ({}) as ThreadReasonSnapshot);
    if (typeof chat.path === "string" && chat.path) {
      const rollout = await readRolloutReasoning(chat.path, threadId, resolve(this.nativeHome));
      if (rollout && (!model || !rollout.model || rollout.model === model)) return { effort: rollout.effort, ...(rollout.summary ? { summary: rollout.summary } : {}), source: "rollout" };
    }
    if (isReasoningEffort(chat.effort)) return { effort: chat.effort, source: "thread" };
    telemetry("reasoning_unrecovered", { model });
    return;
  }
}
