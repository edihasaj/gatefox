import { createHash } from "node:crypto";

const entryLimit = 4096;
const byteLimit = 64 * 1024 * 1024;

/** DeepSeek's documented replay rule applies to its own API only; other origins keep their exact request bytes. */
export function isDeepSeekApi(baseUrl: string | undefined): boolean {
  try {
    const url = new URL(baseUrl || "");
    return url.origin === "https://api.deepseek.com" && !url.username && !url.password && !url.search && !url.hash && /^\/(?:v1\/?)?$/.test(url.pathname);
  } catch { return false; }
}

interface AssistantTurn { content?: unknown; tool_calls?: ReadonlyArray<{ id: string }> }

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
/** Tool call IDs identify a turn exactly. A plain answer is identified by its text, within one conversation. */
function turnKey(conversation: string, turn: AssistantTurn): string {
  const calls = turn.tool_calls?.map(call => call.id) ?? [];
  return digest(JSON.stringify([conversation, calls.length ? calls : [typeof turn.content === "string" ? turn.content : ""]]));
}

/**
 * DeepSeek requires `reasoning_content` back on later requests that carry tools, but clients do not return it.
 * This private, bounded, process-memory store holds it between requests. It is never logged or written to disk.
 */
export class ReasoningReplay {
  private readonly turns = new Map<string, string>();
  private bytes = 0;

  remember(conversation: string, turn: AssistantTurn, reasoning: string): void {
    const key = turnKey(conversation, turn); const size = Buffer.byteLength(reasoning);
    if (size > byteLimit) return;
    this.forget(key);
    this.turns.set(key, reasoning); this.bytes += size;
    for (const oldest of this.turns.keys()) {
      if (this.turns.size <= entryLimit && this.bytes <= byteLimit) break;
      this.forget(oldest);
    }
  }

  /** Every assistant turn with its reasoning, or undefined when any is unknown, because a partial replay is still refused. */
  restore<T extends AssistantTurn & { role: string }>(conversation: string, messages: readonly T[]): Array<T & { reasoning_content?: string }> | undefined {
    const restored: Array<T & { reasoning_content?: string }> = [];
    for (const message of messages) {
      if (message.role !== "assistant") { restored.push(message); continue; }
      const reasoning = this.turns.get(turnKey(conversation, message));
      if (reasoning === undefined) return undefined;
      restored.push(reasoning ? { ...message, reasoning_content: reasoning } : message);
    }
    return restored;
  }

  private forget(key: string): void {
    const previous = this.turns.get(key);
    if (previous === undefined) return;
    this.turns.delete(key); this.bytes -= Buffer.byteLength(previous);
  }
}
