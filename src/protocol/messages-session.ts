import { createHash } from "node:crypto";
import type { InferenceRequestKind } from "../providers/provider.js";

type Headers = Record<string, string | string[] | undefined>;
const header = (headers: Headers, name: string): string | undefined => {
  const value = headers[name];
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
};

/** A subagent's own identity, present only on requests from an agent Claude Code spawned. */
export function messagesAgentId(headers: Headers): string | undefined { return header(headers, "x-claude-code-agent-id"); }

/** Claude Code's hint headers say which requests are not ordinary turns; a client without them keeps today's behavior. */
export function messagesRequestKind(headers: Headers): InferenceRequestKind | undefined {
  const requestClass = header(headers, "x-claude-code-request-class");
  if (requestClass === "compaction" || header(headers, "x-claude-code-compaction")) return "compaction";
  return requestClass === "auxiliary" ? "auxiliary" : undefined;
}

/**
 * Claude Code's structured user_id includes a conversation UUID, not just a user identity.
 * A subagent reuses its parent's UUID with a different history, so it gets its own conversation.
 */
export function messagesSessionId(metadata: unknown, agentId?: string): string | undefined {
  try {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
    const user = (metadata as { user_id?: unknown }).user_id;
    if (typeof user !== "string" || user.length > 4096 || !user.startsWith("{")) return;
    const value = JSON.parse(user) as { device_id?: unknown; account_uuid?: unknown; session_id?: unknown } | null;
    if (!value || Array.isArray(value) || typeof value.device_id !== "string" || value.device_id.length > 256
      || typeof value.account_uuid !== "string" || value.account_uuid.length > 128 || typeof value.session_id !== "string") return;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.session_id)) {
      return agentId ? `${value.session_id}:agent-${createHash("sha256").update(agentId).digest("hex").slice(0, 16)}` : value.session_id;
    }
  } catch { /* Arbitrary user metadata is not a conversation identity. */ }
}
