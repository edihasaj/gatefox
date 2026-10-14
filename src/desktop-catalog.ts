import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { modelCatalog } from "./catalog.js";
import { readClientToken, writePrivateJson, type GatewayConfig } from "./config.js";
import { object, type Message } from "./app-server-connection.js";
import { publicServiceTierFields, readPublicServiceTierMetadata } from "./model-service-tiers.js";
import { executorRunsCodeMode, nodeReplFallback, upstreamSlugField, withNativeRow } from "./codex-native-rows.js";

export interface DesktopCatalogSnapshot { models: Message[]; revision: string; path: string }
const maxCatalogBytes = 1024 * 1024;
const reasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
// This endpoint carries public ModelInfo, never provider configuration or cache identity.
const publicFields = new Set([
  "slug", "display_name", "description", "priority", "visibility", "supported_in_api", "availability_nux", "upgrade",
  "default_reasoning_level", "default_reasoning_summary", "supports_reasoning_summary_parameter", "shell_type", "apply_patch_tool_type", "tool_mode",
  "include_skills_usage_instructions", "include_plugin_usage_instructions", "include_apps_usage_instructions", "support_verbosity", "default_verbosity",
  "context_window", "effective_context_window_percent", "supports_search_tool", "supports_experimental_context", "node_repl_disabled",
  "multi_agent_version", "multi_agent_reasoning_effort", "use_responses_lite", "supports_reasoning_effort_updates",
  "max_context_window", "auto_compact_token_limit",
]);
// Codex reads these as optional integers; anything else would break the combined catalog.
const integerFields = new Set(["max_context_window", "auto_compact_token_limit"]);
const publicScalar = (value: unknown) => value === null || ["string", "boolean", "number"].includes(typeof value);
const publicField = (key: string, value: unknown) => publicFields.has(key) && publicScalar(value) && (!integerFields.has(key) || (Number.isSafeInteger(value) && (value as number) > 0));

function publicModels(value: unknown, native: Message[]): Message[] {
  if (!Array.isArray(value) || !value.length || value.length > 4096) throw new Error("Gateway returned invalid model metadata");
  const ids = new Set<string>(); const nativeIds = new Set(native.map(model => model.slug));
  return value.map(entry => {
    const model = object(entry);
    if (typeof model.slug !== "string" || !model.slug || model.slug.length > 1024 || model.slug.includes("\0") || typeof model.display_name !== "string" || ids.has(model.slug) || nativeIds.has(model.slug)) throw new Error("Gateway model aliases are invalid, duplicated, or collide with native models");
    const levels = model.supported_reasoning_levels;
    if (!Array.isArray(levels) || levels.some(level => !reasoningEfforts.has(String(object(level).effort)))) throw new Error("Gateway returned invalid reasoning metadata");
    if (model.default_reasoning_level != null && !reasoningEfforts.has(String(model.default_reasoning_level))) throw new Error("Gateway returned invalid default reasoning metadata");
    const modalities = model.input_modalities;
    if (modalities !== undefined && (!Array.isArray(modalities) || !modalities.includes("text") || modalities.some(modality => !["text", "image"].includes(String(modality))))) throw new Error("Gateway returned invalid input-modality metadata");
    ids.add(model.slug);
    const result = Object.fromEntries(Object.entries(model).filter(([key, field]) => publicField(key, field)));
    Object.assign(result, publicServiceTierFields(readPublicServiceTierMetadata(model)));
    result.supported_reasoning_levels = levels.map(level => {
      const metadata = object(level);
      return { effort: metadata.effort, ...(typeof metadata.description === "string" ? { description: metadata.description } : {}) };
    });
    if (modalities !== undefined) result.input_modalities = modalities;
    // Inference hosts and old caches never supply an agent policy. A Codex 2 row names its
    // upstream slug instead, and snapshot() copies that model's messages from the native catalog.
    result.model_messages = { instructions_template: "" };
    const upstream = model[upstreamSlugField];
    if (typeof upstream === "string" && upstream && upstream.length <= 1024 && !upstream.includes("\0")) result[upstreamSlugField] = upstream;
    const policy = object(model.truncation_policy);
    if (typeof policy.mode === "string" && typeof policy.limit === "number") result.truncation_policy = { mode: policy.mode, limit: policy.limit };
    if (Array.isArray(model.experimental_supported_tools) && model.experimental_supported_tools.every(tool => typeof tool === "string")) result.experimental_supported_tools = model.experimental_supported_tools;
    return result;
  });
}

function sourceIdentity(port: number, token: string): string {
  const credential = createHash("sha256").update(token).digest("hex");
  return createHash("sha256").update(`catalog-v1\0http://127.0.0.1:${port}\0${credential}`).digest("hex");
}

