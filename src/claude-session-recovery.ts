import { sessionRegistry, rememberRecoveryToolNames } from "./providers/claude-session-registry.js";
import { telemetry } from "./telemetry.js";
import { randomUUID } from "node:crypto";

export const claudeRecoveryPath = "/v1/claude-sessions/recovery";
export interface ClaudeHold { threadKey: string; revision: string; since: number; reason: string; active: boolean }
const observations = new Map<string, { hold: unknown; revision: string }>();
const reasonOf = (key: string, value: unknown) => typeof value === "number" ? sessionRegistry().ended.get(key) : (value as { why?: string })?.why;
export function claudeSessionHolds(): ClaudeHold[] {
  const registry = sessionRegistry();
  for (const key of observations.keys()) if (!registry.replayUntil.has(key)) observations.delete(key);
  return [...registry.replayUntil].map(([key, value]) => {
    if (observations.get(key)?.hold !== value) observations.set(key, { hold: value, revision: randomUUID() });
    while (observations.size > 256) observations.delete(observations.keys().next().value!);
    return { threadKey: key.slice(0, 8), revision: observations.get(key)!.revision,
    since: typeof value === "number" ? value : value.since,
    reason: reasonOf(key, value) ?? "unknown", active: registry.sessions.has(key) || registry.starting.has(key) };
  });
}

/** Explicit operator action, with a compare-and-swap receipt. It never dispatches inference or caller tools. */
export function recoverClaudeSession(input: unknown): { recovered: true; threadKey: string; inferenceStarted: false } {
  const request = input as { threadKey?: unknown; revision?: unknown; since?: unknown; toolNameMode?: unknown };
  if (!request || typeof request.threadKey !== "string" || !/^[a-f0-9]{8}$/.test(request.threadKey) ||
      !Number.isSafeInteger(request.since) || !["legacy", "readable"].includes(String(request.toolNameMode))) throw new Error("Invalid recovery request");
  const registry = sessionRegistry(), matches = [...registry.replayUntil].filter(([key]) => key.startsWith(request.threadKey as string));
  if (matches.length !== 1) throw new Error("Recovery hold is missing or ambiguous; refresh status");
  const [key, hold] = matches[0], since = typeof hold === "number" ? hold : hold.since;
  if (since !== request.since || reasonOf(key, hold) !== "crashed") throw new Error("Recovery hold changed or is not a crash hold; refresh status");
  const observed = observations.get(key);
  if (typeof hold === "number" || observed?.hold !== hold || observed.revision !== request.revision) throw new Error("Recovery hold changed; refresh status");
  if (registry.sessions.has(key) || registry.starting.has(key)) throw new Error("A live or starting session was preserved");
  registry.replayUntil.delete(key); registry.ended.delete(key);
  observations.delete(key);
  rememberRecoveryToolNames(registry, key, request.toolNameMode as "legacy" | "readable");
  telemetry("claude_session_recovered", { threadKey: request.threadKey, reason: "operator", inferenceStarted: false });
  return { recovered: true, threadKey: request.threadKey, inferenceStarted: false };
}
