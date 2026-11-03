import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { modelCatalog } from "./catalog.js";
import { readClientToken, unscopedAliasCount, validateAliasesAgainstNative, writePrivateJson, type GatewayConfig } from "./config.js";
import { object, type Message } from "./app-server-connection.js";
import { publicServiceTierFields, readPublicServiceTierMetadata } from "./model-service-tiers.js";
import { executorNativeRow, executorRunsCodeMode, noReviewers, nodeReplFallback, upstreamSlugField, withFallback, withNativeRow } from "./codex-native-rows.js";
import { tokenizerFamilyField } from "./compaction-switch-guard.js";
import { readAutoReviewAdvertisement } from "./auto-review.js";
import { telemetry } from "./telemetry.js";

export interface DesktopCatalogSnapshot { models: Message[]; revision: string; path: string }
const maxCatalogBytes = 1024 * 1024;
const reasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
// This endpoint carries public ModelInfo, never provider configuration or cache identity.
const publicFields = new Set([
  "slug", "display_name", "description", "priority", "visibility", "supported_in_api", "availability_nux", "upgrade",
  "default_reasoning_level", "default_reasoning_summary", "supports_reasoning_summary_parameter", "shell_type", "apply_patch_tool_type", "tool_mode",
  "include_skills_usage_instructions", "include_plugin_usage_instructions", "include_apps_usage_instructions", "support_verbosity", "default_verbosity",
  "context_window", "effective_context_window_percent", "supports_search_tool", "web_search_tool_type", "supports_experimental_context", "node_repl_disabled", "node_repl_auto_review_required",
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
    // The upstream model's tokenizer family, for the switch guard (docs/app-server-compaction.md); a short plain name only.
    const family = model[tokenizerFamilyField];
    if (typeof family === "string" && /^[a-z0-9]{1,64}$/.test(family)) result[tokenizerFamilyField] = family;
    const policy = object(model.truncation_policy);
    if (typeof policy.mode === "string" && typeof policy.limit === "number") result.truncation_policy = { mode: policy.mode, limit: policy.limit };
    if (Array.isArray(model.experimental_supported_tools) && model.experimental_supported_tools.every(tool => typeof tool === "string")) result.experimental_supported_tools = model.experimental_supported_tools;
    return result;
  });
}

