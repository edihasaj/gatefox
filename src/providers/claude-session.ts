import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ChatToolSelection, InferenceEvent, OpenAITool } from "../protocol/types.js";
import { ProviderError } from "./provider.js";
import { controlLine, controlResult, userLine, type ClaudeMcpTool } from "./claude-control.js";
import type { ClaudeMessageStream, ClaudeStreamEnd, ClaudeTokens } from "./claude-stream.js";
import type { ContentBlock } from "./claude-render.js";
import { nativeClaudeCalls, validateForcedChoice } from "./claude-calls.js";
import { claudeUsageEvent, type ClaudeLimit } from "./claude-usage.js";
import { claudeToolName } from "./claude-tool-names.js";
import { ClaudeRelay, type RelayContent } from "./claude-relay.js";
import { echoDigests, partialDigest, type LedgerState } from "./claude-ledger.js";
import { providerCommand } from "../provider-tool-runtime.js";

export type SessionState = "starting" | "generating" | "interrupting" | "awaiting_outputs" | "turn_done" | "closed";
export type SessionEnd = "reaped" | "evicted" | "crashed" | "closed";
export class SessionStartFailure extends Error { constructor(readonly reason: "spawn_failed" | "initialize_timeout") { super(`Claude session ${reason}`); } }

export interface SessionOptions {
  key: string; fingerprint: string; window: string; effort?: string;
  args(mcpPath: string, systemPath: string): string[];
  /** The CLI environment, without host Claude Code session variables (claudeEnv live). */
  env: NodeJS.ProcessEnv;
  mcpCatalog: ClaudeMcpTool[];
  systemPrompt: string;
  /** Whether another session for this key exists or is starting; its directory then stays. */
  keyInUse(): boolean;
  /** Called once when a started session ends, for the registry and telemetry. */
  onClose(session: ClaudeSession, outcome: SessionEnd, reason?: string): void;
}

/** One request served by the session. */
export interface SessionTurn {
  begin: { user: ContentBlock[] } | { outputs: Map<string, RelayContent[]> };
  /** Ledger digests of this request's canonical input. */
  prefix: string[];
  stream: ClaudeMessageStream;
  tools: OpenAITool[];
  choice?: ChatToolSelection;
  fast: boolean;
  signal: AbortSignal;
  onUsage(limit: ClaudeLimit): Promise<void>;
  onContextWindow(model: string, contextWindow: number): void;
  /** Called once: "ended" with the final message's tokens, or why it did not end. */
  onEnd(outcome: "ended" | "interrupted" | "failed", tokens?: ClaudeTokens): void;
}

type Block = { type?: unknown; name?: unknown };
interface Attached {
  turn: SessionTurn; queue: Array<Record<string, unknown>>; wake?: () => void; error?: Error; onAbort: () => void;
  /** The text this request emitted: Codex replays it, and it can differ from the native text (paragraph breaks). */
  text: string;
}
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
const maxLine = 8 * 1024 * 1024;
/** Startup bound (spawn, initialize and the relay hello); tests shorten it. */
export const sessionLimits = { startMs: 15000 };
const eventType = (message: Record<string, unknown>) => message.type === "stream_event" ? (message.event as { type?: unknown } | undefined)?.type : undefined;
/** The typed failure for a tool the CLI must never run, classified like the one-shot path. */
function foreignTool(name: unknown): ProviderError {
  try { nativeClaudeCalls([{ name: typeof name === "string" ? name : undefined }], []); } catch (error) { if (error instanceof ProviderError) return error; }
  return new ProviderError("invalid_tool_call", "Claude returned an unknown tool call", 502, { code: "unknown_tool", event: "claude.tool_use" });
}

