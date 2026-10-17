/** Public wire contracts and the gateway's provider-neutral message format. */
export type MessageRole = "system" | "developer" | "user" | "assistant";
export type ResponseToolIdentity = { type: "function" | "custom"; name: string; namespace?: string };
export type OpenAIFunctionDef = {
  name: string;
  parameters?: Record<string, unknown>;
  description?: string;
  responseTool?: ResponseToolIdentity;
};
export type OpenAITool = { type: "function"; function: OpenAIFunctionDef };
export type OpenAIToolCall = {
  type: "function";
  id: string;
  responseTool?: ResponseToolIdentity;
  function: { arguments: string; name: string };
};
export type OpenAIChatMessage = {
  content: string | null;
  parts?: MessagePart[];
  role: MessageRole | "tool";
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
};
export type ChatToolSelection = "auto" | "none" | "required" | { type: "function"; function: { name: string } };
export type OpenAIChatRequest = {
  messages: OpenAIChatMessage[];
  model: string;
  tool_choice?: ChatToolSelection;
  tools?: OpenAITool[];
};
export type ImageDetail = "auto" | "low" | "high" | "original";
export type MessagePart = { type: "text"; text: string } | { type: "image"; mediaType: string; data: string; detail?: ImageDetail };
export type ResponsesContentPart = { text: string; type: "input_text" | "output_text" } | { type: "input_image"; image_url: string; detail?: ImageDetail };
export type ResponsesMessageItem = { role: MessageRole; content: string | ResponsesContentPart[]; type?: "message" };
export type ResponsesInputCall = {
  name: string;
  call_id: string;
  type: "function_call" | "custom_tool_call";
  namespace?: string;
  input?: string;
  arguments?: string;
};
export type ResponsesInputCallOutput = {
  output: string | ResponsesContentPart[];
  type: "function_call_output" | "custom_tool_call_output";
  call_id: string;
  namespace?: string;
  name?: string;
};
export type ResponsesReasoningItem = {
  encrypted_content?: string;
  type: "reasoning";
  summary?: { text: string; type: "summary_text" }[];
};
export type ResponsesFunctionTool = OpenAIFunctionDef & { type: "function" };
export type ResponsesCustomTool = {
  name: string;
  type: "custom";
  description?: string;
  format?: { type: "text" } | { definition: string; syntax: "lark" | "regex"; type: "grammar" };
};
export type ResponsesNamespaceTool = {
  tools: (ResponsesFunctionTool | ResponsesCustomTool)[];
  type: "namespace";
  name: string;
  description?: string;
};
/** Codex multi-agent transcript item: one agent's message to another, with optional encrypted transport state. */
export type ResponsesAgentMessageItem = {
  type: "agent_message";
  id?: string;
  author?: string;
  recipient?: string;
  content: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
};
/** Native tool search tool and items: only the Codex subscription route accepts them, and it forwards them unchanged. */
export type ResponsesToolSearchTool = { type: "tool_search"; [key: string]: unknown };
export type ResponsesToolSearchItem = { type: "tool_search_call" | "tool_search_output"; [key: string]: unknown };
export type ResponsesInputItem = ResponsesInputCall | ResponsesInputCallOutput | ResponsesReasoningItem | ResponsesMessageItem | ResponsesAgentMessageItem | ResponsesToolSearchItem;
export type ResponsesTool = ResponsesNamespaceTool | ResponsesFunctionTool | ResponsesCustomTool | ResponsesToolSearchTool | OpenAITool;
export type ResponsesRequest = {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  tool_choice?: ChatToolSelection | { type: "custom" | "function"; namespace?: string; name: string };
  tools?: ResponsesTool[];
  [option: string]: unknown;
};
/**
 * Token counts a provider reports. `cache_creation_tokens` (cache writes) is internal: Messages clients see it as
 * `cache_creation_input_tokens`, while the Responses writer leaves it out, since cache writes there stay in the local ledger.
 */
export type Usage = { total_tokens: number; input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens: number; cache_creation_tokens?: number } };
/** Billing detail the gateway records locally; never sent to clients. */
export type UsageAccounting = { cacheWriteTokens?: number; reasoningTokens?: number; nanoAiu?: number; nanoAiuStatus?: "complete" | "partial" | "unavailable";
  /** Who started the request's model calls (Copilot): `user` for a new message, `agent` for a follow-up inside a live session, `mixed` for both. */
  initiator?: "user" | "agent" | "mixed" };
export type AssistantMessagePhase = "commentary" | "partial_answer" | "final_answer";
export type PublicServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | "fast" | "ultrafast";
const publicServiceTiers = new Set<string>(["auto", "default", "flex", "scale", "priority", "fast", "ultrafast"]);
export function publicServiceTier(value: unknown): PublicServiceTier | undefined {
  return typeof value === "string" && publicServiceTiers.has(value) ? value as PublicServiceTier : undefined;
}
export type InferenceEvent =
  | { text: string; type: "text"; messageId?: string; phase?: AssistantMessagePhase }
  | { type: "message-done"; messageId?: string; phase?: AssistantMessagePhase; status?: "completed" | "incomplete" }
  | { call: OpenAIToolCall; type: "tool" }
  | { usage: Usage; type: "done"; serviceTier?: PublicServiceTier; endTurn?: boolean; interrupted?: true; accounting?: UsageAccounting; stopReason?: "max_tokens" | "stop_sequence"; stopSequence?: string }
  | { item: Record<string, unknown>; type: "reasoning-state" }
  /** An output item the client executes or reads itself (native tool search): streamed back exactly as the upstream sent it. */
  | { item: Record<string, unknown>; type: "native-item" }
  | { text: string; type: "reasoning"; summaryIndex?: number; estimatedTokens?: number; id?: string }
  /** Response-header data from the upstream; the server consumes it and never forwards it as output. */
  | { type: "transport"; turnState?: string }
  /** Running usage reported before the response ends; the server records it and never forwards it. */
  | { type: "usage"; usage: Usage; accounting?: UsageAccounting };
export type WireEvent = { type: string; [field: string]: unknown };
