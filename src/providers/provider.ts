import type { ResponsesRequest, InferenceEvent } from "../protocol/types.js";
import type { ProviderNetworkCode, ProviderNetworkStage } from "../provider-network.js";
export interface ProviderStreamDiagnostic { events: number; lastEvent?: string; reasoningItems: number; textDeltas: number; toolCalls: number }
export type ProviderUpstreamReason = "login_unavailable" | "session_expired" | "credential_revoked" | "upstream_rejected" | "reasoning_extraction" | "unknown";
export class ProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502,
    readonly upstream?: { code?: string; event?: string; requestId?: string; retryAfterMs?: number; subtype?: string; httpStatus?: number; stream?: ProviderStreamDiagnostic;
      /** Fixed provider-specific classification; never provider diagnostic text. */
      reason?: ProviderUpstreamReason;
      /** Fixed raw transport boundary; raw exception text and topology never cross it. */
      stage?: ProviderNetworkStage;
      /** Internal retry admission for a known transient network class only. */
      retryableNetwork?: true;
      /** The allowlisted transient codes one connection attempt held, when no single one names the outage. */
      networkCodes?: ProviderNetworkCode[];
      /** Token counts an upstream context overflow reported (numbers only); a Messages client uses them to size its compaction. */
      contextTokens?: { used: number; maximum: number } }) { super(message); }
}
export type InferenceRequestKind = "turn" | "compaction" | "prewarm" | "memory";
/** Internal count-only observation; never serialized into provider requests or client metadata. */
export interface ProviderCacheUsage { inputTokens?: number; inputTokensLowerBound?: number; cachedTokens?: number; cacheWriteTokens?: number }
/** Caller routing identifiers and the gateway-selected ingress protocol; never request content. */
export interface InferenceContext {
  /** The Gateway SDK advertises its corrected active-context compaction accounting. */
  cacheRecovery?: true;
  observeCacheUsage?: (usage: ProviderCacheUsage) => void;
  sessionId?: string; threadId?: string; turnId?: string; windowId?: string; requestKind?: InferenceRequestKind;
  clientProtocol?: "responses" | "messages"; adaptiveThinking?: boolean;
  /** Opaque sticky-routing token that Codex echoes for the rest of a turn. */
  turnState?: string;
}
export interface Provider {
  /** The provider may yield a `transport` event before any content; the server turns it into response headers. */
  readonly emitsTransport?: boolean;
  infer(request: ResponsesRequest, signal: AbortSignal, context?: InferenceContext): AsyncIterable<InferenceEvent>;
}

/** Existing thread identities stay stable; session-only clients occupy a separate key space. */
export function providerConversationId(context: InferenceContext): string | undefined {
  return context.threadId ?? (context.sessionId ? JSON.stringify(["session", context.sessionId]) : undefined);
}

/** Longest accepted x-codex-turn-state; a wrapped upstream value must fit within it. */
export const maxTurnStateLength = 8192;
type Headers = Record<string, string | string[] | undefined>;
const requestKinds = new Set<unknown>(["turn", "compaction", "prewarm", "memory"]);
const routingId = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
const windowId = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : undefined;
const turnState = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= maxTurnStateLength && /^[\x21-\x7e]+$/.test(value) ? value : undefined;

/** Reads only turn_id and request_kind from Codex's turn metadata JSON. */
function turnMetadata(value: unknown, limit: number): { turnId?: string; requestKind?: InferenceRequestKind } {
  if (typeof value !== "string" || Buffer.byteLength(value) > limit) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const { turn_id: turn, request_kind: kind } = parsed as Record<string, unknown>;
    const turnId = routingId(turn); const requestKind = requestKinds.has(kind) ? kind as InferenceRequestKind : undefined;
    return { ...(turnId ? { turnId } : {}), ...(requestKind ? { requestKind } : {}) };
  } catch { return {}; }
}

const metadataKeys = ["session_id", "thread_id", "turn_id", "x-codex-window-id", "x-codex-turn-metadata"] as const;
function clientMetadata(body: unknown): Partial<Record<typeof metadataKeys[number], unknown>> {
  try {
    const metadata = body && typeof body === "object" ? (body as { client_metadata?: unknown }).client_metadata : undefined;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
    return Object.fromEntries(metadataKeys.map(key => [key, (metadata as Record<string, unknown>)[key]]));
  } catch { return {}; }
}

/**
 * Reads Codex's routing headers, falling back field by field to the request body's
 * client_metadata. Malformed or repeated values are ignored; it never throws or logs.
 * The body copy of the turn metadata also carries Codex's tool inventory, so it gets a larger bound.
 */
export function inferenceContext(headers: Headers, body?: unknown): InferenceContext {
  try {
    const metadata = clientMetadata(body);
    const header = turnMetadata(headers["x-codex-turn-metadata"], 16 * 1024);
    const fromBody = header.turnId && header.requestKind ? {} : turnMetadata(metadata["x-codex-turn-metadata"], 1024 * 1024);
    const context: InferenceContext = {
      ...(headers["x-harness-cache-recovery"] === "1" ? { cacheRecovery: true as const } : {}),
      sessionId: routingId(headers["session-id"]) ?? routingId(headers["session_id"]) ?? routingId(headers["x-opencode-session"]) ?? routingId(metadata.session_id),
      threadId: routingId(headers["thread-id"]) ?? routingId(headers["thread_id"]) ?? routingId(metadata.thread_id),
      turnId: header.turnId ?? routingId(metadata.turn_id) ?? fromBody.turnId,
      windowId: windowId(headers["x-codex-window-id"]) ?? windowId(metadata["x-codex-window-id"]),
      requestKind: header.requestKind ?? fromBody.requestKind,
      turnState: turnState(headers["x-codex-turn-state"]),
    };
    return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)) as InferenceContext;
  } catch { return {}; }
}
