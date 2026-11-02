import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { responsesToChatRequest } from "../protocol/request.js";
import type { InferenceEvent, OpenAIChatMessage, OpenAITool, ResponsesRequest } from "../protocol/types.js";
import type { ProviderConfig } from "../config.js";
import { imageConversation } from "../protocol/images.js";
import { telemetry } from "../telemetry.js";
import { ProviderError, type InferenceContext, type Provider } from "./provider.js";
import { claudeToolBindings, claudeToolName } from "./claude-tool-names.js";
import { claudeMcpCatalog, gatewaySystemPrompt } from "./claude-control.js";
import { leadingInstructions, markCustomCalls, renderConversation } from "./claude-render.js";
import { validateForcedChoice } from "./claude-calls.js";
import { ensureGrokHome, grokCommand } from "./grok-home.js";
import { GrokMessageStream, grokUsage, type GrokStreamEnd } from "./grok-stream.js";
import { createHash } from "node:crypto";
import { CliContinuityUnavailable } from "./cli-continuity.js";
import { providerConversationId } from "./provider.js";

/** Every built-in Grok Build tool. search_tool and use_tool stay: they are Grok's only route to the gateway's MCP tools. */
export const grokBuiltinTools = ["run_terminal_command", "read_file", "search_replace", "list_dir", "grep", "kill_command_or_subagent", "todo_write",
  "get_command_or_subagent_output", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor", "workflow", "enter_plan_mode", "exit_plan_mode",
  "ask_user_question", "send_feedback", "image_gen", "image_edit", "image_to_video", "reference_to_video", "write", "web_search", "web_fetch"];
const maxSystemBytes = 256 * 1024;
const maxLine = 8 * 1024 * 1024;
/** After a complete use_tool block the CLI waits on the gateway MCP server; a quiet stream means no more calls follow. */
const toolQuietMs = 1500;
const resultWaitMs = 1000;
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
const grokSystem = `${gatewaySystemPrompt} Caller tools are in the gateway MCP server: find one with search_tool, then call it with use_tool and its full name, gateway__<name>.`;
const toolsScript = fileURLToPath(new URL("./grok-cli-tools.js", import.meta.url));
const continuitySymbol = Symbol.for("harness-gateway/grok-standalone/v1");
/**
 * The current Grok transport is standalone-only until its persistent ACP confinement is qualified.
 * Admission is recorded before the CLI starts so a concurrent duplicate is refused rather than
 * charged twice. `release` removes that record when the attempt never produced an answer, so a
 * sign-in failure does not turn the user's corrected retry into a replay refusal.
 */
function standaloneGrok(config: ProviderConfig, model: string, context: InferenceContext, history: OpenAIChatMessage[]): { admit: () => void; release: () => void } {
  const state = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  const conversations = state[continuitySymbol] ??= new Map();
  const conversation = providerConversationId(context);
  const key = conversation ? createHash("sha256").update(JSON.stringify([config.id, config.grokHome, model, conversation])).digest("hex") : undefined;
  if (history.some(message => message.role === "assistant" || message.role === "tool") || key && conversations.has(key)) {
    telemetry("grok_cli", { model, outcome: "blocked", missReason: "persistent_session_unqualified" });
    throw new CliContinuityUnavailable("Grok", "persistent_session_unqualified");
  }
  return {
    admit: () => {
      if (key && conversations.has(key)) throw new CliContinuityUnavailable("Grok", "persistent_session_unqualified");
      if (key) { conversations.set(key, Date.now()); if (conversations.size > 4096) conversations.delete(conversations.keys().next().value!); }
    },
    release: () => { if (key) conversations.delete(key); },
  };
}

/** Replayed tool calls carry the gateway catalog name Grok uses with use_tool. Arguments, ids and results stay intact. */
export function grokToolHistory(messages: OpenAIChatMessage[], tools: OpenAITool[]): OpenAIChatMessage[] {
  const bindings = claudeToolBindings(tools);
  const translate = (name: string) => { const tool = bindings.get(name); return tool ? `gateway__${claudeToolName(tool)}` : name; };
  return messages.map(message => ({ ...message,
    ...(message.name ? { name: translate(message.name) } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function, name: translate(call.function.name) } })) } : {}),
  }));
}

