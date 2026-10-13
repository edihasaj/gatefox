import type { ChatToolSelection, InferenceEvent, OpenAITool, ResponsesRequest } from "../protocol/types.js";
import type { ClaudeLimit } from "./claude-usage.js";
import type { ClaudeMessageStream } from "./claude-stream.js";
import type { ClaudeMcpTool } from "./claude-control.js";
import type { ClaudeConversation, ClaudeImages, ContentBlock } from "./claude-render.js";

/** Why a request used the one-shot path instead of a live session. Fixed values only. */
export type ClaudeMissReason = "unavailable" | "no_thread" | "request_kind" | "concurrent" | "capacity" | "spawn_failed" | "initialize_timeout" |
  "fingerprint_changed" | "window_changed" | "prefix_diverged" | "unexpected_tail" | "effort_midturn" | "session_dead" | "interrupted_tool" | "evicted" | "stream_failed";

/** Everything a live session needs for one request; claude.ts builds it after validation. */
export interface ClaudeLiveInput {
  /** Provider identity; a session never crosses it. */
  scope: string;
  threadId: string;
  windowId?: string;
  turnId?: string;
  /** The CLI model id. */
  model: string;
  /** The mapped CLI effort; absent means thinking is off. */
  effort?: string;
  fast: boolean;
  /** False when the caller asked for no reasoning summary; reasoning is then hidden locally. */
  summaryVisible: boolean;
  /** sha256 hex of the caller instructions ("" when absent). */
  instructionsDigest: string;
  /** sha256 hex of JSON.stringify(spawn.mcpCatalog). */
  toolsDigest: string;
  /** The full caller catalog (empty for tool_choice "none"). */
  tools: OpenAITool[];
  choice?: ChatToolSelection;
  /** The restored Responses request. */
  request: ResponsesRequest;
  /** After claudeToolHistory, markCustomCalls and imageConversation. */
  conversation: ClaudeConversation;
  images: ClaudeImages;
  spawn: {
    /** CLI flags for a live process whose MCP config is at `mcpPath`. */
    args(mcpPath: string): string[];
    env: NodeJS.ProcessEnv;
    /** The tools.json content for the gateway MCP server. */
    mcpCatalog: ClaudeMcpTool[];
  };
  /** Content blocks from conversation index `from`; `render(0)` includes block 0. */
  render(from: number): ContentBlock[];
  /** A parser for one request's events. */
  newStream(): ClaudeMessageStream;
  /** Per request: persists an observed subscription limit; never rejects. */
  onUsage(limit: ClaudeLimit): Promise<void>;
  onContextWindow(model: string, contextWindow: number): void;
}

export type ClaudeLiveOutcome = { kind: "stream"; events: AsyncIterable<InferenceEvent> } | { kind: "fallback"; reason: ClaudeMissReason };

/** The shape of dist/providers/claude-live.js, which claude.ts loads lazily. */
export interface ClaudeLiveModule {
  /**
   * Called on every live request. Must return the one process-wide registry (memoized), applying
   * changed settings to it; a fresh registry per call would never reuse a session.
   */
  claudeLive(settings: { max: number; parkMinutes: number }): {
    /** A throw before the stream exists falls back to one-shot (spawn_failed), except cancellation. */
    attach(input: ClaudeLiveInput, signal: AbortSignal): Promise<ClaudeLiveOutcome>;
  };
}
