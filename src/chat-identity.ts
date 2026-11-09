import { BoundedIdSet } from "./bounded-id-set.js";
import { classifyThread, maxParentDepth, parentOf, type ChatKind, type ClassifyContext, type ClassifyRule, type ClassifyThread } from "./gateway-chat-classifier.js";
import { GatewayChatRegistry, type GatewayChatOrigin } from "./gateway-chat-registry.js";
import { telemetry } from "./telemetry.js";

export type { ChatKind };
/** The engine a request is meant for. The router decides it; a provider id in the request never does. */
export interface EngineHint { engine: ChatKind }
/** The provider id new gateway chats are written with (1.8.0); `chatIdentity: "openai"` (0.4.7) opts a Mac into the native identity. */
export const gatewayProvider = "gatefox";
/** The provider id gateway chats were written with before 1.8.0. Still registered and read, so every saved chat keeps working. */
export const legacyGatewayProvider = "subscription_gateway";
/** Both of the gateway's own provider ids. */
export const gatewayOwnProviders: readonly string[] = [gatewayProvider, legacyGatewayProvider];
/** Whether a provider id is the gateway's own: `gatefox`, or `subscription_gateway` on a chat saved before 1.8.0. */
export const isGatewayProvider = (id: unknown): boolean => id === gatewayProvider || id === legacyGatewayProvider;
/** The catalogs a classification reads, as thunks: a chat that the provider or the registry answers never builds them. */
export interface IdentityCatalogs { aliases: () => ReadonlySet<string>; nativeSlugs: () => ReadonlySet<string> }

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");
/** How many chats' metadata stays in memory for the sub-agent parent rule, and how many classified chats are remembered. */
const maxThreads = 4096;
/** A thread/list page contributes at most this many chats, so one large page cannot push out the rest. */
const maxListed = 256;
/** `gateway_chat_classified` names a method from this fixed list; anything else is `other`. */
const reportedMethods = new Set(["thread/start", "thread/resume", "thread/fork", "thread/read", "turn/start", "turn/steer", "turn/interrupt",
  "thread/settings/update", "turn/settings/update", "thread/settings/updated", "thread/unsubscribe", "compaction"]);
export const noSlugs: ReadonlySet<string> = new Set();

/**
 * The metadata a classification may read from a thread object: id, provider, model and where it came from. A reply's
 * own `model` and `modelProvider` describe the chat as loaded, so they win over the thread's saved ones. Never content.
 */
export function threadFacts(thread: unknown, reply: ObjectValue = {}): ClassifyThread | undefined {
  const value = object(thread);
  if (!text(value.id)) return undefined;
  const provider = text(reply.modelProvider) ? reply.modelProvider : value.modelProvider;
  const model = text(reply.model) ? reply.model : value.model;
  return { id: value.id, ...(text(provider) ? { modelProvider: provider } : {}), ...(text(model) ? { model } : {}),
    ...(value.source && typeof value.source === "object" ? { source: value.source } : {}),
    ...(text(value.parentThreadId) ? { parentThreadId: value.parentThreadId } : {}) };
}

/** Whether a thread records a parent: the classifier's own parent reading, asked with a registry that holds every id. */
export function hasParent(thread: unknown): boolean {
  const value = object(thread);
  const rule = classifyThread({ source: value.source, parentThreadId: typeof value.parentThreadId === "string" ? value.parentThreadId : undefined },
    { aliases: noSlugs, nativeSlugs: noSlugs, registry: { has: () => true }, readParent: () => undefined }).rule;
  return rule === "parent";
}

/**
 * One connection's view of which chats are the gateway's. It reads the registry once per request (`refresh`), then answers
 * synchronously from memory, with the parent rule fed by the threads this connection saw in replies and notifications.
 * It never reads a file per hop. `gateway_chat_classified` carries only the rule and a method from a fixed list, once
 * per chat per connection.
 */
