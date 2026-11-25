import { createHash, randomUUID } from "node:crypto";
import type { AdmissionGate } from "./admission.js";
import type { HealthFact } from "./availability/probe.js";
import type { GatewayConfig } from "./config.js";
import type { InferenceEvent, ResponsesRequest } from "./protocol/types.js";
import { classifyNetworkFailure } from "./provider-network.js";
import { ProviderPoolPins } from "./provider-pool-pins.js";
import { networkRetryNow, networkRetrySleep, networkRetryWaitMs } from "./providers/network-retry.js";
import { ProviderError, providerConversationId, type InferenceContext, type Provider } from "./providers/provider.js";
import { telemetry } from "./telemetry.js";

export interface PoolMember { id: string; adapter: Provider; admission: AdmissionGate; limit: () => number; /** Stopped answering altogether while another member still does. */ lost?: () => boolean }
type Reason = "pinned" | "new" | "drained" | "failover";
interface Choice { member: PoolMember; reason: Reason }
export interface ProviderPoolOptions {
  now?: () => number;
  /** How often a waiting request checks whether its member drained or another one has room. */
  pollMs?: number;
  /** How long a member that refused a connection is not offered new conversations. */
  coolMs?: number;
  onSuccess?: (member: string) => void;
  onFailure?: (member: string, error: unknown) => void;
}

/**
 * The member could not serve the request at all: no connection, or the front door's 502/503 for a dead worker. Anything the
 * model server itself answered (a rejection, a quota, a refusal) is the request's own outcome and is never moved.
 */
function unreachable(error: unknown): { retryable: boolean } | undefined {
  let typed = false; try { typed = error instanceof ProviderError; } catch { return; }
  if (typed) {
    const upstream = (error as ProviderError).upstream;
    if (upstream?.event === "network") return { retryable: upstream.retryableNetwork === true };
    if (upstream?.event === "http" && (upstream.httpStatus === 502 || upstream.httpStatus === 503)) return { retryable: false };
    return;
  }
  const kind = classifyNetworkFailure(error).kind;
  return kind === "transient" || kind === "diagnostic" ? { retryable: kind === "transient" } : undefined;
}
const usable = (member: PoolMember): boolean => member.limit() > 0 && member.lost?.() !== true;
const free = (member: PoolMember): boolean => member.admission.running < member.limit() && member.admission.queued === 0;
const load = (member: PoolMember): number => (member.admission.running + member.admission.queued) / Math.max(1, member.limit());
const rank = (identity: string, member: string): string => createHash("sha256").update(JSON.stringify([identity, member])).digest("hex");

/**
 * One model served by several interchangeable machines. A conversation stays on the member that holds its prompt cache; a new
 * one starts on the member with the most room. A member that advertises no capacity is drained: nothing new goes there and its
 * conversations move. A member that cannot be reached loses a request to another one only while nothing has been produced.
 */