/** The CLI keeps its subscription login: API keys and the caller's Grok settings never reach it. */
export function grokEnv(home: string, catalog: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("XAI_") || name.startsWith("GROK_")) delete env[name];
  return Object.assign(env, { GROK_HOME: home, GROK_MEMORY: "0", GROK_BACKEND_SEARCH: "0", GROK_CLAUDE_MCPS_ENABLED: "false", GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CLAUDE_SKILLS_ENABLED: "false", GROK_CURSOR_SKILLS_ENABLED: "false", GROK_DISABLE_AUTOUPDATER: "1", GROK_TELEMETRY_ENABLED: "false",
    GATEWAY_GROK_NODE: process.execPath, GATEWAY_GROK_TOOLS: toolsScript, GATEWAY_GROK_CATALOG: catalog, GATEWAY_GROK_OWNER: String(process.pid) });
}

export function grokArgs(promptPath: string, system: string, model: string, effort?: string): string[] {
  return ["--prompt-file", promptPath, "--output-format", "streaming-messages-json", "--include-partial-messages",
    "--disallowed-tools", grokBuiltinTools.join(","), "--permission-mode", "dontAsk", "--allow", "search_tool", "--allow", "use_tool", "--allow", "mcp__gateway",
    "--no-subagents", "--no-plan", "--disable-web-search", "--no-auto-update", "--system-prompt-override", system, "-m", model,
    ...(effort ? ["--reasoning-effort", effort] : [])];
}

/**
 * Grok subscription inference through the official Grok Build CLI, one process per request. The CLI
 * runs with every built-in tool removed and only the gateway's caller catalog as MCP server; a caller
 * tool call ends the request and the CLI is stopped before anything could answer it.
 */
export class GrokSubscription implements Provider {
  constructor(private readonly config: ProviderConfig, private readonly onContextWindow?: (model: string, contextWindow: number) => void) {}

  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    if (signal.aborted) throw cancelled();
    const normalized = responsesToChatRequest(request);
    const choice = normalized.tool_choice;
    const tools: OpenAITool[] = choice === "none" ? [] : normalized.tools || [];
    if (new Set(tools.map(claudeToolName)).size !== tools.length) throw new ProviderError("invalid_request", "Caller tool identities collide in Grok's tool namespace", 400);
    if (normalized.messages.some(message => message.parts?.some(part => part.type === "image"))) {
      throw new ProviderError("invalid_request", "Grok through the gateway accepts text only; remove the image or choose another model", 400);
    }
    const history = grokToolHistory(markCustomCalls(normalized.messages, normalized.tools || []), normalized.tools || []);
    const continuity = standaloneGrok(this.config, request.model, context, history);
    const leading = leadingInstructions(history);
    const system = [grokSystem, ...history.slice(0, leading).map(message => message.content ?? "")].filter(Boolean).join("\n\n");
    if (Buffer.byteLength(system) > maxSystemBytes) throw new ProviderError("invalid_request", "Instructions are too large for the Grok CLI", 400);
    const { conversation, images } = imageConversation(history.slice(leading));
    const forcedTool = typeof choice === "object" ? tools.find(tool => tool.function.name === choice.function.name) : undefined;
    const forced = choice === "required" ? "Use one of the caller tools through use_tool."
      : typeof choice === "object" ? `Use the required caller tool gateway__${forcedTool ? claudeToolName(forcedTool) : choice.function.name} through use_tool.` : undefined;
    const prompt = [...renderConversation(conversation, images, "text").map(block => String(block.text ?? "")), ...(forced ? [forced] : [])].join("\n\n");
    const alias = Object.entries(this.config.models).find(([, model]) => model === request.model)?.[0];
    const requested = (request.reasoning as { effort?: string } | undefined)?.effort;
    const supported = alias ? this.config.modelMetadata?.[alias]?.reasoningEfforts : undefined;
    const effort = requested && supported?.includes(requested) ? requested : undefined;
    const summaryVisible = (request.reasoning as { summary?: string } | undefined)?.summary !== "none";
    const home = this.config.grokHome;
    if (!home) throw new ProviderError("invalid_request", "The Grok provider has no Grok home", 400);
    await ensureGrokHome(home);
    if (signal.aborted) throw cancelled();
    continuity.admit();

