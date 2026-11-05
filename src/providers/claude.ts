import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { responsesToChatRequest } from "../protocol/request.js";
import type { ResponsesRequest, InferenceEvent, OpenAITool, ChatToolSelection, PublicServiceTier } from "../protocol/types.js";
import { ProviderError, providerRefusal, providerConversationId, type Provider, type InferenceContext } from "./provider.js";
import { claudeSessionSettings, type ProviderConfig } from "../config.js";
import { validateForcedChoice } from "./claude-calls.js";
import { imageConversation } from "../protocol/images.js";
import { claudeToolName, claudeToolHistory } from "./claude-tool-names.js";
import { claudeUsageEvent, systemPrefixOnly, type ClaudeLimit } from "./claude-usage.js";
import { claudeCliModel } from "./claude-models.js";
import { claudeCliArgs, claudeEnv, claudeMcpCatalog, claudeSystemPrompt, userLine } from "./claude-control.js";
import { ClaudeMessageStream, resultWindows, type ClaudeStreamEnd, type ClaudeTokens } from "./claude-stream.js";
import { choiceBlock, leadingInstructions, markCustomCalls, renderConversation, renderItems, renderSelected, type ClaudeConversation, type ClaudeImages, type ReplayFormat } from "./claude-render.js";
import { compactionCheckpoint, retireScope, releaseRefusalHold } from "./claude-session-registry.js";
import { ClaudeSessionPreserved, sessionKey, type ClaudeLiveModule, type ClaudeLiveOutcome } from "./claude-live-contract.js";
import { telemetry } from "../telemetry.js";
import { claudeReplayBudget, ClaudeReplayBlocked, type ClaudeReplayBudget } from "./claude-replay-budget.js";
import { providerCommand } from "../provider-tool-runtime.js";
import { claudeLiveWarmup } from "./claude-cache-warmup.js";
import { CliContinuityUnavailable, standaloneCliReasons, unidentifiedCliHistory } from "./cli-continuity.js";

export function claudeEffort(config: ProviderConfig | undefined, request: ResponsesRequest): string | undefined {
  const effort = (request.reasoning as { effort?: string } | undefined)?.effort;
  const alias = Object.entries(config?.models || {}).find(([, model]) => model === request.model)?.[0];
  const supported = alias ? config?.modelMetadata?.[alias]?.reasoningEfforts : undefined;
  if (effort === "none" && supported?.length === 0) return;
  if (effort && (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort) || (supported && !supported.includes(effort)))) {
    throw new ProviderError("invalid_request", "Selected Claude model does not support this reasoning effort", 400);
  }
  // Ultra adds Codex-side delegation; Claude itself runs at its top level.
  return effort === "ultra" ? "max" : effort;
}

/** Fast (Codex's priority tier) turns on Claude Code's fast mode; Standard and Flex leave it off. */
export function claudeFastMode(config: ProviderConfig | undefined, request: ResponsesRequest): boolean {
  const tier = request.service_tier;
  if (tier === undefined || tier === null || tier === "auto" || tier === "default") return false;
  // Claude has no flex processing; a Flex request runs as Standard.
  if (tier === "flex") return false;
  if (tier !== "priority" && tier !== "fast") throw new ProviderError("invalid_request", "Claude does not support the requested service tier", 400);
  const alias = Object.entries(config?.models || {}).find(([, model]) => model === request.model)?.[0];
  const tiers = alias ? config?.modelMetadata?.[alias]?.serviceTiers : undefined;
  if (tiers && !tiers.some(option => option.id === "priority")) throw new ProviderError("invalid_request", "Selected Claude model does not offer Fast mode", 400);
  return true;
}

