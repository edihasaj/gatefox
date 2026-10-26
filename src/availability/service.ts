import { hostname } from "node:os";
import type { GatewayConfig, ProviderConfig } from "../config.js";
import type { ObservedProviderUsage } from "../provider-usage.js";
import { ProviderOutcomes } from "./outcomes.js";
import { isLocalProvider, probeLocalProvider, type HealthFact } from "./probe.js";
import { accountEmail, isOpenRouter, openRouterBalance, parseSpendwatch, runSpendwatch, type BalanceFact, type QuotaFact, type QuotaProvider } from "./quota.js";
import { gatewayQuota, newerQuota, providerRow } from "./report.js";

/** Replaceable collectors; production uses the real probe, Spendwatch, login readers and OpenRouter. */
export interface AvailabilityDeps {
  now?: () => number;
  probe?: (provider: ProviderConfig) => Promise<HealthFact>;
  spendwatch?: (command: string, provider: QuotaProvider) => Promise<string | undefined>;
  accountEmail?: (provider: ProviderConfig) => Promise<string | undefined>;
  balance?: (provider: ProviderConfig) => Promise<BalanceFact | undefined>;
  /** Scheduler tick; tests shorten it. */
  tickMs?: number;
}
export interface LoadReader { (providerId: string): { running: number; queued: number; limit: number } }

/** How often each source refreshes while someone is asking, and how long after the last request collection stops. */
export const refreshEvery = { health: 20_000, quota: 120_000, accounts: 300_000, balance: 300_000 } as const;
export const idleAfterMs = 1_800_000;
type Source = keyof typeof refreshEvery;
/** The fields that decide which account and endpoint a provider id means; a change makes every earlier fact about it foreign. */
const identity = (provider: ProviderConfig) => JSON.stringify([provider.type, provider.credentialFile ?? "", provider.authDirectory ?? "",
  provider.baseUrl ?? "", provider.tailnet === true, provider.apiKeyEnv ?? ""]);

/**
 * Facts about what this gateway can serve right now. Collection starts with the first availability request and stops after
 * 30 idle minutes, so a gateway nobody asks makes no extra calls. Requests read the in-memory snapshot only; a failing
 * source keeps its last observation, which then reports itself as no longer fresh.
 */
export class AvailabilityService {
  readonly outcomes: ProviderOutcomes;
  private readonly now: () => number;
  private config?: GatewayConfig;
  private lastRequestAt = 0;
  private timer?: NodeJS.Timeout;
  private readonly due = new Map<Source, number>();
  private readonly running = new Map<Source, Promise<void>>();
  private readonly health = new Map<string, HealthFact>();
  private readonly emails = new Map<string, string>();
  private readonly quota = new Map<QuotaProvider, Map<string, QuotaFact>>();
  private readonly balances = new Map<string, BalanceFact>();
  private warming?: Promise<void>;
  /** Bumped on every configuration change; a collection that started under an older one discards its result. */
  private generation = 0;
  private retired = false;
  private identities = new Map<string, string>();

  constructor(private readonly deps: AvailabilityDeps = {}) { this.now = deps.now ?? Date.now; this.outcomes = new ProviderOutcomes(this.now); }

  /** Adopts a reloaded configuration at once, so collectors never keep polling a removed or changed provider. */
  configure(config: GatewayConfig): void {
    if (config === this.config) return;
    this.config = config; this.generation++; this.due.clear();
    const next = new Map(config.providers.map(provider => [provider.id, identity(provider)] as const));
    for (const [id, previous] of this.identities) {
      if (next.get(id) === previous) continue;
      this.health.delete(id); this.emails.delete(id); this.balances.delete(id); this.outcomes.forget(id);
    }
    this.identities = next;
  }

  /** Records a request for availability and starts collection when it was idle. Resolves once the first round has finished. */
  touch(config: GatewayConfig): Promise<void> {
    if (this.retired) return Promise.resolve();
    this.configure(config); this.lastRequestAt = this.now();
    if (!this.timer) {
      this.due.clear();
      this.warming = this.tick();
      this.timer = setInterval(() => { void this.tick(); }, this.deps.tickMs ?? 5000); this.timer.unref();
    }
    return this.warming ?? Promise.resolve();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.warming = undefined; }
  /** A replaced handler generation stops collecting for good; its in-flight results are discarded. */
  retire(): void { this.retired = true; this.generation++; this.stop(); }
  get collecting(): boolean { return this.timer !== undefined; }

