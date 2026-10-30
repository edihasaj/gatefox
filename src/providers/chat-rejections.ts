/**
 * A fixed class for an HTTP 400 from a Chat Completions server (vLLM and OpenAI-compatible routers). The gateway never logs
 * the server's message, which left every Qwen rejection as a bare "Chat API returned HTTP 400" and made each new cause slow
 * to find. This reads the bounded error envelope and keeps only a fixed reason and an allowlisted parameter name.
 */
export type ChatRejectionReason = "tool_choice_without_tools" | "context_length" | "output_tokens" | "tool_schema" | "message_format"
  | "reasoning_effort" | "model" | "unknown";

const params = new Set(["tool_choice", "tools", "messages", "max_tokens", "max_completion_tokens", "input_tokens", "reasoning_effort",
  "chat_template_kwargs", "parallel_tool_calls", "temperature", "top_p", "stop", "model", "stream_options"]);

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function chatRejection(body: unknown): { reason: ChatRejectionReason; param?: string } {
  const error = object(object(body).error);
  const message = typeof error.message === "string" ? error.message.slice(0, 4096) : "";
  const param = typeof error.param === "string" && params.has(error.param) ? error.param : undefined;
  const withParam = (reason: ChatRejectionReason) => ({ reason, ...(param ? { param } : {}) });
  if (/tool_choice/i.test(message) && /tools.*must be set|requires.*tools|without.*tools/i.test(message)) return withParam("tool_choice_without_tools");
  if (error.code === "context_length_exceeded" || /maximum context length|context window|prompt is too long/i.test(message)) return withParam("context_length");
  if (param === "max_tokens" || param === "max_completion_tokens" || /max_(?:completion_)?tokens/i.test(message)) return withParam("output_tokens");
  if (param === "reasoning_effort" || param === "chat_template_kwargs" || /reasoning/i.test(message)) return withParam("reasoning_effort");
  if (param === "tools" || /\b(?:tool|function)s?\b.*\b(?:schema|parameters|name)\b/i.test(message)) return withParam("tool_schema");
  if (param === "model" || /model .*(?:does not exist|not found)/i.test(message)) return withParam("model");
  if (param === "messages" || /\brole\b|alternate|conversation|chat template|messages/i.test(message)) return withParam("message_format");
  return withParam("unknown");
}
