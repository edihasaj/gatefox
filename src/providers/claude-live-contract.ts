import { createHash } from "node:crypto";
import type { ChatToolSelection, InferenceEvent, OpenAITool, ResponsesRequest } from "../protocol/types.js";
import type { ClaudeLimit } from "./claude-usage.js";
import type { ClaudeMessageStream } from "./claude-stream.js";
import type { ClaudeMcpTool } from "./claude-control.js";
import type { ClaudeConversation, ClaudeImages, ContentBlock } from "./claude-render.js";

/**
 * The live session key for one provider scope and Codex thread. Its first 8 hex are the
 * log-safe thread identifier telemetry reports as `threadKey`; nothing else about a thread is.
 */
export const sessionKey = (scope: string, threadId: string) => createHash("sha256").update(`${scope}\0${threadId}`).digest("hex");

/** Why a request used the one-shot path instead of a live session. Fixed values only. */
export type ClaudeMissReason = "unavailable" | "no_thread" | "request_kind" | "concurrent" | "capacity" | "spawn_failed" | "initialize_timeout" |
  "fingerprint_changed" | "window_changed" | "prefix_diverged" | "unexpected_tail" | "forced_choice" | "effort_midturn" | "session_dead" | "interrupted_tool" | "evicted" | "stream_failed";

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
  /** sha256 hex of spawn.systemPrompt, which carries the caller's leading system and developer content. */
  instructionsDigest: string;
  /** Translated messages (instructions first) that moved into the system prompt; the ledger skips them. */
  leading: number;
  /** sha256 hex of JSON.stringify(spawn.mcpCatalog). */
  toolsDigest: string;
  /** The full caller catalog (empty for tool_choice "none"). */
  tools: OpenAITool[];
  choice?: ChatToolSelection;
  /** The restored Responses request. */
  request: ResponsesRequest;
  /** After claudeToolHistory and markCustomCalls, without the leading messages, then imageConversation. */
  conversation: ClaudeConversation;
  images: ClaudeImages;
  spawn: {
    /** CLI flags for a live process whose MCP config is at `mcpPath` and system prompt file at `systemPath`. */
    args(mcpPath: string, systemPath: string): string[];
    env: NodeJS.ProcessEnv;
    /** The tools.json content for the gateway MCP server. */
    mcpCatalog: ClaudeMcpTool[];
    /** The system prompt file content. */
    systemPrompt: string;
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
