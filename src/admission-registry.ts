import type { GatewayConfig, ProviderConfig } from "./config.js";
import { Admission } from "./admission.js";

interface Entry { admission: Admission; snapshots: number; provider: ProviderConfig; fallback: number; discovered?: number; observedAt?: number; expiry?: NodeJS.Timeout }
const capacityIdentity = (provider: ProviderConfig) => JSON.stringify([provider.type, provider.baseUrl, provider.tailnet,
  provider.credentialFile, provider.apiKeyEnv, [...new Set(Object.values(provider.models))].sort()]);

export const providerAdmissionLimit = (provider: ProviderConfig, config: GatewayConfig) => provider.maxConcurrent ?? config.maxConcurrent ?? 4;

/** Provider admissions that survive a configuration snapshot until every request using it releases it. */
export class AdmissionRegistry {
  private readonly entries = new Map<string, Entry>();
  private configured = new Set<string>();
  private held = false;

  /** One-time migration from handlers that cannot expose their admission state. */
  holdUntilLegacyDrains(held: boolean): void {
    if (this.held === held) return;
    this.held = held;
    for (const [id, entry] of this.entries) entry.admission.setLimit(this.limit(id));
  }

  configure(config: GatewayConfig): void {
    this.configured = new Set(config.providers.map(provider => provider.id));
    for (const provider of config.providers) {
      const entry = this.entries.get(provider.id);
      const fallback = providerAdmissionLimit(provider, config);
      if (entry) {
        if (capacityIdentity(entry.provider) !== capacityIdentity(provider)) this.clearDiscovery(entry);
        entry.provider = provider; entry.fallback = fallback;
        if (!provider.capacityDiscovery) this.clearDiscovery(entry);
        entry.admission.setLimit(this.limit(provider.id));
      } else {
        this.entries.set(provider.id, { admission: new Admission(fallback), snapshots: 0, provider, fallback });
        this.entries.get(provider.id)!.admission.setLimit(this.limit(provider.id));
      }
    }
    this.discardIdle();
  }

  admission(id: string): Admission {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Admission snapshot is unavailable");
    return entry.admission;
  }

  /** A fresh upstream observation changes only this queue; existing requests finish normally after a decrease. */
  setDiscoveredLimit(id: string, value: number | undefined, observedAt = Date.now()): void {
    const entry = this.entries.get(id); if (!entry) return;
    this.clearDiscovery(entry);
    const now = Date.now();
    if (entry.provider.capacityDiscovery && value !== undefined && Number.isInteger(value) && value >= 0 && value <= 64
      && Number.isFinite(observedAt) && observedAt > now - 30_000 && observedAt <= now + 5000) {
      entry.discovered = value; entry.observedAt = observedAt;
      entry.expiry = setTimeout(() => {
        if (this.entries.get(id) !== entry || entry.observedAt !== observedAt) return;
        this.clearDiscovery(entry); entry.admission.setLimit(this.limit(id));
      }, Math.max(1, observedAt + 30_000 - now));
      entry.expiry.unref();
    }
    entry.admission.setLimit(this.limit(id));
  }

  limit(id: string): number {
    const entry = this.entries.get(id); if (!entry) return 0;
    if (this.held && entry.provider.capacityDiscovery) return 0;
    if (entry.discovered !== undefined && entry.observedAt !== undefined && Date.now() >= entry.observedAt + 30_000) {
      this.clearDiscovery(entry); entry.admission.setLimit(this.held && entry.provider.capacityDiscovery ? 0 : entry.fallback);
    }
    if (entry.discovered === undefined || !entry.provider.capacityDiscovery) return entry.fallback;
    return Math.min(entry.discovered, entry.provider.maxConcurrent ?? 64);
  }

  retain(providers: readonly ProviderConfig[]): () => void {
    const ids = new Set(providers.map(provider => provider.id));
    for (const id of ids) this.admission(id); // Verify every snapshot entry exists before retaining any.
    for (const id of ids) this.entries.get(id)!.snapshots++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) this.entries.get(id)!.snapshots--;
      this.discardIdle();
    };
  }

  totals(): { running: number; queued: number } {
    this.discardIdle();
    return [...this.entries.values()].reduce((total, entry) =>
      ({ running: total.running + entry.admission.running, queued: total.queued + entry.admission.queued }), { running: 0, queued: 0 });
  }

  maximumActive(config: GatewayConfig): number {
    const providerTotal = config.providers.reduce((total, provider) => total + (this.entries.has(provider.id) ? this.limit(provider.id) : providerAdmissionLimit(provider, config)), 0);
    return Math.max(config.maxConcurrent ?? 4, providerTotal) + 32;
  }

  size(): number { this.discardIdle(); return this.entries.size; }

  /** One provider's running and queued requests; zero for a provider without an admission. */
  load(id: string): { running: number; queued: number } {
    const admission = this.entries.get(id)?.admission;
    return { running: admission?.running ?? 0, queued: admission?.queued ?? 0 };
  }

  private discardIdle(): void {
    for (const [id, entry] of this.entries) {
      if (!this.configured.has(id) && !entry.snapshots && !entry.admission.running && !entry.admission.queued) {
        this.clearDiscovery(entry); this.entries.delete(id);
      }
    }
  }

  private clearDiscovery(entry: Entry): void {
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.expiry = undefined; entry.discovered = undefined; entry.observedAt = undefined;
  }
}
