import type { GatewayConfig, ProviderConfig } from "./config.js";
import { Admission } from "./admission.js";

interface Entry { admission: Admission; snapshots: number }

export const providerAdmissionLimit = (provider: ProviderConfig, config: GatewayConfig) => provider.maxConcurrent ?? config.maxConcurrent ?? 4;

/** Provider admissions that survive a configuration snapshot until every request using it releases it. */
export class AdmissionRegistry {
  private readonly entries = new Map<string, Entry>();
  private configured = new Set<string>();

  configure(config: GatewayConfig): void {
    this.configured = new Set(config.providers.map(provider => provider.id));
    for (const provider of config.providers) {
      const entry = this.entries.get(provider.id);
      if (entry) entry.admission.setLimit(providerAdmissionLimit(provider, config));
      else this.entries.set(provider.id, { admission: new Admission(providerAdmissionLimit(provider, config)), snapshots: 0 });
    }
    this.discardIdle();
  }

  admission(id: string): Admission {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Admission snapshot is unavailable");
    return entry.admission;
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
    const providerTotal = config.providers.reduce((total, provider) => total + providerAdmissionLimit(provider, config), 0);
    return Math.max(config.maxConcurrent ?? 4, providerTotal) + 32;
  }

  size(): number { this.discardIdle(); return this.entries.size; }

  private discardIdle(): void {
    for (const [id, entry] of this.entries) {
      if (!this.configured.has(id) && !entry.snapshots && !entry.admission.running && !entry.admission.queued) this.entries.delete(id);
    }
  }
}