  /** The identity a request is routed under; its outcome is recorded only while the provider still has that identity. */
  identityOf(providerId: string): string | undefined { return this.identities.get(providerId); }
  recordSuccess(providerId: string, routedAs: string | undefined): void {
    if (routedAs !== undefined && this.identities.get(providerId) === routedAs) this.outcomes.success(providerId);
  }
  recordFailure(providerId: string, routedAs: string | undefined, code: string, upstreamCode?: string, retryAfterMs?: number, abortCause?: string): void {
    if (routedAs !== undefined && this.identities.get(providerId) === routedAs) this.outcomes.failure(providerId, code, upstreamCode, retryAfterMs, abortCause);
  }

  report(config: GatewayConfig, load: LoadReader, usage: ObservedProviderUsage[], hidden: ReadonlySet<string>): Record<string, unknown> {
    const now = this.now(); const spendwatch = config.availability?.spendwatch;
    return {
      object: "availability", generatedAt: new Date(now).toISOString(), host: hostname(),
      sources: { spendwatch: spendwatch ? "configured" : "off" },
      providers: config.providers.map(provider => {
        const email = this.emails.get(provider.id);
        const kind = provider.type === "codex-subscription" ? "codex" : provider.type === "claude-subscription" ? "claude" : undefined;
        const watched = kind && email && spendwatch ? this.quota.get(kind)?.get(email) : undefined;
        return providerRow({
          provider, local: isLocalProvider(provider), models: Object.keys(provider.models).filter(alias => !hidden.has(alias)), load: load(provider.id),
          health: this.health.get(provider.id), balance: this.balances.get(provider.id), outcome: this.outcomes.get(provider.id),
          quota: newerQuota(watched, gatewayQuota(provider, usage, now)),
        }, now);
      }),
    };
  }

  private async tick(): Promise<void> {
    const config = this.config; if (!config) return;
    const now = this.now();
    if (now - this.lastRequestAt > idleAfterMs) { this.stop(); return; }
    const work: Promise<void>[] = [];
    for (const source of Object.keys(refreshEvery) as Source[]) {
      if (this.running.has(source) || (this.due.get(source) ?? 0) > now) continue;
      this.due.set(source, now + refreshEvery[source]);
      const job = this.collect(source, config).catch(() => {}).finally(() => this.running.delete(source));
      this.running.set(source, job); work.push(job);
    }
    await Promise.all(work);
  }

  private async collect(source: Source, config: GatewayConfig): Promise<void> {
    const generation = this.generation; const current = () => generation === this.generation;
    if (source === "health") {
      await Promise.all(config.providers.filter(isLocalProvider).map(async provider => {
        try { const fact = await (this.deps.probe ?? probeLocalProvider)(provider); if (current()) this.health.set(provider.id, fact); } catch { /* keep the last observation */ }
      }));
    } else if (source === "accounts") {
      await Promise.all(config.providers.filter(provider => provider.type === "codex-subscription" || provider.type === "claude-subscription").map(async provider => {
        const value = await (this.deps.accountEmail ?? accountEmail)(provider).catch(() => undefined);
        if (!current()) return;
        // A login replaced in place is another account: what the old one ran into is not this one's.
        const previous = this.emails.get(provider.id);
        if (previous && value && previous !== value) this.outcomes.forget(provider.id);
        if (value) this.emails.set(provider.id, value); else this.emails.delete(provider.id);
      }));
    } else if (source === "quota") {
      const command = config.availability?.spendwatch; if (!command) { this.quota.clear(); return; }
      const kinds = new Set(config.providers.flatMap(provider => provider.type === "codex-subscription" ? ["codex" as const] : provider.type === "claude-subscription" ? ["claude" as const] : []));
      await Promise.all([...kinds].map(async kind => {
        const output = await (this.deps.spendwatch ?? runSpendwatch)(command, kind).catch(() => undefined);
        const facts = output === undefined ? undefined : parseSpendwatch(output, kind, this.now());
        // A failed read keeps the previous facts, which age out of `fresh` on their own.
        if (facts && facts.size && current()) this.quota.set(kind, facts);
      }));
    } else {
      await Promise.all(config.providers.filter(isOpenRouter).map(async provider => {
        const value = await (this.deps.balance ?? openRouterBalance)(provider).catch(() => undefined);
        if (value && current()) this.balances.set(provider.id, value);
      }));
    }
  }
}