export class ProviderPool {
  readonly pollMs: number;
  constructor(readonly id: string, private readonly members: readonly PoolMember[], private readonly pins: ProviderPoolPins, private readonly options: ProviderPoolOptions = {}) {
    this.pollMs = options.pollMs ?? 500;
  }
  lease(context: InferenceContext, cacheKey?: unknown): PoolLease {
    const identity = providerConversationId(context) ?? (typeof cacheKey === "string" && cacheKey && cacheKey.length <= 256 ? JSON.stringify(["cache", cacheKey]) : undefined);
    return new PoolLease(this, identity === undefined ? undefined : this.pins.key(identity));
  }
  totals(): { running: number; queued: number } {
    return this.members.reduce((sum, member) => ({ running: sum.running + member.admission.running, queued: sum.queued + member.admission.queued }), { running: 0, queued: 0 });
  }
  /** The member for this conversation, or undefined once every member is excluded. */
  choose(key: string | undefined, excluded: ReadonlySet<string>): Choice | undefined {
    const members = this.members.filter(member => !excluded.has(member.id));
    if (!members.length) return;
    const live = members.filter(member => usable(member));
    const pin = key === undefined ? undefined : this.pins.get(key);
    const pinned = members.find(member => member.id === pin);
    if (pinned && (usable(pinned) || !live.length)) return { member: pinned, reason: "pinned" };
    const ready = live.filter(member => !this.pins.cooling(member.id));
    const pool = ready.length ? ready : live.length ? live : members;
    const identity = key ?? randomUUID(); const scored = pool.map(member => ({ member, free: free(member), load: load(member), rank: rank(identity, member.id) }));
    scored.sort((a, b) => Number(b.free) - Number(a.free) || a.load - b.load || (a.rank < b.rank ? 1 : -1));
    return { member: scored[0]!.member, reason: excluded.size || pinned?.lost?.() ? "failover" : pinned ? "drained" : "new" };
  }
  /** A waiting request leaves its queue when its member drained, or, for a conversation with no cache to lose, when another has room. */
  shouldMove(choice: Choice, excluded: ReadonlySet<string>): boolean {
    if (!usable(choice.member)) return this.stranded(choice, excluded);
    const others = this.members.filter(member => member !== choice.member && !excluded.has(member.id) && usable(member));
    return choice.reason !== "pinned" && !free(choice.member) && others.some(member => free(member) && !this.pins.cooling(member.id));
  }
  /** The chosen member drained or was lost while another one can serve. */
  stranded(choice: Choice, excluded: ReadonlySet<string>): boolean {
    return !usable(choice.member) && this.members.some(member => member !== choice.member && !excluded.has(member.id) && usable(member));
  }
  /** Whether a request can fail over to a member that currently has capacity. */
  another(excluded: ReadonlySet<string>): boolean { return this.members.some(member => !excluded.has(member.id) && usable(member)); }
  pin(key: string | undefined, member: PoolMember): void { if (key !== undefined) this.pins.set(key, member.id); }
  succeeded(member: PoolMember): void { this.pins.warm(member.id); this.options.onSuccess?.(member.id); }
  failed(member: PoolMember, error: unknown, down: boolean): void {
    if (down) this.pins.cool(member.id, (this.options.now ?? Date.now)() + (this.options.coolMs ?? 30_000));
    this.options.onFailure?.(member.id, error);
  }
}

/** One request's place in a pool: the admission it waits in, and the adapter it runs on, are the chosen member's own. */
export class PoolLease implements AdmissionGate, Provider {
  private choice?: Choice;
  private release?: () => void;
  private closed = false;
  constructor(private readonly pool: ProviderPool, private readonly key: string | undefined) {}
  get running(): number { return this.pool.totals().running; }
  get queued(): number { return this.pool.totals().queued; }
  check(): void { this.pool.choose(this.key, new Set())?.member.admission.check(); }
  async acquire(signal: AbortSignal): Promise<() => void> {
    const choice = await this.enter(signal, new Set());
    // A conversation is bound as soon as it is admitted, so its parallel requests share one member.
    if (choice.reason !== "pinned") this.pool.pin(this.key, choice.member);
    telemetry("pool_member_selected", { pool: this.pool.id, member: choice.member.id, reason: choice.reason });
    return () => { this.closed = true; this.leave(); };
  }

  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    const failed = new Set<string>(); let startedAt: number | undefined; let rounds = 0; let retryable = false;
    // A warm conversation gets one short retry where its cache is: a front door that is restarting costs a second, a cold prefill minutes.
    let again = this.choice?.reason === "pinned";
    for (;;) {
      const choice = this.choice;
      if (!choice) throw new Error("Provider pool request was not admitted");
      const { member } = choice; let produced = false;
      const stuck = new AbortController();
      const watch = setInterval(() => { if (!produced && member.lost?.()) stuck.abort(); }, this.pool.pollMs); watch.unref();
      try {
        for await (const event of member.adapter.infer(request, AbortSignal.any([signal, stuck.signal]), { ...context, connectOnce: true })) {
          if (!produced) { produced = true; if (choice.reason === "failover") this.pool.pin(this.key, member); }
          yield event;
        }
        this.pool.succeeded(member);
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        const down = stuck.signal.aborted && !produced ? { retryable: false } : unreachable(error);
        // Once anything was produced the request is the client's to retry; a replay here could repeat output.
        this.pool.failed(member, stuck.signal.aborted ? new ProviderError("upstream_unavailable", "Pool member stopped answering", 503) : error, down !== undefined && !produced);
        if (!down || produced) throw error;
        startedAt ??= networkRetryNow(); retryable ||= down.retryable;
        if (again && down.retryable) {
          again = false;
          const waitMs = networkRetryWaitMs(0, 0);
          if (waitMs !== undefined) { await networkRetrySleep(waitMs, signal); continue; }
        }
        failed.add(member.id);
        if (!this.pool.another(failed)) {
          // Every member with capacity failed. Transient outages keep the ordinary connection budget; anything else is final now.
          const waitMs = retryable ? networkRetryWaitMs(rounds++, networkRetryNow() - startedAt) : undefined;
          if (waitMs === undefined) throw error;
          telemetry("provider_retry", { provider: this.pool.id, attempt: rounds + 1, code: "upstream_unavailable", upstreamStage: "connect", backoffMs: waitMs });
          await networkRetrySleep(waitMs, signal);
          failed.clear(); retryable = false;
        }
        this.leave();
        const next = await this.enter(signal, failed);
        telemetry("pool_failover", { pool: this.pool.id, from: member.id, to: next.member.id, reason: stuck.signal.aborted ? "unanswered" : "unreachable" });
      } finally { clearInterval(watch); }
    }
  }

  private leave(): void { const release = this.release; this.release = undefined; release?.(); }
  private async enter(signal: AbortSignal, excluded: ReadonlySet<string>): Promise<Choice> {
    for (;;) {
      signal.throwIfAborted();
      const choice = this.pool.choose(this.key, excluded);
      if (!choice) throw new ProviderError("upstream_unavailable", "No pool member is available; retry shortly", 503);
      const moved = new AbortController();
      const timer = setInterval(() => { if (this.pool.shouldMove(choice, excluded)) moved.abort(); }, this.pool.pollMs); timer.unref();
      try {
        const release = await choice.member.admission.acquire(AbortSignal.any([signal, moved.signal]));
        if (this.closed) { release(); throw signal.reason ?? new DOMException("The operation was aborted", "AbortError"); }
        // The place came free because the request ahead gave this member up; entering it now would only repeat that wait.
        if (this.pool.stranded(choice, excluded)) { release(); continue; }
        this.choice = choice; this.release = release;
        return choice;
      } catch (error) {
        if (signal.aborted || this.closed || !moved.signal.aborted) throw error;
      } finally { clearInterval(timer); }
    }
  }
}