const sessionsDirectory = () => join(tmpdir(), "gateway-claude");
// A generation directory is named after the gateway process that owns it, so leftovers of a dead process are recognizable.
const ownerAlive = (name: string) => {
  const pid = parseInt(name.split("-")[0], 36);
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Removes session files left behind by gateway processes that no longer run; working directories stay. */
export async function sweepSessionDirectories(): Promise<void> {
  const base = sessionsDirectory();
  for (const key of await readdir(base).catch(() => [] as string[])) {
    for (const name of await readdir(join(base, key)).catch(() => [] as string[])) {
      if (name !== "work" && !ownerAlive(name)) await rm(join(base, key, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** A 0700 directory this user owns, never a symlink: the CLI's cwd and the relay socket live here. */
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new SessionStartFailure("spawn_failed");
}

/**
 * One long-lived `claude -p` stream-json process for one Codex thread. Native history
 * stays in the process; caller tools block on the relay until Codex sends their outputs.
 * A single stdout reader routes lines to the attached request, if any. Between requests
 * it accepts only the CLI's housekeeping lines; new model output there is a protocol
 * violation that closes the session.
 */
export class ClaudeSession {
  state: SessionState = "starting";
  readonly key: string; readonly fingerprint: string; readonly window: string; effort?: string;
  ledger: LedgerState = { items: [] }; pending: string[] = [];
  lastUse = Date.now(); perTurnEffort?: boolean; relay?: ClaudeRelay;
  private child!: ChildProcessWithoutNullStreams; private directory?: string; private keyDirectory?: string;
  private attached?: Attached; private controls = new Map<string, (ok: boolean) => void>();
  private message?: string; private messageTool = false; private endedMessage?: string; private fastState?: string;
  private parkTimer?: NodeJS.Timeout; private interruptTimer?: NodeJS.Timeout; private exit?: Promise<void>; private closing?: Promise<void>;
  private settled = new Set<() => void>(); private retiring?: string; private parkMs?: number;
  private onUsage?: (limit: ClaudeLimit) => Promise<void>;
  private constructor(private readonly options: SessionOptions) { this.key = options.key; this.fingerprint = options.fingerprint; this.window = options.window; this.effort = options.effort; }

  get pid(): number | undefined { return this.child?.pid; }
  /** The signal that ended the CLI, if one did. */
  get exitSignal(): string | undefined { return this.child?.signalCode ?? undefined; }

  /** Spawns, initializes and waits for the relay; a failure leaves nothing behind. */
  static async start(options: SessionOptions, signal: AbortSignal): Promise<ClaudeSession> {
    const session = new ClaudeSession(options);
    const abort = () => session.kill();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await session.boot();
      if (signal.aborted) throw cancelled();
      session.state = "turn_done";
      return session;
    } catch (error) {
      await session.stop(true);
      throw signal.aborted ? cancelled() : error;
    } finally { signal.removeEventListener("abort", abort); }
  }

  private async boot(): Promise<void> {
    const base = sessionsDirectory(); this.keyDirectory = join(base, this.key.slice(0, 16));
    const work = join(this.keyDirectory, "work");
    for (const path of [base, this.keyDirectory, work]) await privateDirectory(path);
    const directory = this.directory = join(this.keyDirectory, `${process.pid.toString(36)}-${randomBytes(2).toString("hex")}`);
    await mkdir(directory, { mode: 0o700 });
    let servers = {};
    if (this.options.mcpCatalog.length) {
      // The socket path must fit a Unix socket address (104 bytes on macOS, with its terminator).
      const socket = join(directory, "r.sock"); if (Buffer.byteLength(socket) > 103) throw new SessionStartFailure("spawn_failed");
      const key = randomBytes(32).toString("hex");
      this.relay = new ClaudeRelay(key, reason => { void this.close("crashed", reason, true); });
      await this.relay.listen(socket);
      const tools = join(directory, "tools.json"), relay = join(directory, "relay.json"), script = join(directory, "claude-tools.mjs");
      await writeFile(tools, JSON.stringify(this.options.mcpCatalog), { mode: 0o600 });
      await writeFile(relay, JSON.stringify({ socket, key }), { mode: 0o600 });
      // A private copy, so pruning an old release never removes a running session's server.
      await copyFile(fileURLToPath(new URL("./claude-tools.js", import.meta.url)), script);
      servers = { gateway: { command: process.execPath, args: [script, tools, relay], alwaysLoad: true } };
    }
    const mcpPath = join(directory, "mcp.json"), systemPath = join(directory, "system.md");
    await writeFile(mcpPath, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    await writeFile(systemPath, this.options.systemPrompt, { mode: 0o600 });
    const command = await providerCommand("claude");
    const child = this.child = spawn(command, this.options.args(mcpPath, systemPath), { cwd: work, env: this.options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.exit = new Promise(resolve => child.once("close", () => resolve()));
    let failed = false;
    child.on("error", () => { failed = true; for (const done of [...this.controls.values()]) done(false); });
    child.on("exit", () => {
      for (const done of [...this.controls.values()]) done(false);
      if (this.state === "starting") this.relay?.close(); else void this.close("crashed", "exited", true);
    });
    child.stderr.resume(); child.stdin.on("error", () => { /* The exit handler reports it. */ });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => this.line(line));
    const deadline = Date.now() + sessionLimits.startMs;
    if (!(await this.control("initialize", { hooks: null }, sessionLimits.startMs))) throw new SessionStartFailure(failed || !this.running ? "spawn_failed" : "initialize_timeout");
    if (this.relay && !(await this.relay.waitReady(Math.max(0, deadline - Date.now())))) throw new SessionStartFailure("spawn_failed");
  }

  /** Waits up to `ms` for an interrupted turn to finish; true when the session is idle. */
  async waitIdle(ms: number): Promise<boolean> {
    if (this.state === "interrupting") await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); this.settled.delete(done); resolve(); }; const timer = setTimeout(done, ms); this.settled.add(done); });
    return this.state === "turn_done" || this.state === "awaiting_outputs";
  }

  /** Closes the session now, or when its running turn ends (in-flight requests finish on the runtime that started them). */
  retire(reason: string): Promise<void> {
    if (this.state === "generating" || this.state === "interrupting") { this.retiring = reason; return Promise.resolve(); }
    return this.close("closed", reason);
  }

  /** Resets the idle timer, here and whenever a request ends; a parked session is closed when it fires. */
  park(ms: number): void {
    clearTimeout(this.parkTimer); this.parkMs = ms;
    this.parkTimer = setTimeout(() => {
      if (this.state === "generating" || this.state === "interrupting") this.park(ms); else void this.close("reaped");
    }, ms);
    this.parkTimer.unref();
  }

  /** Changes effort between turns over the control channel, keeping the cached prefix. */
  async applyEffort(effort: string): Promise<boolean> {
    if (this.state !== "turn_done") return false;
    const ok = await this.control("apply_flag_settings", { settings: { effortLevel: effort } }, 5000);
    if (ok) this.effort = effort;
    return ok && this.state === "turn_done";
  }

  /** Attaches one request and starts it. The returned events end with `done`, or throw. */
  run(turn: SessionTurn): AsyncIterable<InferenceEvent> {
    const attached: Attached = { turn, queue: [], text: "", onAbort: () => this.abort(attached) };
    this.attached = attached; this.state = "generating"; this.messageTool = false; this.onUsage = turn.onUsage;
    turn.signal.addEventListener("abort", attached.onAbort, { once: true });
    if ("user" in turn.begin) this.write(userLine(turn.begin.user)); else this.relay?.deliver(turn.begin.outputs);
    return this.events(attached);
  }

  private async *events(attached: Attached): AsyncGenerator<InferenceEvent> {
    const { turn } = attached;
    try {
      for (;;) {
        const step = turn.stream.accept(await this.next(attached));
        if (step.limit) void turn.onUsage(step.limit);
        for (const window of step.contextWindows || []) turn.onContextWindow(window.model, window.contextWindow);
        if (!step.end) { for (const event of step.events) { if (event.type === "text") attached.text += event.text; yield event; } continue; }
        for (const event of step.events) if (event.type === "text") attached.text += event.text;
        const final = this.finish(attached, step.end);
        for (const event of [...step.events, ...final]) yield event;
        return;
      }
    } catch (error) {
      throw this.failed(attached, error);
    } finally {
      // A consumer that stops reading mid-turn cancels the turn like an abort.
      if (this.attached === attached) this.abort(attached);
    }
  }

  private next(attached: Attached): Promise<Record<string, unknown>> {
    const take = () => { const message = attached.queue.shift()!; if (attached.queue.length < 64) this.child.stdout.resume(); return message; };
    if (attached.error) return Promise.reject(attached.error);
    if (attached.queue.length) return Promise.resolve(take());
    return new Promise((resolve, reject) => { attached.wake = () => { attached.wake = undefined; if (attached.error) reject(attached.error); else resolve(take()); }; });
  }

  /** Ends the request. The state changes before any event leaves, so a fast follow-up never sees it running. */
  private finish(attached: Attached, end: ClaudeStreamEnd): InferenceEvent[] {
    const { turn } = attached;
    const calls = end.kind === "tool_use" ? end.calls : [];
    validateForcedChoice(calls, turn.choice);
    const names = new Map(turn.tools.map(tool => [tool.function.name, claudeToolName(tool)]));
    if (calls.length && !this.relay?.expect(calls.map(call => ({ id: call.id, name: names.get(call.function.name) ?? call.function.name })))) {
      throw new ProviderError("invalid_tool_call", "Claude called a tool the gateway did not return", 502, { code: "relay_mismatch", event: "claude.tool_use" });
    }
    this.detach(attached);
    this.ledger = { items: [...turn.prefix, ...echoDigests(attached.text, calls)] };
    this.pending = calls.map(call => call.id); this.state = calls.length ? "awaiting_outputs" : "turn_done";
    this.endedMessage = this.message; this.messageTool = false;
    turn.onEnd("ended", end.tokens);
    // Lines read past the end are between-request lines: checked, and their rate limits kept.
    for (const message of attached.queue.splice(0)) this.detached(message, eventType(message));
    if (this.retiring) void this.close("closed", this.retiring);
    const served = turn.fast ? { serviceTier: this.fastState === "on" ? "priority" as const : "default" as const } : {};
    return [...calls.map(call => ({ type: "tool" as const, call })), { type: "done", usage: end.usage, accounting: { cacheWriteTokens: end.tokens.cacheWrite }, ...served }];
  }

  /** Cancels the attached request: interrupt keeps the process, unless a tool call was being written. */
  private abort(attached: Attached): void {
    if (this.attached !== attached) return;
    this.detach(attached); attached.error = cancelled(); attached.wake?.();
    attached.turn.onEnd("interrupted");
    if (this.messageTool) { void this.close("closed", "interrupted_tool", true); return; }
    this.pending = []; this.ledger = { items: attached.turn.prefix, partial: partialDigest(attached.text) };
    const rest = attached.queue.splice(0);
    // A turn whose result is already read needs no interrupt: an idle CLI would never answer one with a result.
    if (rest.some(message => message.type === "result")) {
      this.state = "turn_done";
      for (const message of rest) { const limit = claudeUsageEvent(message); if (limit) void this.onUsage?.(limit).catch(() => {}); }
      if (this.retiring) void this.close("closed", this.retiring);
      return;
    }
    this.write(controlLine("interrupt").line); this.state = "interrupting";
    for (const message of rest) this.detached(message, eventType(message));
    // The CLI ends an interrupted turn with a result within milliseconds; one that does not is closed.
    this.interruptTimer = setTimeout(() => { if (this.state === "interrupting") void this.close("crashed", "interrupt_timeout", true); }, 2000);
    this.interruptTimer.unref();
  }

  /** A stream failure closes the session at once: the CLI must not act on a foreign or failed turn. */
  private failed(attached: Attached, error: unknown): unknown {
    if (this.attached === attached) {
      this.detach(attached); attached.turn.onEnd("failed");
      void this.close("crashed", error instanceof ProviderError ? error.upstream?.code ?? error.code : "failed", true);
    }
    return error;
  }

  private detach(attached: Attached): void {
    if (this.attached === attached) this.attached = undefined;
    attached.turn.signal.removeEventListener("abort", attached.onAbort);
    this.lastUse = Date.now(); this.child.stdout.resume();
    if (this.parkMs !== undefined && this.state !== "closed") this.park(this.parkMs);
  }

  private line(line: string): void {
    if (line.length > maxLine) { if (this.attached) this.attached.error = new ProviderError("output_too_large", "Provider output exceeds 8 MiB"); void this.close("crashed", "output_too_large", true); return; }
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.type === "control_response") { for (const [id, done] of [...this.controls]) { const result = controlResult(message, id); if (result) done(result === "success"); } return; }
    // The gateway grants nothing: no permission prompt, hook or SDK request is ever approved.
    if (message.type === "control_request") { this.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "Not supported by the gateway" } }) + "\n"); return; }
    if (typeof message.fast_mode_state === "string") this.fastState = message.fast_mode_state;
    if (message.type === "system" && message.subtype === "init" && typeof message.per_turn_effort_active === "boolean") this.perTurnEffort = message.per_turn_effort_active;
    if (message.type === "system" && message.subtype === "per_turn_effort_changed") this.perTurnEffort = false;
    const event = message.type === "stream_event" && message.event && typeof message.event === "object" ? message.event as { type?: unknown; message?: { id?: unknown }; content_block?: Block } : undefined;
    if (event?.type === "message_start") { this.message = typeof event.message?.id === "string" ? event.message.id : undefined; this.messageTool = false; }
    const content = message.type === "assistant" ? (message.message as { content?: unknown } | undefined)?.content : undefined;
    const uses = [...(event?.type === "content_block_start" && event.content_block ? [event.content_block] : []), ...(Array.isArray(content) ? content as Block[] : [])].filter(block => block?.type === "tool_use");
    if (uses.length) this.messageTool = true;
    // Backstop to --tools "": any other tool ends the session as soon as it is read, before the CLI could run it, however slowly the caller reads.
    const foreign = uses.find(block => typeof block.name !== "string" || !block.name.startsWith("mcp__gateway__"));
    if (foreign) {
      const error = foreignTool(foreign.name); if (this.attached) this.attached.error = error;
      void this.close("crashed", error.upstream?.code ?? error.code, true); return;
    }
    const attached = this.attached;
    if (!attached) { this.detached(message, event?.type); return; }
    attached.queue.push(message);
    if (attached.queue.length > 256) this.child.stdout.pause();
    attached.wake?.();
  }

  /**
   * Between requests the CLI still reports message_stop, rate limits, tool progress,
   * tool_result echoes and status. New model output or a result is a violation; while
   * interrupting, the rest of the interrupted turn is expected and its result ends it.
   */
  private detached(message: Record<string, unknown>, event: unknown): void {
    const limit = claudeUsageEvent(message); if (limit) void this.onUsage?.(limit).catch(() => {});
    if (this.state === "interrupting") {
      if (message.type !== "result") return;
      this.state = "turn_done"; clearTimeout(this.interruptTimer); for (const done of [...this.settled]) done();
      if (this.retiring) void this.close("closed", this.retiring);
      return;
    }
    if (this.state !== "awaiting_outputs" && this.state !== "turn_done") return;
    const echo = message.type === "assistant" && (message.message as { id?: unknown } | undefined)?.id === this.endedMessage;
    if (message.type === "result" || (message.type === "assistant" && !echo) || event === "message_start" || event === "content_block_start" || event === "content_block_delta") void this.close("crashed", "unexpected_output", true);
  }

  private control(subtype: string, fields: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
    const { requestId, line } = controlLine(subtype, fields);
    return new Promise(resolve => {
      const done = (ok: boolean) => { clearTimeout(timer); this.controls.delete(requestId); resolve(ok); };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.controls.set(requestId, done); this.write(line);
    });
  }

  private write(line: string): void { if (this.child?.stdin.writable) this.child.stdin.write(line); }
  private get running(): boolean { return !!this.child && this.child.exitCode === null && this.child.signalCode === null; }
  private kill(): void {
    if (!this.running) return;
    try { process.kill(-this.child.pid!, "SIGKILL"); } catch { try { this.child.kill("SIGKILL"); } catch { /* Already gone. */ } }
  }
  private exited(ms: number): Promise<void> {
    if (!this.exit || !this.running) return Promise.resolve();
    return new Promise(resolve => { const timer = setTimeout(resolve, ms); void this.exit!.then(() => { clearTimeout(timer); resolve(); }); });
  }

  /** Ends the session: end_session and stdin EOF, then SIGKILL of the process group after 1 s (at once when hard). */
  close(outcome: SessionEnd, reason?: string, hard = false): Promise<void> {
    if (this.state === "closed") return this.closing ?? Promise.resolve();
    const started = this.state !== "starting";
    this.state = "closed"; clearTimeout(this.parkTimer); clearTimeout(this.interruptTimer);
    const attached = this.attached;
    if (attached) {
      this.detach(attached); attached.turn.onEnd("failed");
      attached.error ??= new ProviderError("cli_failed", "Claude CLI session ended; run gateway doctor", 502, { code: reason, event: "claude.session" });
      attached.wake?.();
    }
    for (const done of [...this.controls.values(), ...this.settled]) done(false);
    if (started) this.options.onClose(this, outcome, reason);
    return this.closing = this.stop(hard);
  }

  private async stop(hard: boolean): Promise<void> {
    this.state = "closed";
    if (!hard && this.running) {
      this.write(controlLine("end_session", { reason: "gateway" }).line); this.child.stdin.end();
      await this.exited(1000);
    }
    this.kill(); this.relay?.close();
    await this.exited(1000);
    if (this.directory) await rm(this.directory, { recursive: true, force: true }).catch(() => {});
    // The working directory stays while another session of this thread uses it.
    if (this.keyDirectory && !this.options.keyInUse()) {
      const left = await readdir(this.keyDirectory).catch(() => [] as string[]);
      if (left.every(name => name === "work")) await rm(this.keyDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}
