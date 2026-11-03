import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceEvent, OpenAITool, OpenAIToolCall } from "../protocol/types.js";
import { reportException } from "../error-report.js";
import { nativeClaudeCalls } from "./claude-calls.js";
import type { ClaudeMcpTool } from "./claude-control.js";
import { echoDigests, type LedgerState } from "./claude-ledger.js";
import { CliContinuityUnavailable } from "./cli-continuity.js";
import { AcpConnection, AcpError, grokLiveArgs, grokPermission, grokProfile } from "./grok-acp.js";
import { GrokMcpServer } from "./grok-mcp-http.js";
import { grokStopReason, type GrokStopReason } from "./grok-reasons.js";
import { grokFailure, grokUsage, type GrokTokens } from "./grok-stream.js";
import { ProviderError } from "./provider.js";

export type GrokSessionState = "starting" | "generating" | "awaiting_outputs" | "turn_done" | "closed";
export type GrokSessionEnd = "reaped" | "crashed" | "closed";

/** Bounds in milliseconds; tests shorten them. `parkMs` and `toolWaitMs` override the configured timers when set. */
export const grokLimits: { startMs: number; callQuietMs: number; parkMs?: number; toolWaitMs?: number; maxDenied: number } = { startMs: 30000, callQuietMs: 400, maxDenied: 25 };
/** Test seam: called synchronously just before startup begins acquiring `stage`, so a test can cancel exactly there. */
export const grokTestHooks: { boot?: (stage: "directory" | "listen") => void } = {};
const maxUnattended = 1024 * 1024;
/** `session/update` kinds that only describe the session's setup and prove no inference: everything else (also an unknown kind) counts as observed. */
const setupUpdates = new Set(["available_commands_update", "current_mode_update", "config_option_update"]);
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The assistant text a replayed history holds for a turn whose reasoning summary was turned into assistant text, if it had one. */
const replayed = (text: string, thought: string, thoughtFirst: boolean): string | undefined => thought ? thoughtFirst ? thought + text : text + thought : undefined;

/** Maps an ACP or process failure to the fixed provider classes; provider prose is never forwarded. */
export function grokAcpFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof AcpError) {
    const data = object(error.data);
    const signedOut = error.code === -32000 && /auth|sign.?in|log.?in|credential/i.test(error.message);
    return grokFailure({ type: "result", is_error: true, error_message: error.message, error_code: signedOut ? "authentication_failed" : data.code }, "grok.result");
  }
  return new ProviderError("cli_failed", "Grok CLI failed", 502);
}

/**
 * A failure of a live session after its prompt was sent is final: the turn may already have spent allowance, so a retry
 * must not start another process. Sign-in (401) and cancellation (499) keep their own meaning.
 */
export function grokLiveFailure(error: unknown): unknown {
  if (!(error instanceof ProviderError) || error instanceof CliContinuityUnavailable || error.status === 401 || error.status === 499) return error;
  return new CliContinuityUnavailable("Grok", "session_dead");
}

export interface GrokSessionOptions {
  key: string; fingerprint: string; providerId: string; model: string; effort?: string;
  command: string; system: string; builtinTools: readonly string[];
  /** The caller's tools, for naming a call; `catalog` is the same set as Grok lists it. */
  tools: OpenAITool[]; catalog: ClaudeMcpTool[];
  /** The CLI's environment; the argument is a private empty catalog for the managed stdio `gateway` entry in config.toml. */
  env(catalogPath: string): NodeJS.ProcessEnv;
  /** Called once when a started session ends; `close()` settles after it does. */
  onClose(session: GrokLiveSession, outcome: GrokSessionEnd, reason?: string): void | Promise<void>;
}