    const directory = await mkdtemp(join(tmpdir(), "gateway-grok-"));
    const catalogPath = join(directory, "tools.json"); const promptPath = join(directory, "prompt.md");
    await writeFile(catalogPath, JSON.stringify(claudeMcpCatalog(tools)), { mode: 0o600 });
    await writeFile(promptPath, prompt, { mode: 0o600 });
    const command = await grokCommand();
    const child = spawn(command, grokArgs(promptPath, system, request.model, effort), { cwd: directory, env: grokEnv(home, catalogPath), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stream = new GrokMessageStream(tools, summaryVisible);
    const began = Date.now(); let exitCode: number | null = null; let spawnFailed = false; let end: GrokStreamEnd | undefined;
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    child.on("error", () => { spawnFailed = true; }); child.on("exit", code => { exitCode = code; });
    child.stderr.resume();
    signal.addEventListener("abort", kill, { once: true });
    const pending: string[] = []; let closed = false; let wake: (() => void) | undefined;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => { pending.push(line); wake?.(); });
    lines.on("close", () => { closed = true; wake?.(); });
    /** The next line, null when the CLI closed its output, undefined when `ms` passed quietly. */
    const next = async (ms?: number): Promise<string | null | undefined> => {
      for (;;) {
        if (pending.length) return pending.shift()!;
        if (closed) return null;
        const quiet = await new Promise<boolean>(resolve => {
          const timer = ms === undefined ? undefined : setTimeout(() => { wake = undefined; resolve(true); }, ms);
          wake = () => { wake = undefined; clearTimeout(timer); resolve(false); };
        });
        if (quiet) return undefined;
      }
    };
    let emitted = false;
    try {
      let ready = false; let turnEnded = false;
      for (;;) {
        const line = await next(turnEnded ? resultWaitMs : ready ? toolQuietMs : undefined);
        if (line === undefined) { end = turnEnded ? { kind: "end_turn" } : stream.finish(); break; }
        if (line === null) break;
        if (line.length > maxLine) throw new ProviderError("output_too_large", "Provider output exceeds 8 MiB");
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const step = stream.accept(message);
        for (const event of step.events) { emitted = true; yield event; }
        if (step.ready) ready = true;
        if (step.end?.kind === "end_turn" && !turnEnded) { turnEnded = true; continue; }
        if (step.end) { end = turnEnded && step.end.kind === "result" ? { kind: "end_turn" } : step.end; break; }
      }
      if (signal.aborted) throw cancelled();
      if (!end) throw new ProviderError("cli_failed", `Grok CLI did not complete${exitCode !== null ? ` (exit ${exitCode})` : ""}; check \`grok models\` for the gateway's Grok home`);
      kill();
      for (const window of stream.contextWindows) this.onContextWindow?.(window.model, window.contextWindow);
      const calls = end.kind === "tool_use" ? end.calls : [];
      validateForcedChoice(calls, choice);
      for (const call of calls) { emitted = true; yield { type: "tool", call }; }
      emitted = true;
      yield { type: "done", usage: grokUsage(stream.tokens) };
    } finally {
      signal.removeEventListener("abort", kill); kill(); lines.close();
      // An attempt that neither reached the client nor spent allowance left nothing to preserve, so
      // a corrected retry (for example after signing in) may start it again. A partly streamed or
      // already charged turn stays recorded, and cancellation keeps its own outcome.
      const billed = (stream.observedTokens?.input ?? 0) > 0 || stream.costUsd !== undefined;
      if (!emitted && !signal.aborted && !billed) continuity.release();
      context.observeCacheUsage?.({ inputTokens: stream.observedTokens?.input, cachedTokens: stream.observedTokens?.cacheRead });
      telemetry("grok_cli", { model: alias ?? request.model, effort, durationMs: Date.now() - began, result: end?.kind ?? "none", exitCode, spawnFailed,
        aborted: signal.aborted, toolCalls: stream.toolCalls, inputTokens: stream.tokens.input, cacheReadTokens: stream.tokens.cacheRead,
        outputTokens: stream.tokens.output, costUsd: stream.costUsd });
      await rm(directory, { recursive: true, force: true });
    }
  }
}
