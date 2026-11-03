import { CompactionRecoveryError } from "./compaction-recovery.js";
import { telemetry } from "./telemetry.js";

type ObjectValue = Record<string, unknown>;
/** Why a picker model change stayed with the next turn. Reasons only; no model names, settings or content. */
export type DeferReason = "context" | "review_group" | "not_applied" | "error";

/**
 * The SDK maps its active-step safety rejection (`check_legacy_model_safety`: node_repl, review, guardian or
 * cyber settings differ) to JSON-RPC -32600. The adapter keeps no copy of those groups; the SDK decides.
 */
export const deferReason = (error: unknown): DeferReason => {
  if (error instanceof CompactionRecoveryError && error.reason === "switch") return "context";
  if ((error as { code?: unknown } | undefined)?.code === -32600) return "review_group";
  return "error";
};

/**
 * Offers a picker model change, already applied to the chat for the next turn, to the running turn as well.
 * `send` is the router's own `turn/settings/update`, so the tokenizer recount and the SDK's safety check both
 * run. Any refusal leaves the running turn on its model and is never reported to the client: the thread
 * update the client asked for has already succeeded.
 */
export async function promoteModelSwitch(send: (params: ObjectValue) => Promise<ObjectValue>, threadId: string, turnId: string, model: string): Promise<"promoted" | DeferReason> {
  let outcome: "promoted" | DeferReason;
  try { outcome = (await send({ threadId, turnId, model })).status === "applied" ? "promoted" : "not_applied"; }
  catch (error) { outcome = deferReason(error); }
  if (outcome === "promoted") telemetry("model_switch_promoted", {});
  else telemetry("model_switch_deferred", { reason: outcome });
  return outcome;
}