/** One request served by the session. */
export interface GrokTurn {
  /** A new user prompt, or the caller's outputs by call id for exactly the calls the last request handed over. */
  begin: { prompt: string } | { outputs: Map<string, string> };
  /** Ledger digests of this request's canonical input. */
  prefix: string[];
  signal: AbortSignal;
  summaryVisible: boolean;
  /** Checks the calls this request returns (a forced or required tool choice). */
  validate?(calls: OpenAIToolCall[]): void;
  onEnd(outcome: "ended" | "interrupted" | "failed", tokens?: GrokTokens): void;
}
/** `tokens` is absent when the CLI reported no usage for the prompt. */
type Item = { k: "text"; text: string } | { k: "reasoning"; text: string } | { k: "call"; call: OpenAIToolCall } | { k: "stop"; reason: GrokStopReason; tokens?: GrokTokens };
interface Attached { live: GrokTurn; queue: Item[]; wake?: () => void; error?: Error; onAbort: () => void }

/**
 * One live Grok CLI process (`grok agent stdio`, ACP) and session for one conversation. A caller tool call is a held
 * `tools/call` on the session's loopback MCP endpoint; the next request answers it. Between requests nothing may
 * happen: output without a prompt, a tool call nobody waits for, or an ended prompt with calls pending closes the
 * session. Every permission request is answered by the gateway; only the caller's own gateway tools are allowed.
 */
export class GrokLiveSession {
  state: GrokSessionState = "starting";
  readonly key: string; readonly fingerprint: string; readonly effort?: string;
  ledger: LedgerState = { items: [] }; pending: string[] = [];
  /**
   * The same turn as a client that replays reasoning summaries as assistant text sees it (the server does so unless the
   * provider asks it to preserve summaries). Set only for a turn that streamed reasoning; either form continues the session.
   */
  altLedger?: LedgerState;
  lastUse = Date.now(); toolCalls = 0; allowed = 0; denied = 0;
  /**
   * True once anything showed that inference may have happened (and been charged): a turn finished, any `session/update` that is
   * not a pure setup notification (message or thought chunk, tool call or its update, usage, session info), an MCP `tools/call`
   * or a permission request. Only a session that observed nothing may be released after a sign-in failure.
   */
  observed = false;
  end?: { outcome: GrokSessionEnd; reason?: string };
  private conn?: AcpConnection; private server?: GrokMcpServer; private directory?: string; private sessionId = "";
  private readonly names: Set<string>;
  private readonly held = new Map<string, { resolve(text: string): void; reject(error: Error): void }>();
  private attached?: Attached; private promptActive = false; private unattended: Item[] = []; private unattendedBytes = 0;
  private timer?: NodeJS.Timeout; private parkMs = 30 * 60000; private toolWaitMs = 25 * 60000;
  private closing?: Promise<void>; private stopping?: Promise<void>; private stopped = false; private started = false; private retiring?: string;
  /** Settles when startup no longer acquires anything (it finished or gave up); teardown waits for it. */
  private booted: Promise<void> = Promise.resolve();
  private constructor(private readonly options: GrokSessionOptions) {
    this.key = options.key; this.fingerprint = options.fingerprint; this.effort = options.effort; this.names = new Set(options.catalog.map(tool => tool.name));
  }

  get pid(): number | undefined { return this.conn?.pid; }
  get providerId(): string { return this.options.providerId; }
  get model(): string { return this.options.model; }
  /** Kills the process group at once and synchronously (process exit); the normal close does the rest. */
  kill(): void { this.conn?.kill(); }
  /** Settles once a closing session's process is gone and its folder removed. */
  get finished(): Promise<void> { return this.closing ?? Promise.resolve(); }

  /** Spawns the CLI, opens the session and lists the endpoint; a failure leaves no process, server or folder behind. */
  static async start(options: GrokSessionOptions, signal: AbortSignal): Promise<GrokLiveSession> {
    const session = new GrokLiveSession(options);
    const abort = () => { session.stop().catch(error => reportException(error, "grok_live_stop")); };
    let settle = () => {};
    session.booted = new Promise<void>(resolve => { settle = resolve; });
    signal.addEventListener("abort", abort, { once: true });
    try {
      try { if (signal.aborted) throw cancelled(); await session.boot(); } finally { settle(); }
      if (signal.aborted || session.stopped) throw cancelled();
      session.state = "turn_done"; session.started = true;
      return session;
    } catch (error) {
      await (session.closing ?? session.stop());
      if (signal.aborted) throw cancelled();
      throw grokAcpFailure(error);
    } finally { signal.removeEventListener("abort", abort); }
  }

