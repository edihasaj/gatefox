import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { apiCredential, type ProviderConfig } from "./config.js";
import { boundedJson, isLocalProvider, type ProbeSeams } from "./availability/probe.js";
import { isTailnetAddress, tailnetFetch } from "./tailnet.js";

/**
 * Runtime admission read from the local model server itself. A self-hosted provider is a farm of workers behind a router, and
 * only the farm knows how many requests it can hold right now; the gateway never invents that number. It reads the
 * authenticated `GET {baseUrl}/capacity` snapshot, keeps the result in memory only, and hands it to the admission registry,
 * which still treats an explicit `maxConcurrent` as the ceiling. Nothing here picks a model, a route or a queue order.
 */

/** The response is a small control document; a larger one is refused instead of buffered. */
export const maxCapacityBodyBytes = 65536;
/** A farm with more distinct models than this is not a snapshot we will read. */
export const maxCapacityModels = 128;
/** One model's advertised concurrency, as the source reports it. */
export const maxSourceCapacity = 4096;
/** What the gateway will ever admit on a discovered fact, whatever the source claims. */
export const discoveredCapacityCeiling = 64;
/** A snapshot older than this describes a farm that has moved on; one further ahead than this is not trustworthy. */
export const capacityStaleSeconds = 30;
export const capacityFutureSkewSeconds = 5;
/** Router addresses probed per provider: more replicas than this is beyond what one Mac can poll each round. */
export const maxCapacityEndpoints = 4;
/** How often the watcher refreshes discovered capacity, and how long one bounded collection may take. */
export const capacityRefreshMs = 15_000;
export const capacityProbeTimeoutMs = 3_000;

/** One provider's discovered admission: the cap and when the source itself said it, in wall-clock milliseconds. */
export interface UpstreamCapacityFact { limit: number; observedAt: number }

/** The seams the local health probe already uses, so a test pins addresses and the clock in one place. */
export type UpstreamCapacitySeams = ProbeSeams;

