import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { modelCatalog } from "./catalog.js";
import { readClientToken, writePrivateJson, type GatewayConfig } from "./config.js";
import { object, type Message } from "./app-server-connection.js";

export interface DesktopCatalogSnapshot { models: Message[]; revision: string; path: string }

/** Public metadata comes from the inference host, including through an SSH forward. */
export class DesktopCatalog {
  private value: DesktopCatalogSnapshot;
  private pending?: Promise<DesktopCatalogSnapshot>;
  private checkedAt = 0;
  constructor(private readonly config: GatewayConfig, private readonly native: Message[], readonly path: string) {
    this.value = this.snapshot(modelCatalog(config).models);
  }
  private snapshot(models: Message[]): DesktopCatalogSnapshot {
    return { models, path: this.path, revision: createHash("sha256").update(JSON.stringify(models)).digest("hex") };
  }
  current(): DesktopCatalogSnapshot { return this.value; }
  isNative(model: string): boolean { return this.native.some(entry => entry.slug === model); }
  combined(snapshot = this.value): { models: Message[] } {
    const highest = Math.max(0, ...this.native.map(model => Number(model.priority) || 0));
    return { models: [...this.native, ...snapshot.models.map((model, index) => ({ ...model, priority: highest + index + 1 }))] };
  }
  refresh(strict = false): Promise<DesktopCatalogSnapshot> {
    // Coalesce concurrent UI discovery. Explicit gateway starts always check the host.
    if (!strict && Date.now() - this.checkedAt < 1000) return Promise.resolve(this.value);
    const read = this.pending || this.read();
    this.pending = read;
    void read.finally(() => { if (this.pending === read) this.pending = undefined; }).catch(() => {});
    return read.catch(error => {
      if (strict) throw error;
      return this.value; // Native model discovery remains usable during a gateway outage.
    });
  }
  private async read(): Promise<DesktopCatalogSnapshot> {
    const token = await readClientToken(resolve(this.config.stateDirectory, "client-token"));
    const response = await fetch(`http://127.0.0.1:${this.config.port}/v1/model-catalog`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) throw new Error(`Gateway model discovery returned HTTP ${response.status}`);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) throw new Error("Gateway model catalog exceeds 1 MiB");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let parsed: Message; try { parsed = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw new Error("Gateway returned invalid model metadata"); }
    if (!Array.isArray(parsed.models) || !parsed.models.length || parsed.models.length > 4096) throw new Error("Gateway returned invalid model metadata");
    const models = parsed.models.map(object); const ids = new Set<string>();
    const native = new Set(this.native.map(model => model.slug));
    for (const model of models) {
      if (typeof model.slug !== "string" || !model.slug || typeof model.display_name !== "string" || ids.has(model.slug) || native.has(model.slug)) throw new Error("Gateway model aliases are invalid, duplicated, or collide with native models");
      const levels = model.supported_reasoning_levels;
      if (!Array.isArray(levels) || levels.some(level => !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(String(object(level).effort)))) throw new Error("Gateway returned invalid reasoning metadata");
      const modalities = model.input_modalities;
      if (modalities !== undefined && (!Array.isArray(modalities) || !modalities.includes("text") || modalities.some(modality => !["text", "image"].includes(String(modality))))) throw new Error("Gateway returned invalid input-modality metadata");
      ids.add(model.slug);
    }
    const next = this.snapshot(models);
    if (next.revision !== this.value.revision) {
      await writePrivateJson(this.path, this.combined(next));
    }
    this.value = next; this.checkedAt = Date.now(); return next;
  }
}