export class ChatIdentity {
  readonly registry: GatewayChatRegistry;
  private readonly threads = new Map<string, ClassifyThread>();
  private readonly reported = new BoundedIdSet(maxThreads);
  private readonly recording = new Map<string, Promise<void>>();
  private writeFailed = false;
  constructor(stateDirectory: string, nativeHome: string) {
    this.registry = new GatewayChatRegistry(stateDirectory, nativeHome, () => telemetry("gateway_registry_unreadable", {}));
  }
  /** Keeps what a reply or notification said about a chat. Later facts add to earlier ones. */
  learn(facts: ClassifyThread | undefined): void {
    if (!facts?.id) return;
    const known = this.threads.get(facts.id);
    this.threads.delete(facts.id); this.threads.set(facts.id, { ...known, ...facts });
    while (this.threads.size > maxThreads) this.threads.delete(this.threads.keys().next().value as string);
  }
  /** The chats a reply describes: its `thread`, and a thread/list page. */
  learnReply(method: string, result: ObjectValue): void {
    this.learn(threadFacts(result.thread, result));
    if (method === "thread/list" && Array.isArray(result.data)) for (const item of result.data.slice(0, maxListed)) this.learn(threadFacts(item));
  }
  readonly readParent = (id: string): ClassifyThread | undefined => this.threads.get(id);
  /**
   * Reads the ancestors of a chat that this connection has not seen and the registry does not hold, so the parent rule can
   * answer for a sub-agent whose chain was spawned while no desktop was connected, or whose registry entries were lost. It
   * follows the chain as far as the classifier does (8 levels), stops at a registered or legacy ancestor, a repeat, or one
   * it cannot read, and reads each chat at most once per connection. `read` returns a chat's saved thread (metadata only).
   * A chat that its own provider id, registry entry or gateway alias already makes a gateway chat needs no ancestor, so
   * nothing is read for it. Call it after `refresh`, so the registry answers from the file's current state.
   */
  async learnAncestors(thread: ClassifyThread, catalogs: IdentityCatalogs, read: (id: string) => Promise<unknown>): Promise<void> {
    if (isGatewayProvider(thread.modelProvider) || (text(thread.id) && this.registry.hasCached(thread.id))) return;
    if (text(thread.model) && catalogs.aliases().has(thread.model) && !catalogs.nativeSlugs().has(thread.model)) return;
    const seen = new Set<string>(text(thread.id) ? [thread.id] : []);
    let parent = parentOf(thread);
    for (let depth = 0; parent !== undefined && depth < maxParentDepth && !seen.has(parent); depth++) {
      seen.add(parent);
      if (this.registry.hasCached(parent)) return;
      let facts = this.threads.get(parent);
      if (!facts) {
        facts = threadFacts(await read(parent).catch(() => undefined));
        if (facts?.id !== parent) return;
        this.learn(facts);
      }
      if (isGatewayProvider(facts.modelProvider)) return;
      parent = parentOf(facts);
    }
  }
  /** Brings the registry up to date; an unreadable one counts as empty and is reported by the registry itself. */
  async refresh(): Promise<void> { await this.registry.refresh().catch(() => undefined); }
  /** Synchronous after `refresh`: the registry answers from memory and parents come from what this connection saw. */
  classify(thread: ClassifyThread, catalogs: IdentityCatalogs, method: string): { kind: ChatKind; rule: ClassifyRule } {
    let aliases: ReadonlySet<string> | undefined; let nativeSlugs: ReadonlySet<string> | undefined;
    const context: ClassifyContext = {
      get aliases() { return aliases ??= catalogs.aliases(); },
      get nativeSlugs() { return nativeSlugs ??= catalogs.nativeSlugs(); },
      registry: { has: id => this.registry.hasCached(id) }, readParent: this.readParent,
    };
    const result = classifyThread(thread, context);
    if (text(thread.id) && !this.reported.has(thread.id)) {
      this.reported.add(thread.id);
      telemetry("gateway_chat_classified", { rule: result.rule, method: reportedMethods.has(method) ? method : "other" });
    }
    return result;
  }
  /**
   * Records a gateway chat and resolves once it is on disk, so the caller can forward the reply or notification after it.
   * A chat already recorded costs no write. A failed write is reported once and never fails the chat: a legacy chat is still
   * recognized by its provider, an `openai` chat on a gateway alias by its alias, and an `openai` sub-agent on a native model
   * only through its ancestors, which `learnAncestors` reads (see docs/harness-identity.md).
   */
  async record(id: string, origin: GatewayChatOrigin): Promise<void> {
    const pending = this.recording.get(id);
    if (pending) return pending;
    const write = (async () => {
      if (this.registry.hasCached(id)) return;
      await this.refresh();
      if (!this.registry.hasCached(id)) await this.registry.record(id, origin);
    })().catch(() => {
      if (!this.writeFailed) { this.writeFailed = true; telemetry("gateway_registry_write_failed", {}); }
    }).finally(() => this.recording.delete(id));
    this.recording.set(id, write);
    return write;
  }
}