/** What a pool provider reports about itself: its members' queues, not its own unused one. Requests admitted before it became a pool still count. */
export function pooledLoad(config: GatewayConfig, id: string, read: (id: string) => { running: number; queued: number; limit: number }): { running: number; queued: number; limit: number } {
  const own = read(id); const members = poolMembers(config, id);
  if (!members.length) return own;
  return members.map(read).reduce((sum, next) => ({ running: sum.running + next.running, queued: sum.queued + next.queued, limit: sum.limit + next.limit }),
    { running: own.running, queued: own.queued, limit: 0 });
}
/** Configured members of a pool that exist; a refused configuration change may have taken one away. */
export function poolMembers(config: Pick<GatewayConfig, "providers">, id: string): string[] {
  const pool = config.providers.find(provider => provider.id === id)?.pool ?? [];
  return pool.filter(member => config.providers.some(provider => provider.id === member));
}
/** One health fact for a pool, from its members' own probes: degraded while some answer, unhealthy when none does. */
export function pooledHealth(facts: readonly (HealthFact | undefined)[]): HealthFact | undefined {
  const known = facts.filter((fact): fact is HealthFact => fact !== undefined);
  if (!known.length) return;
  const up = known.filter(fact => fact.status !== "unhealthy"); const latencies = up.flatMap(fact => fact.latencyMs === undefined ? [] : [fact.latencyMs]);
  const served = [...new Set(up.flatMap(fact => fact.servedModels))];
  const status = !up.length ? "unhealthy" : up.length < facts.length || up.some(fact => fact.status === "degraded") ? "degraded" : "healthy";
  const reason = known.find(fact => fact.reason)?.reason;
  return { status, observedAt: Math.min(...known.map(fact => fact.observedAt)), ...(latencies.length ? { latencyMs: Math.min(...latencies) } : {}),
    endpoints: { healthy: known.reduce((sum, fact) => sum + fact.endpoints.healthy, 0), total: known.reduce((sum, fact) => sum + fact.endpoints.total, 0) },
    servedModels: served, missingModels: [...new Set(up.flatMap(fact => fact.missingModels))].filter(model => !served.includes(model)), ...(reason && status !== "healthy" ? { reason } : {}) };
}
