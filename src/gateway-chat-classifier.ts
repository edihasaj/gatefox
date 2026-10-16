/** What a chat is for routing: the gateway's own, or Codex's native one. */
export type ChatKind = "gateway" | "native";
/** Which rule answered, so a caller can tell a recorded chat from an inherited one; `native` is the answer that is left. */
export type ClassifyRule = "legacy_provider" | "registry" | "parent" | "alias" | "native";
/** The chat metadata a classifier may see. Nothing here carries content. */
export interface ClassifyThread {
  id?: string;
  modelProvider?: string | null;
  model?: string | null;
  /** Codex's own thread source, as the rollout records it; a sub-agent carries its parent inside. */
  source?: unknown;
  parentThreadId?: string | null;
}
/** Everything a classification reads at once, so a caller loads its catalogs and registry once and answers in one pass. */
export interface ClassifyContext {
  /** Model aliases the gateway serves. */
  aliases: ReadonlySet<string> | readonly string[];
  /** Slugs the native catalog carries. A native slug always outranks an alias of the same name. */
  nativeSlugs: ReadonlySet<string> | readonly string[];
  /** Gateway chats this build recorded. See GatewayChatRegistry#snapshot. */
  registry: { has(id: string): boolean };
  /** Reads a chat's own metadata by id, for a parent chain. Synchronous: the caller holds what it needs. */
  readParent: (id: string) => ClassifyThread | undefined;
}

/** Providers older than the alias catalog wrote on the thread; a gateway chat even when its alias is gone. */
const legacyProvider = "subscription_gateway";
/** How far up the sub-agent chain a gateway parent is still followed. */
const maxParentDepth = 8;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** The first of these keys that holds usable text; harnesses spell the same field both ways. */
function pick(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (text(value[key])) return value[key] as string;
  return undefined;
}
/** The parent a thread records for itself: its own field first, then whichever sub-agent shape the rollout used. */
function parentOf(thread: ClassifyThread): string | undefined {
  if (text(thread.parentThreadId)) return thread.parentThreadId;
  const source = thread.source;
  if (!object(source)) return undefined;
  const hosts = [source, ...(["subAgent", "sub_agent", "subagent"] as const)
    .flatMap(key => (object(source[key]) ? [source[key] as Record<string, unknown>] : []))];
  for (const host of hosts) {
    const direct = pick(host, ["parentThreadId", "parent_thread_id"]); if (direct) return direct;
    for (const key of ["threadSpawn", "thread_spawn"]) {
      const spawn = host[key];
      if (object(spawn)) { const parent = pick(spawn, ["parentThreadId", "parent_thread_id"]); if (parent) return parent; }
    }
  }
  return undefined;
}
/** Membership for either shape of a catalog list, without copying it first. */
const member = (values: ReadonlySet<string> | readonly string[], value: string): boolean =>
  values instanceof Set ? values.has(value) : (values as readonly string[]).includes(value);
/** Whether an id is the gateway's, by its record's provider or by the registry alone. */
function recorded(id: string, ctx: ClassifyContext): boolean {
  if (ctx.registry.has(id)) return true;
  return ctx.readParent(id)?.modelProvider === legacyProvider;
}

/**
 * Says whether a chat belongs to the gateway. Fixed order: the provider older releases stamped, then the registry, then a
 * gateway ancestor down the sub-agent chain, then the model alias, with native as the answer that is left. A sub-agent of
 * a gateway chat is a gateway chat; an alias that names a native slug is a native chat.
 */
export function classifyThread(thread: ClassifyThread, ctx: ClassifyContext): { kind: ChatKind; rule: ClassifyRule } {
  if (thread.modelProvider === legacyProvider) return { kind: "gateway", rule: "legacy_provider" };
  if (text(thread.id) && ctx.registry.has(thread.id)) return { kind: "gateway", rule: "registry" };
  const seen = new Set<string>(text(thread.id) ? [thread.id as string] : []);
  for (let parent = parentOf(thread), depth = 0; parent !== undefined && depth < maxParentDepth; depth++) {
    // A repeat, or a chain longer than the limit, answers nothing: the rules below get the chat instead.
    if (seen.has(parent)) break;
    seen.add(parent);
    if (recorded(parent, ctx)) return { kind: "gateway", rule: "parent" };
    const next = ctx.readParent(parent);
    parent = next === undefined ? undefined : parentOf(next);
  }
  if (text(thread.model) && member(ctx.aliases, thread.model) && !member(ctx.nativeSlugs, thread.model)) return { kind: "gateway", rule: "alias" };
  return { kind: "native", rule: "native" };
}
