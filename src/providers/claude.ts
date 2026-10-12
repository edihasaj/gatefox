import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { responsesToChatRequest } from "../protocol/request.js";
import type { ResponsesRequest, InferenceEvent, Usage } from "../protocol/types.js";
import { ProviderError, type Provider } from "./provider.js";
import type { ProviderConfig } from "../config.js";
import { nativeClaudeCalls, nativeClaudeReasoning } from "./claude-calls.js";
import { claudeEnvironment } from "./claude-environment.js";
import { imageConversation } from "../protocol/images.js";
import { claudeContextFailure } from "./context-errors.js";
import { claudeToolName, claudeNativeToolName, claudeToolHistory } from "./claude-tool-names.js";

interface ClaudeUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
function usage(tokens?: ClaudeUsage): Usage {
  const input = (tokens?.input_tokens || 0) + (tokens?.cache_read_input_tokens || 0) + (tokens?.cache_creation_input_tokens || 0);
  const output = tokens?.output_tokens || 0;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

export function claudeEffort(config: ProviderConfig | undefined, request: ResponsesRequest): string | undefined {
  const effort = (request.reasoning as { effort?: string } | undefined)?.effort;
  const alias = Object.entries(config?.models || {}).find(([, model]) => model === request.model)?.[0];
  const supported = alias ? config?.modelMetadata?.[alias]?.reasoningEfforts : undefined;
  if (effort === "none" && supported?.length === 0) return;
  if (effort && (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) || (supported && !supported.includes(effort)))) {
    throw new ProviderError("invalid_request", "Selected Claude model does not support this reasoning effort", 400);
  }
  return effort;
}

