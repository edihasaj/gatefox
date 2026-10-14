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
  /** A replayed hosted web-search call; only produced when the caller asks for hosted replay. */
  webSearch?: { id: string; status: string; action?: Record<string, unknown> };
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
/** A hosted web-search call Codex replays from an earlier turn. */
export type ResponsesWebSearchCallItem = { type: "web_search_call"; id: string; status: string; action?: Record<string, unknown>; [key: string]: unknown };
export type ResponsesInputItem = ResponsesInputCall | ResponsesInputCallOutput | ResponsesReasoningItem | ResponsesMessageItem | ResponsesAgentMessageItem | ResponsesWebSearchCallItem;
/** OpenAI's hosted web search tool, exactly as Codex declares it. */
export type ResponsesHostedWebSearchTool = { type: "web_search"; [key: string]: unknown };
export type ResponsesTool = ResponsesNamespaceTool | ResponsesFunctionTool | ResponsesCustomTool | OpenAITool | ResponsesHostedWebSearchTool;
export type ResponsesRequest = {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  tool_choice?: ChatToolSelection | { type: "custom" | "function"; namespace?: string; name: string };
  tools?: ResponsesTool[];
  [option: string]: unknown;
};
export type Usage = { total_tokens: number; input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens: number } };
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
  | { usage: Usage; type: "done"; serviceTier?: PublicServiceTier; endTurn?: boolean; interrupted?: true }
  | { item: Record<string, unknown>; type: "reasoning-state" }
  /** A hosted web-search call the provider ran itself. `done` false announces it; true carries the final item. */
  | { type: "hosted-item"; item: Record<string, unknown> & { type: "web_search_call"; id: string }; done: boolean }
  | { text: string; type: "reasoning"; summaryIndex?: number; estimatedTokens?: number; id?: string }
  /** Response-header data from the upstream; the server consumes it and never forwards it as output. */
  | { type: "transport"; turnState?: string };
export type WireEvent = { type: string; [field: string]: unknown };