export type CapacityProbe = (provider: ProviderConfig, seams?: UpstreamCapacitySeams, timeoutMs?: number) => Promise<UpstreamCapacityFact | undefined>;

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const hostOf = (baseUrl: string): string => new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
const distinctModels = (provider: ProviderConfig): string[] => [...new Set(Object.values(provider.models))];
/** The fields that decide which server and account a provider id means; a change makes every earlier fact about it foreign. */
const capacityIdentity = (provider: ProviderConfig): string => JSON.stringify([provider.type, provider.baseUrl ?? "", provider.tailnet === true,
  provider.credentialFile ?? "", provider.apiKeyEnv ?? "", distinctModels(provider).sort()]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const staleWindowMs = capacityStaleSeconds * 1000;

/**
 * One complete `inference_capacity` snapshot, read against the models this gateway actually routes to the farm. A model the
 * farm omits from a complete snapshot is a model it currently holds no slots for, so it counts as zero and drives the whole
 * provider down: a farm that cannot take a request for one configured model cannot be counted on for the provider. Anything
 * the contract does not satisfy — wrong envelope, incomplete, stale, from the future, oversized, duplicated or malformed —
 * proves nothing and yields undefined, which leaves the operator's own number in place.
 */
export function parseCapacitySnapshot(value: unknown, configuredModels: readonly string[], nowMs: number): UpstreamCapacityFact | undefined {
  if (!record(value)) return undefined;
  if (value.object !== "inference_capacity" || value.version !== 1 || value.complete !== true) return undefined;
  const { observed_at: observed, models } = value;
  // The farm writes this with `time.time()`, so a fractional reading is the normal case, not a defect.
  if (typeof observed !== "number" || !Number.isFinite(observed) || observed < 0) return undefined;
  const observedAt = observed * 1000;
  if (!Array.isArray(models) || models.length > maxCapacityModels) return undefined;
  if (observedAt < nowMs - staleWindowMs || observedAt > nowMs + capacityFutureSkewSeconds * 1000) return undefined;
  const advertised = new Map<string, number>();
  for (const entry of models) {
    if (!record(entry)) return undefined;
    const { id, max_concurrent_requests: capacity } = entry;
    if (typeof id !== "string" || !modelIdPattern.test(id)) return undefined;
    if (!Number.isInteger(capacity) || (capacity as number) < 0 || (capacity as number) > maxSourceCapacity) return undefined;
    // Two rows for one model is a source that does not know its own farm; either number could be the real one.
    if (advertised.has(id)) return undefined;
    advertised.set(id, capacity as number);
  }
  const configured = [...new Set(configuredModels)];
  // No configured model means nothing to serve, so there is no capacity claim to make.
  if (!configured.length) return undefined;
  const limit = Math.min(...configured.map(model => advertised.get(model) ?? 0));
  return { limit: Math.min(discoveredCapacityCeiling, Math.max(0, limit)), observedAt };
}

/**
 * Several router addresses front the same farm, so their snapshots are replicas of one truth and the tightest one governs.
 * They are never added: two routers each holding ten slots is a farm of ten, not twenty.
 */
export function combineCapacitySnapshots(facts: readonly UpstreamCapacityFact[]): UpstreamCapacityFact | undefined {
  if (!facts.length) return undefined;
  return { limit: Math.min(...facts.map(fact => fact.limit)), observedAt: Math.min(...facts.map(fact => fact.observedAt)) };
}

/**
 * Reads `GET {baseUrl}/capacity` from a self-hosted provider. Only a loopback inference provider, or a tailnet one, is
 * contacted at all; a generic remote provider is never asked. The key goes in the `Authorization` header and nowhere else,
 * redirects are refused, the body is capped, and the whole operation — lookup, connection, status line and body — is bounded
 * by `timeoutMs`, so a farm that has stopped answering cannot hold a collection round open.
 */
export async function probeUpstreamCapacity(provider: ProviderConfig, seams: UpstreamCapacitySeams = {}, timeoutMs = capacityProbeTimeoutMs): Promise<UpstreamCapacityFact | undefined> {
  try {
    if (!isLocalProvider(provider) || !provider.baseUrl) return undefined;
    const configured = distinctModels(provider);
    if (!configured.length) return undefined;
    const token = await apiCredential(provider).catch(() => undefined);
    if (!token) return undefined;
    const now = seams.now ?? Date.now;
    const base = provider.baseUrl.replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${token}` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Upstream capacity probe timed out", "TimeoutError")), timeoutMs);
    timer.unref?.();
    // One deadline covers the lookup as well as the exchange: a resolver that never answers is an answer, and a late
    // continuation cannot write into a round that has already moved on. The finally releases the timer and the transport.
    const expired = new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(controller.signal.reason ?? new Error("aborted"));
      if (controller.signal.aborted) fail(); else controller.signal.addEventListener("abort", fail, { once: true });
    });
    // A refused IP literal can return before any race is created. Final cleanup
    // still aborts this promise, so its rejection always needs an observer.
    void expired.catch(() => {});
    const within = <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => Promise.race([work(controller.signal), expired]);
    const read = async (request: (signal: AbortSignal) => Promise<Response>): Promise<UpstreamCapacityFact | undefined> => {
      try {
        const response = await within(signal => request(signal));
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return undefined; }
        return parseCapacitySnapshot(await within(() => boundedJson(response, maxCapacityBodyBytes)), configured, now());
      } catch { return undefined; }
    };
    try {
      let snapshots: Array<UpstreamCapacityFact | undefined>;
      if (provider.tailnet) {
        const host = hostOf(base);
        const resolve = seams.resolve ?? (async (name: string): Promise<string[]> => (await lookup(name, { all: true, verbatim: true })).map(entry => entry.address));
        // An IP literal needs no lookup, so it cannot be swapped by a later answer; a name is resolved once, under the deadline.
        const answers = isIP(host) ? [host] : await within(() => resolve(host)).catch(() => [] as string[]);
        // The bearer only ever goes to an address that has been checked against the tailnet, dialed as that literal address.
        const addresses = [...new Set(answers.filter(isTailnetAddress))].slice(0, maxCapacityEndpoints);
        if (!addresses.length) return undefined;
        snapshots = await Promise.all(addresses.map(address => read(signal => tailnetFetch(provider.id, {
          ...seams, resolve: async () => [address], connectTimeoutMs: Math.min(timeoutMs, seams.connectTimeoutMs ?? 1500),
        })(`${base}/capacity`, { method: "GET", headers, signal }))));
      } else {
        const request = seams.fetch ?? fetch;
        snapshots = [await read(signal => request(`${base}/capacity`, { method: "GET", headers, redirect: "error", signal }))];
      }
      return combineCapacitySnapshots(snapshots.filter((fact): fact is UpstreamCapacityFact => fact !== undefined));
    } finally { clearTimeout(timer); controller.abort(new DOMException("Upstream capacity probe finished", "AbortError")); }
  } catch { return undefined; }
}

/** Called with the discovered fact, or undefined when nothing was discovered and the operator's own number stands. */
export type CapacityFactCallback = (providerId: string, fact: UpstreamCapacityFact | undefined) => void;

export interface UpstreamCapacityDeps {
  /** Replaceable probe; production uses `probeUpstreamCapacity`. */
  probe?: CapacityProbe;
  /** Clock for the freshness window and the schedule; tests advance it. */
  now?: () => number;
  /** Refresh period; 15 s by default. */
  intervalMs?: number;
}

interface Watched {
  provider: ProviderConfig;
  identity: string;
  nextDueAt: number;
  /** One collection per provider at a time, so a slow farm is never stacked behind itself. */
  running: boolean;
  /** The applied fact's own expiry, which the poll interval alone cannot guarantee. */
  expiry?: NodeJS.Timeout;
}

/**
 * Keeps discovered capacity current for the providers the operator opted in, and only those. `configure(config.providers)`
 * is the whole interface: it clears a fact the instant its provider is disabled, removed, or rebound to another server or
 * account, refreshes on an unref'd timer that a process can exit through, and makes no call and starts no timer when nobody
 * opted in. A fact also expires on its own source timestamp, so a snapshot that was nearly too old when it arrived does not
 * stand for another whole poll interval. A result belonging to a superseded configuration or a retired watcher is dropped
 * rather than applied, so a slow answer cannot re-arrange a queue for a provider that is already gone.
 */
export class UpstreamCapacityWatcher {
  private watched = new Map<string, Watched>();
  private timer?: NodeJS.Timeout;
  /** Bumped whenever the watched set changes; a collection under an older generation has nothing left to say. */
  private generation = 0;
  private retired = false;

  constructor(private readonly onFact: CapacityFactCallback, private readonly deps: UpstreamCapacityDeps = {}) {}

  /** Adopts a reloaded configuration at once, without waiting for the schedule. */
  configure(providers: readonly ProviderConfig[]): void {
    if (this.retired) return;
    const now = this.now();
    const next = new Map<string, Watched>();
    for (const provider of providers) {
      if (provider.capacityDiscovery !== true) continue;
      const identity = capacityIdentity(provider);
      const previous = this.watched.get(provider.id);
      next.set(provider.id, previous && previous.identity === identity ? previous : { provider, identity, nextDueAt: now, running: false });
    }
    const changed = next.size !== this.watched.size
      || [...next].some(([id, entry]) => this.watched.get(id)?.identity !== entry.identity);
    if (changed) {
      this.generation++;
      // Stopping the opt-in, deleting the provider, or moving it to another server or account ends its claim right now.
      for (const [id, entry] of this.watched) {
        if (next.get(id)?.identity !== entry.identity) { this.clearExpiry(entry); this.report(id, undefined); }
      }
    }
    this.watched = next;
    if (!next.size) { this.stop(); return; }
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs ?? capacityRefreshMs);
      this.timer.unref();
    }
    // A provider that just appeared or changed is collected now rather than at the end of the interval.
    if (changed) void this.tick();
  }

  /** Stops collecting for good: the timers go, and no in-flight answer can call back afterwards. */
  retire(): void {
    this.retired = true;
    this.generation++;
    this.stop();
    for (const entry of this.watched.values()) this.clearExpiry(entry);
    this.watched.clear();
  }

  /** The providers this watcher currently collects for. */
  get tracking(): string[] { return [...this.watched.keys()]; }

  private stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private clearExpiry(entry: Watched): void { if (entry.expiry) clearTimeout(entry.expiry); entry.expiry = undefined; }

  private report(providerId: string, fact: UpstreamCapacityFact | undefined): void {
    if (this.retired) return;
    this.onFact(providerId, fact);
  }

  /** The entry still holds this provider's identity, so an older answer belongs to someone else. */
  private current(entry: Watched): boolean {
    return !this.retired && this.watched.get(entry.provider.id) === entry && entry.identity === capacityIdentity(entry.provider);
  }

  private async tick(): Promise<void> {
    if (this.retired) return;
    const generation = this.generation;
    const now = this.now();
    const due = [...this.watched.values()].filter(entry => !entry.running && entry.nextDueAt <= now);
    await Promise.all(due.map(entry => this.collect(entry, generation)));
  }

  private async collect(entry: Watched, generation: number): Promise<void> {
    entry.running = true;
    entry.nextDueAt = this.now() + (this.deps.intervalMs ?? capacityRefreshMs);
    const { provider, identity } = entry;
    let fact: UpstreamCapacityFact | undefined;
    try { fact = await (this.deps.probe ?? probeUpstreamCapacity)(provider); } catch { fact = undefined; }
    entry.running = false;
    if (this.retired || generation !== this.generation) return;
    if (this.watched.get(provider.id) !== entry || entry.identity !== identity) return;
    // Nothing discovered, or the probe threw: fall back to the operator's number at once rather than keep the old claim.
    if (!fact) { this.clearExpiry(entry); this.report(provider.id, undefined); return; }
    // The source timestamp, not the arrival time, is what expires: a near-stale snapshot must not stand until the next poll.
    const expiresIn = fact.observedAt + staleWindowMs - this.now();
    if (expiresIn <= 0) { this.clearExpiry(entry); this.report(provider.id, undefined); return; }
    this.clearExpiry(entry);
    this.report(provider.id, fact);
    entry.expiry = setTimeout(() => {
      entry.expiry = undefined;
      if (this.current(entry)) this.report(entry.provider.id, undefined);
    }, expiresIn);
    entry.expiry.unref?.();
  }
}
