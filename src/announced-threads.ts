import { object, type Message } from "./app-server-connection.js";
import { legacyGatewayProvider, type ChatKind } from "./chat-identity.js";

/** What an engine announced about one of its chats: kind, latest model and, for a gateway chat, its saved identity. */
interface Announced { provider?: ChatKind; model?: string; identity?: "legacy" | "openai" }

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * What the engines announce about their own chats. A chat a sub-agent or a review spawns is never routed here, so its
 * turns would log no model. This keeps only what `thread/started`, `thread/settings/updated` and `thread/closed` say.
 * Never content; ids live only in memory; and a route the router does have always wins (see `describeChat`).
 */
export class AnnouncedThreads {
  private readonly threads = new Map<string, Announced>();
  constructor(private readonly limit = 4096) {}
  /** `engine` is the kind of engine that emitted the notification; anything malformed is ignored, never thrown. */
  observe(message: Message, engine?: ChatKind): void {
    const method = typeof message.method === "string" ? message.method : ""; const params = object(message.params);
    if (method === "thread/started") {
      const thread = object(params.thread);
      if (!text(thread.id)) return;
      // An engine this connection cannot name still announced its chat's model, so keep whatever the notice has.
      // Only a gateway chat has an identity, and it follows the router's rule: the gateway's own id is `legacy`.
      const identity = engine === "gateway" && typeof thread.modelProvider === "string"
        ? { identity: thread.modelProvider === legacyGatewayProvider ? "legacy" as const : "openai" as const } : {};
      this.threads.delete(thread.id);
      this.threads.set(thread.id, { ...(engine ? { provider: engine } : {}), ...(text(thread.model) ? { model: thread.model } : {}), ...identity });
      while (this.threads.size > this.limit) this.threads.delete(this.threads.keys().next().value as string);
      return;
    }
    // Applied settings report a known chat's new model, in place: they never describe an unknown one or refresh recency.
    if (method === "thread/settings/updated" && text(params.threadId)) {
      const known = this.threads.get(params.threadId); const model = object(params.threadSettings).model;
      if (known && text(model)) this.threads.set(params.threadId, { ...known, model });
      return;
    }
    if (method === "thread/closed" && text(params.threadId)) this.threads.delete(params.threadId);
  }
  /** A copy of what this connection learned about a chat, holding only the keys it has; `{}` when nothing was announced. */
  describe(threadId: string): { provider?: string; model?: string; identity?: string } {
    const known = this.threads.get(threadId);
    return known ? { ...(known.provider ? { provider: known.provider } : {}), ...(known.model ? { model: known.model } : {}),
      ...(known.identity ? { identity: known.identity } : {}) } : {};
  }
}

/** The chat's route when the router has one, else what its engine announced. */
export function describeChat(routed: { provider?: string; model?: string; identity?: string } | undefined, announced: AnnouncedThreads, threadId: string): { provider?: string; model?: string; identity?: string } {
  return routed?.provider ? routed : announced.describe(threadId);
}
