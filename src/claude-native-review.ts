import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { delimiter, isAbsolute, join } from "node:path";
import { cacheGuardedNativeMessages } from "./claude-native-cache.js";
import type { GatewayConfig, ProviderConfig } from "./config.js";
import { ContextCacheBlocked } from "./context-cache-budget.js";
import { nativeModelAlias } from "./model-routing.js";
import { providerCommand } from "./provider-tool-runtime.js";
import type { Usage } from "./protocol/types.js";
import { ProviderError } from "./providers/provider.js";

// Auto reviews already exceed 140 KiB. This is the limit the Desktop path uses, within the native runner's own cap.
const maxRequestBytes = 262144;
const reviewTimeoutMs = 60_000;
const maxConcurrent = 2;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** The gateway's usage counts for a native reply, which reports reads and writes apart from its input. */
export function nativeReviewUsage(value: Record<string, unknown>): Usage {
  const read = count(value.cache_read_input_tokens), written = count(value.cache_creation_input_tokens), output = count(value.output_tokens);
  const input = count(value.input_tokens) + read + written;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: read, cache_creation_tokens: written } };
}
let active = 0;

export interface NativeMessagesOptions {
  command: string; authDirectory?: string; headers: Record<string, string>; signal: AbortSignal; timeoutMs: number; maxRequestBytes: number;
  observeCacheUsage?: (usage: Record<string, unknown>) => void;
}
export interface NativeRuntime {
  isNativeClassifierRequest?: (payload: unknown) => boolean;
  isSupportedClassifierRequest?: (payload: unknown) => boolean;
  runNativeMessages?: (payload: Record<string, unknown>, model: string, options: NativeMessagesOptions) => Promise<Record<string, unknown>>;
}
let runtime: Promise<NativeRuntime> | undefined;
export function nativeRuntimeModule(): Promise<NativeRuntime> {
  return runtime ??= import(new URL("../scripts/claude-desktop-native-messages.mjs", import.meta.url).href) as Promise<NativeRuntime>;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A reply counts only as a complete text message from the model that was asked. Anything else stays a failure, never a verdict. */
export function completedNativeMessage(value: unknown, nativeModel: string): Record<string, unknown> | undefined {
  if (!record(value) || value.type !== "message" || value.role !== "assistant" || value.model !== nativeModel
    || typeof value.id !== "string" || !value.id || !Array.isArray(value.content) || !value.content.length || !record(value.usage)
    || !["end_turn", "stop_sequence"].includes(value.stop_reason as string) || (value.stop_reason === "stop_sequence" && typeof value.stop_sequence !== "string")
    || (value.stop_reason === "end_turn" && value.stop_sequence !== null)) return;
  const usage = value.usage;
  if (value.content.some(block => !record(block) || block.type !== "text" || typeof block.text !== "string")) return;
  if (["input_tokens", "output_tokens"].some(key => typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0)) return;
  return value;
}

/** Only an explicit side request, or one with no class at all, can reach the native reviewer. */
export function nativeReviewHeaders(headers: IncomingHttpHeaders): Record<string, string> | undefined {
  const requestClass = headers["x-claude-code-request-class"];
  if (Array.isArray(requestClass) || (requestClass !== undefined && requestClass !== "auxiliary")) return;
  const result: Record<string, string> = { "x-claude-code-request-class": "auxiliary" };
  const beta = headers["anthropic-beta"];
  if (beta !== undefined && (typeof beta !== "string" || beta.length > 4096 || !/^[\x20-\x7e]*$/.test(beta))) return;
  if (typeof beta === "string") result["anthropic-beta"] = beta;
  return result;
}

export interface NativeReviewTarget { alias: string; nativeModel: string; provider: ProviderConfig; headers: Record<string, string>; payload: Record<string, unknown> }

/**
 * Claude Code's auto-mode classifier asks for a Claude model by its bare name. Only a real Claude subscription route serves it here: this path never
 * sends it to another model. Every other case returns undefined, so the ordinary path refuses it and the client takes its own fallback or denies the action.
 */
export async function nativeReviewTarget(config: GatewayConfig, wire: unknown, headers: IncomingHttpHeaders, load: () => Promise<NativeRuntime> = nativeRuntimeModule): Promise<NativeReviewTarget | undefined> {
  if (!record(wire) || typeof wire.model !== "string") return;
  const reviewHeaders = nativeReviewHeaders(headers);
  if (!reviewHeaders) return;
  const alias = nativeModelAlias(config, wire.model);
  const provider = alias ? config.providers.find(entry => Object.hasOwn(entry.models, alias)) : undefined;
  if (!alias || provider?.type !== "claude-subscription" || provider.models[alias] !== wire.model) return;
  const module = await load().catch(() => undefined);
  if (module?.isSupportedClassifierRequest?.(wire) !== true) return;
  return { alias, nativeModel: wire.model, provider, headers: reviewHeaders, payload: wire };
}

async function absoluteClaude(): Promise<string> {
  const command = await providerCommand("claude");
  if (isAbsolute(command)) return command;
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, command);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  throw new ProviderError("upstream_unavailable", "Claude review is unavailable on this host", 503);
}

/** One restricted, tool-free Claude turn. Size, concurrency and cache budgets stay bounded, and any failure stays a failure. */
export async function serveNativeReview(target: NativeReviewTarget, requestHeaders: IncomingHttpHeaders, signal: AbortSignal, load: () => Promise<NativeRuntime> = nativeRuntimeModule,
  onUsage?: (usage: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  if (Buffer.byteLength(JSON.stringify(target.payload)) > maxRequestBytes) throw new ProviderError("request_too_large", "Claude review request exceeds the allowed size", 413);
  if (active >= maxConcurrent) throw new ProviderError("rate_limit_exceeded", "Claude review concurrency is full; retry shortly", 429);
  active++;
  try {
    const { runNativeMessages } = await load();
    if (!runNativeMessages) throw new ProviderError("upstream_unavailable", "Claude review is unavailable on this host", 503);
    const command = await absoluteClaude();
    const reply = completedNativeMessage(await cacheGuardedNativeMessages(target.provider, target.payload, requestHeaders, signal, observeCacheUsage =>
      runNativeMessages(target.payload, target.nativeModel, { command, observeCacheUsage: usage => { onUsage?.(usage); observeCacheUsage(usage); }, headers: target.headers, signal, timeoutMs: reviewTimeoutMs, maxRequestBytes,
        ...(target.provider.authDirectory === undefined ? {} : { authDirectory: target.provider.authDirectory }) })), target.nativeModel);
    if (!reply) throw new ProviderError("upstream_unavailable", "Claude review returned an incomplete response", 502);
    onUsage?.(reply.usage as Record<string, unknown>);
    return reply;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof ContextCacheBlocked) throw new ProviderError("invalid_request", error.message, 400);
    const status = (error as { status?: unknown }).status;
    // The runner's own errors never reach a client: only a fixed, content-free message does.
    throw new ProviderError("upstream_unavailable", "Claude review is unavailable", status === 408 ? 408 : 502);
  } finally { active--; }
}