/** The alias warning is written once per process, not once per desktop connection. */
let unscopedWarned = false;
function warnUnscopedAliases(config: GatewayConfig): void {
  const count = unscopedAliasCount(config);
  if (!count || unscopedWarned) return;
  unscopedWarned = true; telemetry("gateway_alias_unscoped", { count });
  process.stderr.write(`gateway: ${count} model alias${count === 1 ? " has" : "es have"} no "/" (such as claude/sonnet); a native model added later with the same name would take its place\n`);
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
  private published: Message[];
  // prepareNativeCatalog writes the gateway rows without native copies; replace that file once.
  private written = false;
  // The reviewer slugs the inference host advertised when each snapshot was built; combined() applies the same set to the native rows.
  private readonly reviewers = new WeakMap<DesktopCatalogSnapshot, ReadonlySet<string>>();
  /** A gateway request keeps its observed public rows while another request refreshes the catalog. */
  private readonly publishedBySnapshot = new WeakMap<DesktopCatalogSnapshot, Message[]>();
  private readonly codeModeBySnapshot = new WeakMap<DesktopCatalogSnapshot, boolean>();
  /** The native catalog's slugs. A chat on one of these is native even when an alias of the same name existed. */
  readonly nativeSlugs: ReadonlySet<string>;
  constructor(private readonly config: GatewayConfig, private readonly native: Message[], readonly path: string, private codeMode = executorRunsCodeMode()) {
    this.nativeSlugs = new Set(native.map(model => model.slug).filter((slug): slug is string => typeof slug === "string"));
    validateAliasesAgainstNative(config, this.nativeSlugs);
    warnUnscopedAliases(config);
    this.published = modelCatalog(config).models;
    this.value = this.snapshot(this.published);
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
      this.published = models;
      const next = this.snapshot(models);
      // prepareNativeCatalog can overwrite the combined file during every launch.
      await writePrivateJson(this.path, this.combined(next));
      this.value = next; this.sourceIdentity = source; this.written = true;
    } catch { /* Unavailable, malformed or differently owned caches leave native discovery usable. */ }
    finally { await file?.close(); }
  }
  /**
   * `reviewers` come only from a live read of the host's catalog. The cached public rows do not prove
   * that a reviewer is reachable now, so a restored or reset snapshot has none and keeps node_repl off
   * wherever a row needs review until the next successful read.
   */
  private snapshot(published: Message[], reviewers: ReadonlySet<string> = noReviewers, codeMode = this.codeMode): DesktopCatalogSnapshot {
    // A row without a native counterpart takes the strictest node_repl policy and the shared review texts.
    const fallback = nodeReplFallback(this.native, reviewers);
    const models = published.map(model => {
      const row = withNativeRow(model, this.native, codeMode, reviewers);
      const resolved = typeof model[upstreamSlugField] === "string" && this.native.some(entry => entry.slug === model[upstreamSlugField]) ? row : withFallback(row, fallback);
      return !codeMode && resolved.tool_mode !== "direct" ? { ...resolved, tool_mode: "direct" } : resolved;
    });
    // The native rows carried for sub-agents change with the reviewers too, so a new generation starts when they do.
    // Native rows are added only in combined(), so the executor capability itself must participate: a private executor
    // otherwise could reuse a generation whose gateway rows happen to be unchanged but whose native child rows were code-mode-only.
    const revision = createHash("sha256").update(JSON.stringify([models, [...reviewers].sort(), codeMode])).digest("hex");
    const snapshot = { models, path: this.path, revision };
    this.reviewers.set(snapshot, reviewers);
    this.publishedBySnapshot.set(snapshot, published);
    this.codeModeBySnapshot.set(snapshot, codeMode);
    return snapshot;
  }
  /**
   * The native rows as gateway executors load them. Sub-agents that name a native model directly use
   * these rows, so an executor without Codex's code-mode host gives them direct tools instead of
   * failing every command, and they take the Codex 2 rows' node_repl rule: off where the reviewer
   * does not run here or no policy is stated. The reviewer row keeps its node_repl and review fields
   * and its review text stays the SDK's own. A carried row has the tool search flag off whatever a provider sets, because a
   * bare model name resolves to a route chosen at request time, which may drop `tool_search` (the ChatGPT backend refuses
   * it) or bridge it; an alias spelled like a native slug, which could take that name first, is refused at every gateway
   * catalog load, checked against the native slugs read at launch.
   * The native engine keeps its own catalog unchanged.
   */
  private executorNative(reviewers: ReadonlySet<string>, codeMode: boolean): Message[] {
    return this.native.map(model => {
      const row = executorNativeRow(model, this.native, reviewers);
      return !codeMode && row.tool_mode !== "direct" ? { ...row, tool_mode: "direct" } : row;
    });
  }
  /** Builds one generation's catalog from the exact public snapshot the request saw, with its selected runtime's capability. */
  snapshotForExecutor(snapshot: DesktopCatalogSnapshot, codeMode: boolean): DesktopCatalogSnapshot {
    if (this.codeModeBySnapshot.get(snapshot) === codeMode) return snapshot;
    return this.snapshot(this.publishedBySnapshot.get(snapshot) ?? this.published, this.reviewers.get(snapshot) ?? noReviewers, codeMode);
  }
  current(): DesktopCatalogSnapshot { return this.value; }
  isNative(model: string): boolean { return this.native.some(entry => entry.slug === model); }
  combined(snapshot = this.value): { models: Message[] } {
    const highest = Math.max(0, ...this.native.map(model => Number(model.priority) || 0));
    return { models: [...this.executorNative(this.reviewers.get(snapshot) ?? noReviewers, this.codeModeBySnapshot.get(snapshot) ?? this.codeMode), ...snapshot.models.map((model, index) => ({ ...model, priority: highest + index + 1 }))] };
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
    if (this.sourceIdentity && this.sourceIdentity !== source) { this.published = modelCatalog(this.config).models; this.value = this.snapshot(this.published); this.sourceIdentity = undefined; }
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
    // Only this live 200 response says which reviewers the host serves right now.
    this.published = models;
    const next = this.snapshot(this.published, readAutoReviewAdvertisement(parsed.auto_review));
    await writePrivateJson(resolve(this.config.stateDirectory, "desktop-public-models.json"), cache);
    if (next.revision !== this.value.revision || !this.written) await writePrivateJson(this.path, this.combined(next));
    this.value = next; this.sourceIdentity = source; this.checkedAt = Date.now(); this.written = true; return next;
  }
}
