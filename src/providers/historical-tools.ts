import type { OpenAIChatMessage } from "../protocol/types.js";

/**
 * Replayed history can name a tool the current request does not declare. Codex's local compaction sends the whole chat
 * without the chat's tools, and an MCP tool can be deferred or disconnected later in a chat. Providers that address tools
 * by position (`tool_N`) cannot represent such a call, so the call and its result stay in the history as text. A tool that
 * is still declared keeps its structured call, and a current `tool_choice` naming an absent tool is still refused.
 */
export const historicalCallText = (name: string, args: string): string => `[Earlier tool call ${name}: ${args}]`;

export const historicalResultText = (name: string, message: Pick<OpenAIChatMessage, "content" | "parts">): string => {
  const text = typeof message.content === "string" ? message.content
    : (message.parts || []).flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
  return `[Result of earlier tool call ${name}]\n${text}`;
};

/** The ids of replayed calls whose tools are absent from the request, with each call's tool name. */
export function undeclaredCalls(messages: readonly OpenAIChatMessage[], declared: (name: string) => boolean): Map<string, string> {
  const absent = new Map<string, string>();
  for (const message of messages) for (const call of message.tool_calls || []) if (!declared(call.function.name)) absent.set(call.id, call.function.name);
  return absent;
}