  /** Throws once teardown was requested, so startup stops acquiring resources; `stop()` releases what it already holds. */
  private checkStopped(): void { if (this.stopped) throw cancelled(); }

  private async boot(): Promise<void> {
    const { options } = this;
    grokTestHooks.boot?.("directory");
    const directory = this.directory = await mkdtemp(join(tmpdir(), "gateway-grok-live-"));
    this.checkStopped();
    const work = join(directory, "work"); const profile = join(directory, "profile.md"); const catalogPath = join(directory, "tools.json");
    await mkdir(work, { mode: 0o700 });
    await writeFile(profile, grokProfile(options.system, options.builtinTools), { mode: 0o600 });
    await writeFile(catalogPath, "[]", { mode: 0o600 });
    this.checkStopped();
    this.server = new GrokMcpServer(options.catalog, { call: (name, args, abandoned) => this.hostCall(name, args, abandoned), seen: () => { this.observed = true; } });
    grokTestHooks.boot?.("listen");
    const url = await this.server.listen();
    this.checkStopped();
    this.conn = new AcpConnection({ command: options.command, args: grokLiveArgs(profile, options.model, options.effort), cwd: work,
      env: { ...options.env(catalogPath), GROK_TURN_SUMMARY: "false", GROK_TITLE_REFRESH: "false" } }, {
      notification: (method, params) => this.route(method, params),
      request: (method, params) => this.answer(method, params),
      closed: (_reason, error) => this.crash(error ?? new ProviderError("cli_failed", "Grok CLI closed before completion", 502), error ? "invalid_frame" : "exited"),
    });
    await this.conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, grokLimits.startMs);
    this.checkStopped();
    const created = await this.conn.request("session/new", { cwd: work, mcpServers: [{ type: "http", name: "gateway", url, headers: [] }] }, grokLimits.startMs);
    this.checkStopped();
    if (typeof created.sessionId !== "string" || !created.sessionId) throw new ProviderError("cli_failed", "Grok did not open a session", 502);
    this.sessionId = created.sessionId;
  }

  /** Sets how long the session waits when parked and when it waits for tool outputs. */
  timers(parkMs: number, toolWaitMs: number): void { this.parkMs = parkMs; this.toolWaitMs = toolWaitMs; if (this.state !== "closed" && this.state !== "starting") this.arm(); }

  private arm(): void {
    clearTimeout(this.timer);
    const waiting = this.state === "awaiting_outputs"; const park = grokLimits.parkMs ?? this.parkMs; const toolWait = grokLimits.toolWaitMs ?? this.toolWaitMs;
    this.timer = setTimeout(() => { if (this.state === "generating") this.arm(); else void this.close("reaped", waiting ? "tool_wait_expired" : "parked"); }, waiting ? Math.min(toolWait, park) : park);
    this.timer.unref();
  }

  /** Closes now, or when the running request ends. */
  retire(reason: string): Promise<void> {
    if (this.state === "generating") { this.retiring = reason; return Promise.resolve(); }
    return this.close("closed", reason);
  }

  /** Attaches one request and starts it. The events end with `done`, or throw; a closed session fails at once. */
  run(live: GrokTurn): AsyncIterable<InferenceEvent> {
    if (this.state === "closed") return (async function* (): AsyncGenerator<InferenceEvent> { throw new CliContinuityUnavailable("Grok", "session_dead"); })();
    const attached: Attached = { live, queue: [], onAbort: () => this.abort(attached) };
    this.attached = attached; this.state = "generating"; this.arm();
    live.signal.addEventListener("abort", attached.onAbort, { once: true });
    return this.events(attached);
  }

  private async *events(attached: Attached): AsyncGenerator<InferenceEvent> {
    const { live } = attached; const calls: OpenAIToolCall[] = []; let text = "";
    // What the writer turns into assistant text if the client replays the summary: one item, placed where reasoning began.
    let thought = ""; let thoughtFirst = false;
    try {
      if (live.signal.aborted) throw cancelled();
      this.begin(attached);
      for (;;) {
        // After the first call, a quiet moment means Grok made every parallel call it was going to make.
        const item = await this.next(attached, calls.length ? grokLimits.callQuietMs : undefined);
        if (!item) break;
        if (item.k === "text") { text += item.text; yield { type: "text", text: item.text }; }
        else if (item.k === "reasoning") { if (live.summaryVisible) { if (!thought) thoughtFirst = !text; thought += item.text; yield { type: "reasoning", text: item.text }; } }
        else if (item.k === "call") calls.push(item.call);
        else {
          if (calls.length) throw new ProviderError("invalid_stream", "Grok ended its turn with tool calls waiting", 502, { code: "stop_with_calls", event: "grok.result" });
          if (!["end_turn", "max_tokens"].includes(item.reason)) throw new ProviderError("inference_failed", "Grok inference did not complete", 502, { code: item.reason, event: "grok.result" });
          live.validate?.(calls);
          this.finish(attached, text, calls, item.tokens, replayed(text, thought, thoughtFirst));
          yield { type: "done", usage: grokUsage(item.tokens ?? { input: 0, output: 0 }), ...(item.reason === "max_tokens" ? { stopReason: "max_tokens" as const } : {}) };
          return;
        }
        if (attached.error) throw attached.error;
      }
      live.validate?.(calls);
      this.finish(attached, text, calls, undefined, replayed(text, thought, thoughtFirst));
      for (const call of calls) yield { type: "tool", call };
      yield { type: "done", usage: grokUsage({ input: 0, output: 0 }) };
    } catch (error) { throw grokLiveFailure(this.failed(attached, error)); }
    finally { if (this.attached === attached) this.abort(attached); }
  }

  private begin(attached: Attached): void {
    const { begin } = attached.live;
    attached.queue.push(...this.unattended.splice(0)); this.unattendedBytes = 0;
    if (!("outputs" in begin)) { this.sendPrompt(begin.prompt); return; }
    // Every held call is answered, or none: a call that is gone means the session cannot continue.
    if (![...begin.outputs.keys()].every(id => this.held.has(id)) || begin.outputs.size !== this.pending.length) throw new ProviderError("cli_failed", "Grok no longer holds the pending tool calls", 502, { code: "tool_request_missing", event: "grok.tool_use" });
    this.pending = [];
    for (const [id, text] of begin.outputs) { const held = this.held.get(id)!; this.held.delete(id); held.resolve(text); }
  }

  private sendPrompt(text: string): void {
    this.promptActive = true;
    void this.conn!.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }).then(
      result => this.promptEnded(result), error => this.promptFailed(error));
  }

  private promptEnded(result: Record<string, unknown>): void {
    this.promptActive = false;
    if (this.state === "closed") return;
    this.observed = true;
    const usage = object(result.usage ?? object(result._meta).usage);
    const input = count(usage.inputTokens ?? usage.input_tokens); const output = count(usage.outputTokens ?? usage.output_tokens);
    const cacheRead = count(usage.cachedReadTokens ?? usage.cached_read_tokens ?? usage.cache_read_input_tokens);
    const item: Item = { k: "stop", reason: grokStopReason(result.stopReason), ...(input === undefined && output === undefined ? {} : { tokens: { input: input ?? 0, output: output ?? 0, ...(cacheRead === undefined ? {} : { cacheRead }) } }) };
    if (!this.attached) return this.violation(new ProviderError("invalid_stream", "Grok ended its turn while tool calls waited", 502, { code: "unattended_stop", event: "grok.result" }), "unattended_stop");
    this.attached.queue.push(item); this.attached.wake?.();
  }

  private promptFailed(error: unknown): void {
    this.promptActive = false;
    if (this.state === "closed" || this.stopped) return;
    const mapped = grokAcpFailure(error);
    if (this.attached) { this.attached.error ??= mapped; this.attached.wake?.(); }
    void this.close("crashed", mapped.upstream?.code ?? mapped.code);
  }

  private next(attached: Attached, timeoutMs?: number): Promise<Item | undefined> {
    if (attached.error) return Promise.reject(attached.error);
    if (attached.queue.length) return Promise.resolve(attached.queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => { attached.wake = undefined; resolve(undefined); }, timeoutMs);
      // A wake with nothing to read is ignored: only an item, a failure or the timeout ends the wait.
      attached.wake = () => {
        if (!attached.error && !attached.queue.length) return;
        clearTimeout(timer); attached.wake = undefined;
        if (attached.error) reject(attached.error); else resolve(attached.queue.shift()!);
      };
    });
  }

  private finish(attached: Attached, text: string, calls: OpenAIToolCall[], tokens: GrokTokens | undefined, replayedText?: string): void {
    const { live } = attached;
    this.detach(attached); this.observed = true;
    this.ledger = { items: [...live.prefix, ...echoDigests(text, calls)] };
    this.altLedger = replayedText === undefined ? undefined : { items: [...live.prefix, ...echoDigests(replayedText, calls)] };
    this.pending = calls.map(call => call.id); this.state = calls.length ? "awaiting_outputs" : "turn_done";
    this.arm();
    live.onEnd("ended", tokens);
    if (this.retiring) void this.close("closed", this.retiring);
  }

  /** Cancels the request. The half-answered prompt cannot be resumed, so the process goes. */
  private abort(attached: Attached): void {
    if (this.attached !== attached) return;
    this.detach(attached); attached.error = cancelled(); attached.wake?.();
    void this.close("closed", "interrupted").then(() => attached.live.onEnd("interrupted"));
  }

  private failed(attached: Attached, error: unknown): unknown {
    if (this.attached === attached) {
      this.detach(attached); attached.live.onEnd("failed");
      void this.close("crashed", error instanceof ProviderError ? error.upstream?.code ?? error.code : "failed");
    }
    return error;
  }

  private detach(attached: Attached): void {
    if (this.attached === attached) this.attached = undefined;
    attached.live.signal.removeEventListener("abort", attached.onAbort);
    this.lastUse = Date.now();
  }

  /** Streamed output of the prompt in flight. Text with no prompt in flight is the CLI acting on its own. */
  private route(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return;
    const update = object(params.update); const kind = update.sessionUpdate; const content = object(update.content);
    // Any update but a pure setup notification may come from a model that ran, so it counts, whatever its session or content.
    if (typeof kind !== "string" || !setupUpdates.has(kind)) this.observed = true;
    if (this.state === "closed" || params.sessionId !== this.sessionId) return;
    if ((kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") || content.type !== "text" || typeof content.text !== "string" || !content.text) return;
    const item: Item = kind === "agent_message_chunk" ? { k: "text", text: content.text } : { k: "reasoning", text: content.text };
    if (this.attached) { this.attached.queue.push(item); this.attached.wake?.(); return; }
    if (!this.promptActive) return this.violation(new ProviderError("invalid_stream", "Grok produced output outside a request", 502, { code: "unattended_output", event: "grok.assistant" }), "unattended_output");
    // The prompt is still running while its calls wait: a late chunk belongs to the next request's stream.
    if (item.k === "reasoning") return;
    this.unattendedBytes += content.text.length; this.unattended.push(item);
    if (this.unattendedBytes > maxUnattended) this.violation(new ProviderError("output_too_large", "Grok output backlog exceeds its limit", 502), "backlog");
  }

  /** Agent-to-client requests: permissions only. */
  private answer(method: string, params: Record<string, unknown>): unknown {
    if (method !== "session/request_permission") throw new AcpError(-32601, "Method not found");
    this.observed = true; // The agent decided to act: a model ran.
    const decision = params.sessionId === this.sessionId && this.state !== "closed" ? grokPermission(params, this.names) : { allowed: false, result: { outcome: { outcome: "cancelled" } } };
    if (decision.allowed) this.allowed++;
    else if (++this.denied > grokLimits.maxDenied) this.violation(new ProviderError("invalid_tool_call", "Grok kept requesting tools the gateway does not offer", 502, { code: "permission_denied_limit", event: "grok.tool_use" }), "permission_denied_limit");
    return decision.result;
  }

  /** A `tools/call` on the endpoint: it becomes the caller's tool call and is answered by a later request. */
  private hostCall(name: string, args: Record<string, unknown>, abandoned: AbortSignal): Promise<string> {
    this.observed = true; // A tool call, announced or not, came from a model that ran.
    if (this.state === "closed") return Promise.reject(new Error("closed"));
    const attached = this.attached;
    const refuse = (error: ProviderError, reason: string) => { this.violation(error, reason); return Promise.reject(error); };
    if (!attached || !this.promptActive) return refuse(new ProviderError("invalid_tool_call", "Grok called a tool nobody is waiting for", 502, { code: "unannounced_tool", event: "grok.tool_use" }), "unannounced_tool");
    let call: OpenAIToolCall;
    try { call = nativeClaudeCalls([{ id: `call_${randomUUID().replace(/-/g, "")}`, name, input: args }], this.options.tools)[0]; }
    catch (error) { return refuse(error instanceof ProviderError ? error : new ProviderError("invalid_tool_call", "Grok made a malformed tool call", 502), "invalid_tool_call"); }
    return new Promise((resolve, reject) => {
      this.held.set(call.id, { resolve, reject }); this.toolCalls++; this.observed = true;
      // Grok dropping the connection loses the call: the answer would go nowhere.
      abandoned.addEventListener("abort", () => { if (this.held.has(call.id) && this.state !== "closed") this.violation(new ProviderError("cli_failed", "Grok abandoned a tool call", 502, { code: "call_abandoned", event: "grok.tool_use" }), "call_abandoned"); }, { once: true });
      attached.queue.push({ k: "call", call }); attached.wake?.();
    });
  }

  private crash(error: ProviderError, reason: string): void {
    if (this.state === "closed" || this.stopped) return;
    if (this.attached) { this.attached.error ??= error; this.attached.wake?.(); }
    void this.close("crashed", reason);
  }

  /** The session did something it must not: stop it before it can spend more. */
  private violation(error: ProviderError, reason: string): void {
    if (this.attached) { this.attached.error ??= error; this.attached.wake?.(); }
    void this.close("crashed", reason);
  }

  /** Ends the session: kills the process group, stops the endpoint, removes the folder, tells the registry. Safe to call twice. */
  close(outcome: GrokSessionEnd, reason?: string): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "closed"; clearTimeout(this.timer); this.end = { outcome, reason };
    if (this.attached) { this.attached.error ??= new ProviderError("cli_failed", "Grok session closed", 502); this.attached.wake?.(); }
    for (const held of this.held.values()) held.reject(new Error("closed"));
    this.held.clear();
    return this.closing = this.stop().then(() => this.started ? this.options.onClose(this, outcome, reason) : undefined).catch(error => reportException(error, "grok_live_close"));
  }

  /** Kills the process group, stops the endpoint and removes the folder; idempotent. */
  stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.timer);
    return this.stopping ??= (async () => {
      this.conn?.kill();
      // Startup may still be acquiring the folder, the endpoint or the process: let it see `stopped` and give up first.
      await this.booted;
      this.conn?.kill();
      await this.server?.close().catch(() => {});
      if (this.directory) await rm(this.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    })();
  }
}