/** Public metadata comes from the inference host, including through an SSH forward. */
export class DesktopCatalog {
  private value: DesktopCatalogSnapshot;
  private pending?: Promise<DesktopCatalogSnapshot>;
  private initialized?: Promise<void>;
  private sourceIdentity?: string;
  private checkedAt = 0;
  // prepareNativeCatalog writes the gateway rows without native copies; replace that file once.
  private written = false;
  constructor(private readonly config: GatewayConfig, private readonly native: Message[], readonly path: string, private readonly codeMode = executorRunsCodeMode()) {
    this.value = this.snapshot(modelCatalog(config).models);
  }
  initialize(): Promise<void> { return this.initialized ||= this.restore(); }
  private async restore(): Promise<void> {
    let file;
    try {
      const token = await readClientToken(resolve(this.config.stateDirectory, "client-token"));
      const source = sourceIdentity(this.config.port, token);
      file = await open(resolve(this.config.stateDirectory, "desktop-public-models.json"), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > maxCatalogBytes || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) return;
      const bytes = await file.readFile(); if (bytes.length > maxCatalogBytes) return;
      const cache = object(JSON.parse(bytes.toString("utf8")));
      if (cache.version !== 1 || cache.source !== source || Object.keys(cache).some(key => !["version", "source", "models"].includes(key))) return;
      const models = publicModels(cache.models, this.native);
      if (JSON.stringify(models).includes(token)) return;
      const next = this.snapshot(models);
      // prepareNativeCatalog can overwrite the combined file during every launch.
      await writePrivateJson(this.path, this.combined(next));
      this.value = next; this.sourceIdentity = source; this.written = true;
    } catch { /* Unavailable, malformed or differently owned caches leave native discovery usable. */ }
    finally { await file?.close(); }
  }
  private snapshot(published: Message[]): DesktopCatalogSnapshot {
    const disabled = nodeReplFallback(this.native);
    const models = published.map(model => {
      const row = withNativeRow(model, this.native, this.codeMode);
      return typeof model[upstreamSlugField] === "string" && this.native.some(entry => entry.slug === model[upstreamSlugField]) ? row : { ...row, node_repl_disabled: disabled };
    });
    return { models, path: this.path, revision: createHash("sha256").update(JSON.stringify(models)).digest("hex") };
  }
  current(): DesktopCatalogSnapshot { return this.value; }
  isNative(model: string): boolean { return this.native.some(entry => entry.slug === model); }
  /** The engine's own row for a native model, including the efforts it offers. */
  nativeRow(model: string): Message | undefined { return this.native.find(entry => entry.slug === model); }
  combined(snapshot = this.value): { models: Message[] } {
    const highest = Math.max(0, ...this.native.map(model => Number(model.priority) || 0));
    // Only gateway executors load this catalog. Sub-agents that name a native model directly use
    // these rows, so an executor without Codex's code-mode host gives them direct tools instead of
    // failing every command; the native engine keeps its own catalog unchanged.
    const native = this.codeMode ? this.native : this.native.map(model => typeof model.tool_mode === "string" && model.tool_mode !== "direct" ? { ...model, tool_mode: "direct" } : model);
    return { models: [...native, ...snapshot.models.map((model, index) => ({ ...model, priority: highest + index + 1 }))] };
  }
  refresh(strict = false): Promise<DesktopCatalogSnapshot> {
    return this.initialize().then(() => this.refreshInitialized(strict));
  }
  private refreshInitialized(strict: boolean): Promise<DesktopCatalogSnapshot> {
    // Coalesce concurrent UI discovery. Explicit gateway starts always check the host.
    if (!strict && Date.now() - this.checkedAt < 1000) return Promise.resolve(this.value);
    const read = this.pending || this.read();
    this.pending = read;
    void read.finally(() => { if (this.pending === read) this.pending = undefined; }).catch(() => {});
    return read.catch(error => {
      if (strict) throw Object.assign(new Error("Gateway model discovery is unavailable. Wait for its connection to recover, then retry the selected gateway model."), { code: -32001 });
      return this.value; // Native model discovery remains usable during a gateway outage.
    });
  }
  private async read(): Promise<DesktopCatalogSnapshot> {
    const token = await readClientToken(resolve(this.config.stateDirectory, "client-token"));
    const source = sourceIdentity(this.config.port, token);
    if (this.sourceIdentity && this.sourceIdentity !== source) { this.value = this.snapshot(modelCatalog(this.config).models); this.sourceIdentity = undefined; }
    const response = await fetch(`http://127.0.0.1:${this.config.port}/v1/model-catalog`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) throw new Error(`Gateway model discovery returned HTTP ${response.status}`);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > maxCatalogBytes) throw new Error("Gateway model catalog exceeds 1 MiB");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let parsed: Message; try { parsed = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { throw new Error("Gateway returned invalid model metadata"); }
    const models = publicModels(parsed.models, this.native);
    const cache = { version: 1, source, models };
    const encoded = JSON.stringify(cache, null, 2) + "\n";
    if (Buffer.byteLength(encoded) > maxCatalogBytes || encoded.includes(token)) throw new Error("Gateway public metadata cannot be cached safely");
    const next = this.snapshot(models);
    await writePrivateJson(resolve(this.config.stateDirectory, "desktop-public-models.json"), cache);
    if (next.revision !== this.value.revision || !this.written) await writePrivateJson(this.path, this.combined(next));
    this.value = next; this.sourceIdentity = source; this.checkedAt = Date.now(); this.written = true; return next;
  }
}