interface Run {
  replayBudget?: ClaudeReplayBudget;
  /** The caller's model alias, for telemetry. */
  alias: string; model: string; effort?: string; fast: boolean; summaryVisible: boolean; requestedEffort?: unknown; format: ReplayFormat;
  tools: OpenAITool[]; choice?: ChatToolSelection; conversation: ClaudeConversation; images: ClaudeImages; retry?: boolean;
  /** The CLI system prompt, and how many translated messages it took from the history. */
  systemPrompt: string; leading: number;
  /** The live session key's first 8 hex for this thread, or absent when the request has none. */
  threadKey?: string;
}
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const credentialRecovery = (error: unknown): ProviderError | undefined =>
  error instanceof ProviderError && error.upstream?.code === "authentication_failed" && error.upstream.reason === "upstream_rejected" ? error : undefined;
/** Wait before one fresh CLI attempt without leaving an uncancellable timer behind. */
async function credentialBackoff(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise(resolve => {
    const timer = setTimeout(() => done(true), 2000);
    const abort = () => done(false);
    const done = (value: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(value); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
// Codex owns these requests' history shape, so they never join or seed a live session.
const oneShotKinds = new Set<unknown>(["compaction", "prewarm", "memory"]);
const liveModules = new Map<string, Promise<ClaudeLiveModule | undefined>>(); const unavailable = new Set<string>();
/** B2's module ships separately; the variable specifier keeps this build independent of it. */
function loadLive(specifier: string): Promise<ClaudeLiveModule | undefined> {
  let module = liveModules.get(specifier);
  if (!module) {
    module = import(new URL(specifier, import.meta.url).href).then(value => typeof (value as Partial<ClaudeLiveModule>)?.claudeLive === "function" ? value as ClaudeLiveModule : undefined, () => undefined);
    liveModules.set(specifier, module);
  }
  return module;
}

export class ClaudeSubscription implements Provider {
  constructor(private readonly config?: ProviderConfig, private readonly onUsage?: (limit: ClaudeLimit) => Promise<void>,
    private readonly onContextWindow?: (model: string, contextWindow: number) => void, private readonly liveModule = "./claude-live.js") {}
  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    const budget = claudeReplayBudget(this.scope(), providerConversationId(context), claudeCliModel(request.model), Buffer.byteLength(JSON.stringify(request.input)));
    const finishActivity = context.requestKind === "compaction" ? () => {} : budget.track();
    try { yield* this.inferWithBudget(request, signal, context, budget); }
    finally { finishActivity(); }
  }
  private async *inferWithBudget(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext, budget: ClaudeReplayBudget): AsyncGenerator<InferenceEvent> {
    const conversationId = providerConversationId(context);
    const normalized = responsesToChatRequest(request, { reasoningSummaryMetadata: true });
    const choice = normalized.tool_choice;
    // The catalog stays whole for forced choices: a changed tool list breaks the prompt cache.
    const tools = choice === "none" ? [] : normalized.tools || [];
    if (new Set(tools.map(claudeToolName)).size !== tools.length) throw new ProviderError("invalid_request", "Caller tool identities collide in Claude's native namespace", 400);
    const settings = claudeSessionSettings(this.config || {});
    const history = markCustomCalls(claudeToolHistory(normalized.messages, normalized.tools || []), normalized.tools || []);
    // The caller's leading system and developer content is the CLI's system prompt, as in Claude Code; the rest stays history.
    const leading = leadingInstructions(history);
    const { conversation, images } = imageConversation(history.slice(leading));
    if (settings.mode === "live" && !conversationId && !oneShotKinds.has(context.requestKind) && unidentifiedCliHistory(conversation)) throw new CliContinuityUnavailable("Claude", "conversation_id_required");
    const run: Run = { alias: request.model, model: claudeCliModel(request.model), effort: claudeEffort(this.config, request), fast: claudeFastMode(this.config, request),
      summaryVisible: (request.reasoning as { summary?: string } | undefined)?.summary !== "none", requestedEffort: (request.reasoning as { effort?: string } | undefined)?.effort,
      format: settings.replayFormat, tools, choice, conversation, images, systemPrompt: claudeSystemPrompt(history.slice(0, leading).map(message => message.content ?? "")), leading,
      // The same key the live registry derives, so one thread's one-shot and live events line up.
      ...(conversationId ? { threadKey: sessionKey(this.scope(), conversationId).slice(0, 8) } : {}) };
    {
      run.replayBudget = { beforeRequest: mode => { if (context.requestKind !== "compaction") budget.beforeRequest(mode); }, record: (tokens, outcome) => {
        if (context.requestKind !== "compaction") budget.record(tokens, { cancelled: context.callerCancelled?.(), refused: outcome?.refused });
        const measured = tokens?.input !== undefined && tokens.cacheRead !== undefined && tokens.cacheWrite !== undefined;
        context.observeCacheUsage?.({ ...(measured ? { inputTokens: tokens.input! + tokens.cacheRead! + tokens.cacheWrite! } : {}),
          ...(!measured ? { inputTokensLowerBound: [tokens?.input, tokens?.cacheRead, tokens?.cacheWrite].reduce<number>((sum, value) => sum + (value ?? 0), 0) } : {}),
          cachedTokens: tokens?.cacheRead, cacheWriteTokens: tokens?.cacheWrite });
      } };
    }
    // Switching to replay ends this provider's parked sessions now instead of when their park timers fire.
    if (settings.mode !== "live") retireScope(this.scope(), "mode_replay");
    let completed = context.requestKind === "compaction" && conversationId ? compactionCheckpoint(this.scope(), conversationId) : undefined;
    const markCompleted = (event: InferenceEvent) => {
      if (event.type === "done" && !signal.aborted && event.interrupted !== true && completed) { const complete = completed; completed = undefined; complete(); }
    };
    let recovery: ProviderError | undefined;
    let recovering = false;
    let recoveryReported = false;
    // Authentication recovery cannot repeat work the caller saw in any form.
    let authVisible = false;
    const beginRecovery = async (error: unknown): Promise<boolean> => {
      const eligible = credentialRecovery(error);
      if (!eligible || recovery) return false;
      recovery = eligible; recovering = true;
      telemetry("claude_credential_recovery", { reason: eligible.upstream?.reason, attempt: 2, outcome: "attempted" });
      if (await credentialBackoff(signal)) return true;
      telemetry("claude_credential_recovery", { reason: eligible.upstream?.reason, attempt: 2, outcome: "cancelled" });
      throw cancelled();
    };
    const markRecoveryDone = (event: InferenceEvent) => {
      if (!recoveryReported && recovering && event.type === "done" && !signal.aborted && event.interrupted !== true) {
        recoveryReported = true;
        telemetry("claude_credential_recovery", { reason: recovery?.upstream?.reason, attempt: 2, outcome: "recovered" });
      }
    };
    if (settings.mode === "live" && conversationId && !oneShotKinds.has(context.requestKind)) {
      const live = await this.live(run, request, context, settings, signal, conversationId);
      completed = live?.complete;
      if (!live || live.outcome.kind === "fallback" && !standaloneCliReasons.has(live.outcome.reason)) {
        const reason = live?.outcome.kind === "fallback" ? live.outcome.reason : "unavailable";
        telemetry("claude_session", { outcome: "blocked", missReason: reason, threadKey: run.threadKey });
        throw new CliContinuityUnavailable("Claude", reason);
      }
      if (live?.outcome.kind === "stream") {
        try { for await (const event of live.outcome.events) {
          authVisible = true;
          markCompleted(event); yield event;
        } return; }
        catch (error) {
          if (providerRefusal(error)) releaseRefusalHold(this.scope(), conversationId);
          if (!authVisible && await beginRecovery(error)) {
            // A failed live session synchronously removes itself from the registry; the
            // cancellable backoff also gives its killed CLI time to exit before this spawn.
          } else {
          // An accepted live request never silently changes to a full-history one-shot.
          if (signal.aborted || !(error instanceof ProviderError) || error.code !== "cli_failed") throw error;
          telemetry("claude_session", { outcome: "blocked", missReason: "stream_failed", threadKey: run.threadKey });
          throw new CliContinuityUnavailable("Claude", "stream_failed");
          }
        }
      }
    }
    for (;;) {
      try {
        for await (const event of this.oneShot(run, signal)) {
          authVisible = true;
          markCompleted(event); markRecoveryDone(event); yield event;
        }
        return;
      } catch (error) {
        // A refusal stays a refusal when the caller also cancelled, or the cache stop would stop counting it.
        if (providerRefusal(error)) throw error;
        if (signal.aborted || error instanceof ProviderError && error.code === "cancelled") {
          if (recovering && !recoveryReported) {
            recoveryReported = true;
            telemetry("claude_credential_recovery", { reason: recovery?.upstream?.reason, attempt: 2, outcome: "cancelled" });
          }
          throw cancelled();
        }
        if (!authVisible && !recovery && await beginRecovery(error)) continue;
        if (error instanceof ProviderError && error.upstream?.code === "forced_tool_mismatch") throw new CliContinuityUnavailable("Claude", "forced_tool_mismatch");
        if (recovering && !recoveryReported) {
          recoveryReported = true;
          telemetry("claude_credential_recovery", { reason: recovery?.upstream?.reason, attempt: 2, outcome: "failed" });
          // A second native 401 is the same final authentication failure that started recovery.
          if (credentialRecovery(error)) throw recovery!;
        }
        throw error;
      }
    }
  }

  /** The provider half of a live session key; the thread's half is whatever the caller added. */
  private scope(): string { return `${this.config?.id ?? "claude"}` + `\0` + `${this.config?.authDirectory ?? ""}`; }

  private async live(run: Run, request: ResponsesRequest, context: InferenceContext, settings: { max: number; parkMinutes: number; warmup: number }, signal: AbortSignal, conversationId: string): Promise<{ outcome: ClaudeLiveOutcome; complete: () => void } | undefined> {
    const module = await loadLive(this.liveModule);
    if (!module) {
      if (!unavailable.has(this.liveModule)) { unavailable.add(this.liveModule); telemetry("claude_session", { outcome: "fallback", missReason: "unavailable", threadKey: run.threadKey }); }
      return;
    }
    const { model, effort, fast, summaryVisible, tools, conversation, images, format, systemPrompt, leading } = run; const mcpCatalog = claudeMcpCatalog(tools);
    let outcome: ClaudeLiveOutcome;
    let complete = () => {};
    try {
      const live = module.claudeLive({ max: settings.max, parkMinutes: settings.parkMinutes, warmup: claudeLiveWarmup(this.config, conversation, settings.warmup) });
      complete = () => live.complete?.(this.scope(), conversationId);
      outcome = await live.attach({
        replayBudget: run.replayBudget,
        scope: this.scope(), threadId: conversationId, windowId: context.windowId, turnId: context.turnId,
        callerHistoryReplacement: context.clientProtocol === "messages" && !context.threadId && !!context.sessionId
          && (request.client_metadata as { session_id?: unknown } | undefined)?.session_id === context.sessionId,
        model, effort, fast, summaryVisible, instructionsDigest: digest(systemPrompt), leading,
        toolsDigest: digest(JSON.stringify(mcpCatalog)), tools, choice: run.choice, request, conversation, images,
        // Thinking display is fixed for a session's lifetime; summaries are hidden locally instead.
        spawn: { args: (mcpPath, systemPath) => claudeCliArgs({ mcpPath, systemPath, model, effort, fast, thinkingDisplay: true, live: true }),
          env: claudeEnv(this.config?.authDirectory, true, run.requestedEffort, mcpCatalog), mcpCatalog, systemPrompt },
        render: from => from === 0 ? renderConversation(conversation, images, format) : renderItems(conversation, images, from, format),
        renderAt: indices => renderSelected(conversation, images, indices, format),
        newStream: () => new ClaudeMessageStream({ tools, summaryVisible }),
        onUsage: async limit => { await this.onUsage?.(limit).catch(() => {}); },
        onContextWindow: (name, window) => this.onContextWindow?.(name, window),
      }, signal);
      if (outcome.kind === "fallback") telemetry("claude_session", { outcome: "fallback", missReason: outcome.reason, threadKey: run.threadKey });
      return { outcome, complete };
    } catch (error) {
      // Startup failures can fall back; cancellation and the replay safety stop remain final.
      if (error instanceof ClaudeReplayBlocked || error instanceof ClaudeSessionPreserved || signal.aborted || (error instanceof ProviderError && error.code === "cancelled")) throw signal.aborted ? cancelled() : error;
      outcome = { kind: "fallback", reason: "spawn_failed" };
    }
    telemetry("claude_session", { outcome: "fallback", missReason: outcome.reason, threadKey: run.threadKey });
    return { outcome, complete };
  }

  private async *oneShot(run: Run, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    if (signal.aborted) throw cancelled();
    run.replayBudget?.beforeRequest("oneshot");
    const directory = await mkdtemp(join(tmpdir(), "gateway-claude-"));
    const catalogPath = join(directory, "tools.json"); const mcpPath = join(directory, "mcp.json"); const systemPath = join(directory, "system.md");
    const catalog = claudeMcpCatalog(run.tools);
    await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 }); await writeFile(systemPath, run.systemPrompt, { mode: 0o600 });
    await writeFile(mcpPath, JSON.stringify({ mcpServers: run.tools.length ? { gateway: { command: process.execPath, args: [fileURLToPath(new URL("./claude-tools.js", import.meta.url)), catalogPath], alwaysLoad: true } } : {} }), { mode: 0o600 });
    const command = await providerCommand("claude");
    const child = spawn(command, claudeCliArgs({ mcpPath, systemPath, model: run.model, effort: run.effort, fast: run.fast, thinkingDisplay: run.summaryVisible }),
      { cwd: directory, stdio: ["pipe", "pipe", "pipe"], env: claudeEnv(this.config?.authDirectory, false, run.requestedEffort, catalog) });
    // Fast waits for the result: only it reports the tier served, since a refused or throttled fast request
    // drops to standard speed without a stream line. The result follows end_turn within milliseconds.
    const stream = new ClaudeMessageStream({ tools: run.tools, summaryVisible: run.summaryVisible, endTurn: !run.fast });
    let failure: Error | undefined; let refused = false; let exitCode: number | null = null; let fastState: string | undefined; let interrupted = false; let settle: NodeJS.Timeout | undefined;
    let end: ClaudeStreamEnd | undefined; let resultSubtype: string | undefined; let resultError = false; let tokens: ClaudeTokens | undefined; const began = Date.now();
    // Report the tier Claude actually served: Fast only while fast mode stayed on.
    const served = (): { serviceTier?: PublicServiceTier } => run.fast ? { serviceTier: fastState === "on" ? "priority" : "default" } : {};
    const running = () => child.exitCode === null && child.signalCode === null;
    // One-shot output has no later use: stop at once. Without a detached group, launchd still reaps a CLI the gateway leaves behind.
    const kill = () => { if (running()) child.kill("SIGKILL"); };
    // A caller that disconnects after a finished text turn's done (Codex does at once) interrupts nothing.
    const cancel = () => { if (running() && end?.kind !== "end_turn") interrupted = true; kill(); };
    child.on("error", error => { failure = error; }); child.on("exit", code => { exitCode = code; });
    child.stderr.resume(); child.stdin.on("error", error => { failure = error; });
    signal.addEventListener("abort", cancel, { once: true });
    const lines = createInterface({ input: child.stdout });
    try {
      if (signal.aborted) cancel();
      const forced = choiceBlock(run.choice, run.tools);
      // One message, then EOF: the CLI answers that turn and exits.
      child.stdin.end(userLine([...renderConversation(run.conversation, run.images, run.format), ...(forced ? [forced] : [])]));
      for await (const line of lines) {
        if (line.length > 8 * 1024 * 1024) throw new ProviderError("output_too_large", "Provider output exceeds 8 MiB");
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        // After a finished text turn only its rate limit and the result's context windows are read, until the timer stops the CLI.
        if (end) {
          const limit = claudeUsageEvent(message); if (limit) await this.onUsage?.(limit).catch(() => {});
          if (message.type !== "result") continue;
          for (const window of resultWindows(message)) this.onContextWindow?.(window.model, window.contextWindow);
          break;
        }
        if (message.type === "result") { resultSubtype = String(message.subtype); resultError = message.is_error === true; }
        const step = stream.accept(message);
        // Stop before the CLI can act on complete calls; the pending MCP calls never get an answer.
        if (step.end?.kind === "tool_use") kill();
        if (step.fastState) fastState = step.fastState;
        // Usage persistence is supplementary; a disk error cannot replace an inference outcome.
        if (step.limit) await this.onUsage?.(step.limit).catch(() => {});
        for (const window of step.contextWindows || []) this.onContextWindow?.(window.model, window.contextWindow);
        for (const event of step.events) yield event;
        if (!step.end) continue;
        end = step.end; if (end.kind !== "end_turn") break;
        // The turn is complete at its end_turn delta: answer now. The CLI's result can follow a post-turn summary seconds later.
        tokens = end.tokens; validateForcedChoice([], run.choice);
        settle = setTimeout(kill, 100); yield { type: "done", usage: end.usage, accounting: { cacheWriteTokens: end.tokens.cacheWrite }, ...served() };
      }
      if (end?.kind === "end_turn") return;
      if (signal.aborted) throw cancelled();
      if (!end || (end.kind === "result" && failure)) throw new ProviderError("cli_failed", `Claude CLI did not complete${exitCode !== null ? ` (exit ${exitCode})` : ""}; run gateway doctor`);
      tokens = end.tokens;
      const calls = end.kind === "tool_use" ? end.calls : [];
      validateForcedChoice(calls, run.choice);
      for (const call of calls) yield { type: "tool", call };
      yield { type: "done", usage: end.usage, accounting: { cacheWriteTokens: end.tokens.cacheWrite }, ...served() };
    } catch (error) {
      refused = providerRefusal(error);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel); lines.close(); clearTimeout(settle);
      // After a result the CLI exits on its own; anything else is stopped now, including the post-turn summary after end_turn.
      if (resultSubtype && !signal.aborted) { const timer = setTimeout(kill, 500); timer.unref(); child.once("exit", () => clearTimeout(timer)); } else kill();
      const observed = tokens ?? stream.observedTokens;
      run.replayBudget?.record(observed, { refused });
      telemetry("claude_cli", { mode: "oneshot", model: run.alias, effort: run.effort, fast: run.fast ? fastState || "unknown" : undefined, durationMs: Date.now() - began,
        result: end?.kind === "tool_use" || end?.kind === "end_turn" ? end.kind : resultSubtype ?? "none", isError: resultError, exitCode, aborted: signal.aborted && end?.kind !== "end_turn", interrupted, spawnFailed: !!failure, retry: run.retry,
        toolCalls: end?.kind === "tool_use" ? end.calls.length : 0, inputTokens: observed?.input, cacheReadTokens: observed?.cacheRead, cacheWriteTokens: observed?.cacheWrite, outputTokens: observed?.output,
        threadKey: run.threadKey, systemPrefixOnly: systemPrefixOnly(observed?.cacheRead, observed?.cacheWrite) });
      await rm(directory, { recursive: true, force: true });
    }
  }
}
