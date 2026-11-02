import { object, type Message } from "./app-server-connection.js";
import { compactionDecision, type CompactionDecision, type CompactionState, type CompactionTarget } from "./compaction-state.js";

const numericKeys = ["model_context_window", "model_auto_compact_token_limit"] as const;
const maxThreads = 4096;
const unknown = Symbol("unknown numeric override");
type Numeric = number | typeof unknown | null;
type Overrides = Partial<Record<typeof numericKeys[number], Numeric>> & { goals?: boolean; scope?: unknown };
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const booleanSetting = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : typeof object(value).enabled === "boolean" ? object(value).enabled as boolean : undefined;
function numeric(value: unknown): Numeric {
  return value === undefined || value === null ? null : positive(value) ? value : unknown;
}
function cliInteger(value: string): Numeric {
  return /^[+]?[0-9]+(?:_[0-9]+)*$/.test(value.trim()) ? numeric(Number(value.trim().replaceAll("_", ""))) : unknown;
}
function goalValue(config: Message): boolean | undefined {
  if (typeof config["features.goals.enabled"] === "boolean") return config["features.goals.enabled"] as boolean;
  return Object.hasOwn(config, "features.goals") ? booleanSetting(config["features.goals"]) : booleanSetting(object(config.features).goals);
}
function keyValue(value: string): [string, string] | undefined {
  const index = value.indexOf("="); if (index < 0) return;
  return [value.slice(0, index).trim().replace(/^["']|["']$/g, ""), value.slice(index + 1).trim()];
}
function multiplier(value: number, percent: number): number {
  return Number(BigInt(value) * BigInt(percent) / 100n);
}

/** Public model rows and configured overrides frozen to their actual executor generation. */
export class CompactionPolicy {
  private readonly models = new Map<string, Message>();
  private readonly base: Overrides = {};
  private readonly threads = new Map<string, Overrides>();
  private readonly scope: unknown;
  constructor(models: readonly Message[], settings: Message = {}, args: string[] = []) {
    const duplicated = new Set<string>();
    for (const input of models) {
      if (typeof input.slug !== "string" || !input.slug || input.slug.length > 1024) continue;
      if (this.models.has(input.slug) || duplicated.has(input.slug)) { this.models.delete(input.slug); duplicated.add(input.slug); continue; }
      this.models.set(input.slug, Object.fromEntries(["context_window", "max_context_window", "auto_compact_token_limit", "effective_context_window_percent", "comp_hash"]
        .filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])));
    }
    for (const key of numericKeys) this.base[key] = numeric(settings[key]);
    let scope = settings.model_auto_compact_token_limit_scope;
    let goals = goalValue(settings) ?? true;
    const toggles: boolean[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]; let config: string | undefined;
      if (arg === "-c" || arg === "--config") config = args[++index];
      else if (arg.startsWith("--config=")) config = arg.slice(9);
      else if (arg.startsWith("-c") && arg.length > 2) config = arg.slice(2).replace(/^=/, "");
      if (config !== undefined) {
        const parsed = keyValue(config); if (!parsed) continue;
        const [key, value] = parsed;
        if ((numericKeys as readonly string[]).includes(key)) this.base[key as typeof numericKeys[number]] = cliInteger(value);
        else if (key === "model_auto_compact_token_limit_scope") {
          scope = value.replace(/^["']|["']$/g, "");
        } else if (["features.goals", "features.goals.enabled"].includes(key) && ["true", "false"].includes(value)) goals = value === "true";
      } else if (arg === "--enable" || arg === "--disable") {
        if (args[++index] === "goals") toggles.push(arg === "--enable");
      } else if (arg === "--enable=goals" || arg === "--disable=goals") toggles.push(arg === "--enable=goals");
    }
    // SDK appends enables, then disables, after every -c override.
    this.base.goals = toggles.includes(false) ? false : toggles.includes(true) ? true : goals;
    this.scope = scope;
  }
  /** Replace the complete override snapshot for a newly loaded SDK session. */
  remember(threadId: string, configOverrides: Message): void {
    if (!threadId || threadId.length > 1024 || threadId.includes("\0")) throw new Error("Invalid compaction policy chat identifier");
    const selected: Overrides = {};
    for (const key of numericKeys) if (Object.hasOwn(configOverrides, key)) selected[key] = numeric(configOverrides[key]);
    if (Object.hasOwn(configOverrides, "model_auto_compact_token_limit_scope")) selected.scope = configOverrides.model_auto_compact_token_limit_scope;
    const goals = goalValue(configOverrides); if (goals !== undefined) selected.goals = goals;
    if (!Object.keys(selected).length) this.threads.delete(threadId);
    else {
      // Insertion order tracks recency, so a full table drops the chat that was set longest ago.
      this.threads.delete(threadId); this.threads.set(threadId, selected);
      while (this.threads.size > maxThreads) this.threads.delete(this.threads.keys().next().value as string);
    }
  }
  /** A chat the engine no longer holds keeps no per-chat overrides. */
  forget(threadId: string): void { this.threads.delete(threadId); }
  goalsEnabled(threadId: string): boolean { return this.threads.get(threadId)?.goals ?? this.base.goals ?? true; }
  /** The smallest usable window among this generation's models, for a turn that does not name its model. */
  smallestWindow(threadId: string): number | undefined {
    let smallest: number | undefined;
    for (const model of this.models.keys()) {
      const window = this.target(threadId, model)?.effectiveContextWindow;
      if (window && (smallest === undefined || window < smallest)) smallest = window;
    }
    return smallest;
  }
  sourceHash(model: string): string | null {
    const hash = this.models.get(model)?.comp_hash;
    return typeof hash === "string" && hash.length <= 1024 && !hash.includes("\0") ? hash : null;
  }
  target(threadId: string, model: string): CompactionTarget | undefined {
    const thread = this.threads.get(threadId);
    const scope = thread && Object.hasOwn(thread, "scope") ? thread.scope : this.scope;
    const metadata = this.models.get(model); if (!metadata || (scope != null && scope !== "total")) return;
    const configured = { ...this.base, ...this.threads.get(threadId) };
    const windowOverride = configured.model_context_window;
    const limitOverride = configured.model_auto_compact_token_limit;
    if (windowOverride === unknown || limitOverride === unknown) return;
    const maximum = metadata.max_context_window;
    if (maximum != null && !positive(maximum)) return;
    const raw = windowOverride != null ? maximum != null ? Math.min(windowOverride, maximum as number) : windowOverride
      : metadata.context_window ?? maximum;
    if (!positive(raw)) return;
    const percent = metadata.effective_context_window_percent === undefined ? 95 : metadata.effective_context_window_percent;
    if (!positive(percent) || percent > 100) return;
    const effectiveContextWindow = multiplier(raw, percent);
    const modelLimit = limitOverride ?? metadata.auto_compact_token_limit;
    if (modelLimit != null && !positive(modelLimit)) return;
    const contextLimit = multiplier(raw, 90);
    const autoCompactTokenLimit = modelLimit == null ? contextLimit : Math.min(modelLimit as number, contextLimit);
    if (!effectiveContextWindow || !autoCompactTokenLimit) return;
    return { effectiveContextWindow, autoCompactTokenLimit, ...(this.sourceHash(model) !== null ? { compactionHash: this.sourceHash(model)! } : {}) };
  }
  decision(threadId: string, model: string, state: CompactionState | undefined, sourceModel?: string): CompactionDecision {
    // A current thread model can already reflect the UI's requested target.
    // It does not establish the previous turn's compatibility hash. Gateway
    // aliases currently omit hashes; reject hashed recovery rather than guess.
    if (this.models.get(model)?.comp_hash != null) return { action: "reject", reason: "unsupported-compaction-hash" };
    for (const name of [model, sourceModel]) {
      if (name === undefined) continue;
      const hash = this.models.get(name)?.comp_hash;
      if (hash != null && (typeof hash !== "string" || hash.length > 1024 || hash.includes("\0"))) return { action: "reject", reason: "unsupported-compaction-hash" };
    }
    const target = this.target(threadId, model);
    if (!target) {
      if (this.sourceHash(model) !== (sourceModel === undefined ? null : this.sourceHash(sourceModel))) return { action: "reject", reason: "unsupported-compaction-hash" };
      return state?.compaction?.status === "failed" ? { action: "compact", reason: "failed" } : { action: "none" };
    }
    return compactionDecision(state, { ...target, autoCompactTokenLimit: Math.min(target.autoCompactTokenLimit, target.effectiveContextWindow) },
      sourceModel === undefined ? null : this.sourceHash(sourceModel));
  }
}
