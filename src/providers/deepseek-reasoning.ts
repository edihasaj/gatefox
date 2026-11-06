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

/** A turn is its tool call IDs or, without calls, its answer. */
const turnIdentity = (turn: AssistantTurn): unknown => {
  const calls = turn.tool_calls?.map(call => call.id) ?? [];
  return calls.length ? calls : typeof turn.content === "string" ? turn.content : "";
};
/** The chain of assistant turns tells two identical answers in one chat apart, and survives a client editing its user messages. */
const chainKey = (conversation: string, turns: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify([conversation, turns])).digest("hex");

/**
 * DeepSeek requires `reasoning_content` back on later requests that carry tools, but clients do not return it.
 * This private, bounded, process-memory store holds it between requests. It is never logged or written to disk.
 */
export class ReasoningReplay {
  private readonly turns = new Map<string, string>();
  private bytes = 0;

  /** Without a stable conversation identity nothing is stored, because another request could match it. */
  remember(conversation: string | undefined, history: readonly AssistantTurn[], turn: AssistantTurn, reasoning: string): void {
    if (conversation === undefined) return;
    const key = chainKey(conversation, [...history.map(turnIdentity), turnIdentity(turn)]); const size = Buffer.byteLength(reasoning);
    if (size > byteLimit) return;
    this.forget(key);
    this.turns.set(key, reasoning); this.bytes += size;
    for (const oldest of this.turns.keys()) {
      if (this.turns.size <= entryLimit && this.bytes <= byteLimit) break;
      this.forget(oldest);
    }
  }

  /** Every assistant turn with its reasoning, or undefined when any is unknown, because a partial replay is still refused. */
  restore<T extends AssistantTurn & { role: string }>(conversation: string | undefined, messages: readonly T[]): Array<T & { reasoning_content?: string }> | undefined {
    const restored: Array<T & { reasoning_content?: string }> = []; const chain: unknown[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") { restored.push(message); continue; }
      if (conversation === undefined) return undefined;
      chain.push(turnIdentity(message));
      const reasoning = this.turns.get(chainKey(conversation, chain));
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