export class ClaudeSubscription implements Provider {
  constructor(private readonly config?: ProviderConfig) {}
  async *infer(request: ResponsesRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    const normalized = responsesToChatRequest(request);
    const choice = normalized.tool_choice;
    const tools = choice === "none" ? [] : (normalized.tools || []).filter(tool => typeof choice !== "object" || tool.function.name === choice.function.name);
    if (new Set(tools.map(claudeToolName)).size !== tools.length) throw new ProviderError("invalid_request", "Caller tool identities collide in Claude's native namespace", 400);
    const effort = claudeEffort(this.config, request);
    const summary = (request.reasoning as { summary?: string } | undefined)?.summary;
    const { conversation, images } = imageConversation(claudeToolHistory(normalized.messages, normalized.tools || []));
    const directory = await mkdtemp(join(tmpdir(), "gateway-claude-"));
    const catalogPath = join(directory, "tools.json"); const mcpPath = join(directory, "mcp.json");
    await writeFile(catalogPath, JSON.stringify(tools.map(tool => ({
      name: claudeToolName(tool), description: `Caller tool ${tool.function.name}. ${tool.function.description || ""}`,
      inputSchema: tool.function.parameters || { type: "object", properties: {} },
    }))), { mode: 0o600 });
    await writeFile(mcpPath, JSON.stringify({ mcpServers: tools.length ? { gateway: { command: process.execPath, args: [fileURLToPath(new URL("./claude-tools.js", import.meta.url)), catalogPath], alwaysLoad: true } } : {} }), { mode: 0o600 });
    const env = claudeEnvironment(this.config?.authDirectory);
    // This virtual catalog is the only action surface. Finish loading it before
    // inference instead of exposing the CLI's deferred search/wait tools.
    env.MCP_CONNECTION_NONBLOCKING = "0";
    if ((request.reasoning as { effort?: string } | undefined)?.effort !== undefined) delete env.MAX_THINKING_TOKENS;
    const child = spawn("claude", ["--restricted", "--setting-sources", "", "--disable-slash-commands", "--print", "--tools", "", "--strict-mcp-config", "--mcp-config", mcpPath,
      "--model", request.model, "--no-session-persistence", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
      "--system-prompt", "You are an inference backend. Use only supplied gateway MCP tools for caller-dispatched actions. The caller executes them and supplies results in the conversation. You cannot execute native tools. Respect system/developer messages in the supplied conversation. Never print invented tool-call JSON or XML; use actual tools. Otherwise answer normally.",
      ...(effort ? ["--effort", effort] : []),
      ...(images.length ? ["--input-format", "stream-json"] : []),
      ...(effort ? ["--settings", '{"alwaysThinkingEnabled":true}'] : []),
    ], { cwd: directory, stdio: ["pipe", "pipe", "pipe"], env });
    let failure: Error | undefined; let result: Record<string, unknown> | undefined; let raw = ""; let exitCode: number | null = null;
    const stop = () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const hardStop = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1500).unref();
        child.once("exit", () => clearTimeout(hardStop));
      }
    };
    child.on("error", error => { failure = error; }); child.on("exit", code => { exitCode = code; });
    child.stderr.resume(); child.stdin.on("error", error => { failure = error; });
    signal.addEventListener("abort", stop, { once: true });
    const lines = createInterface({ input: child.stdout });
    try {
      if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499);
      const aliases = tools.map(tool => ({ caller: tool.function.name, native: claudeNativeToolName(tool) }));
      const prompt = `Tool names: ${JSON.stringify(aliases)}\n${typeof choice === "object" || choice === "required" ? "Use the required caller tool.\n" : ""}Conversation: ${JSON.stringify(conversation)}`;
      const content = images.flatMap(({ label, image }) => [{ type: "text", text: `Attached image ${label}:` }, { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }]);
      child.stdin.end(images.length ? JSON.stringify({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [...content, { type: "text", text: prompt }] } }) + "\n" : prompt);
      for await (const line of lines) {
        if (line.length > 8 * 1024 * 1024 || raw.length > 8 * 1024 * 1024) throw new ProviderError("output_too_large", "Provider output exceeds 8 MiB");
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const context = claudeContextFailure(message); if (context) throw context;
        if (message.type === "stream_event") {
          const event = message.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string; estimated_tokens?: number } };
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) { raw += event.delta.text; yield { type: "text", text: event.delta.text }; }
          const reasoning = event && nativeClaudeReasoning(event);
          if (summary !== "none" && reasoning) yield reasoning;
        } else if (message.type === "assistant") {
          const assistant = message.message as { content?: Array<{ type: string; id?: string; name?: string; input?: unknown }>; usage?: ClaudeUsage };
          const calls = assistant.content?.filter(block => block.type === "tool_use") || [];
          if (calls.length) {
            stop();
            for (const call of nativeClaudeCalls(calls, tools)) yield { type: "tool", call };
            yield { type: "done", usage: usage(assistant.usage) }; return;
          }
        } else if (message.type === "result") { result = message; break; }
      }
      if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499);
      if (failure || !result) throw new ProviderError("cli_failed", `Claude CLI did not complete${exitCode !== null ? ` (exit ${exitCode})` : ""}; run gateway doctor`);
      if (result.is_error || result.subtype !== "success") {
        const diagnosis = String(result.result || "");
        if (/rate.?limit|usage.?limit/i.test(diagnosis)) throw new ProviderError("usage_limit", "Claude subscription usage limit reached", 429);
        if (/auth|log.?in|oauth/i.test(diagnosis)) throw new ProviderError("authentication", "Claude subscription requires login", 401);
        throw new ProviderError("inference_failed", "Claude inference did not complete");
      }
      if (choice === "required" || typeof choice === "object") throw new ProviderError("invalid_tool_call", "Claude did not return the required tool call", 502, { code: "required_tool_missing", event: "claude.result" });
      const text = typeof result.result === "string" ? result.result : raw;
      if (!text.startsWith(raw)) throw new ProviderError("inconsistent_stream", "Claude final text differs from streamed text");
      if (text.length > raw.length) yield { type: "text", text: text.slice(raw.length) };
      yield { type: "done", usage: usage(result.usage as ClaudeUsage | undefined) };
    } finally {
      signal.removeEventListener("abort", stop); lines.close(); stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
