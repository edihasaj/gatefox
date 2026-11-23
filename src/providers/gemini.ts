import { imageConversation } from "../protocol/images.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { telemetry } from "../telemetry.js";
import type { InferenceEvent, OpenAITool, ResponsesRequest } from "../protocol/types.js";
import { geminiSessionSettings, type ProviderConfig } from "../config.js";
import { claudeToolName } from "./claude-tool-names.js";
import { claudeMcpCatalog, gatewaySystemPrompt } from "./claude-control.js";
import { leadingInstructions, markCustomCalls } from "./claude-render.js";
import { CliContinuityUnavailable } from "./cli-continuity.js";
import { antigravityCommand, ensureAntigravityHome, provisionAntigravityHome } from "./antigravity-home.js";
import { antigravityEfforts } from "./antigravity-acp.js";
import { antigravityLive, geminiLive, geminiOneShotKinds, type GeminiLiveInput } from "./gemini-live.js";
import { ensureGeminiHome, geminiCommand } from "./gemini-home.js";
import { provisionGeminiHome } from "./gemini-session-home.js";
import { ProviderError, providerConversationId, type InferenceContext, type Provider } from "./provider.js";

/**
 * The caller tools come from one MCP server named `gateway`, which the gateway passes in `session/new` and answers
 * itself. The text tells the CLI where to look; it is not a permission — every call still goes through the client.
 */
const geminiSystem = `${gatewaySystemPrompt} Caller tools are in the gateway MCP server: call one by its name and the client will run it and return its result.`;
const maxSystemBytes = 256 * 1024;

/**
 * Google AI Ultra subscription inference through the official Gemini CLI (`gemini --acp`), one long-lived ACP process
 * per conversation. API keys are never used: every Google, Vertex and Gemini credential variable is removed from the
 * CLI's environment, and the CLI signs in once into the gateway's private home. The CLI runs in a private empty folder
 * with one MCP server, the caller's catalog; a caller tool call ends the request and the next request answers it, so
 * the client executes every tool and the provider never runs one of its own.
 */
export class GeminiSubscription implements Provider {
  constructor(private readonly config: ProviderConfig, private readonly onContextWindow?: (model: string, contextWindow: number) => void) {}

  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499);
    const normalized = responsesToChatRequest(request);
    const choice = normalized.tool_choice;
    const tools: OpenAITool[] = choice === "none" ? [] : normalized.tools || [];
    if (new Set(tools.map(claudeToolName)).size !== tools.length) throw new ProviderError("invalid_request", "Caller tool identities collide in Gemini's tool namespace", 400);
    if (normalized.messages.some(message => message.parts?.some(part => part.type === "image"))) {
      throw new ProviderError("invalid_request", "Gemini through the gateway accepts text only; remove the image or choose another model", 400);
    }
    const settings = geminiSessionSettings(this.config);
    if (settings.mode !== "live") {
      throw new ProviderError("invalid_request", "Gemini through the gateway runs one live ACP session per conversation; set geminiSessions.mode to live (the default) or choose another model", 400);
    }
    const history = markCustomCalls(normalized.messages, normalized.tools || []);
    const leading = leadingInstructions(history);
    const system = [geminiSystem, ...history.slice(0, leading).map(message => message.content ?? "")].filter(Boolean).join("\n\n");
    if (Buffer.byteLength(system) > maxSystemBytes) throw new ProviderError("invalid_request", "Instructions are too large for the Gemini CLI", 400);
    const conversationId = providerConversationId(context);
    // A compaction, prewarm, memory or side request is served outside a conversation's session, which Gemini has no
    // transport for: it is refused rather than charged as a second copy of the conversation in a new process.
    if (geminiOneShotKinds.has(context.requestKind)) {
      telemetry("gemini_session", { outcome: "refused", missReason: "request_kind", provider: this.config.id, model: request.model });
      throw new CliContinuityUnavailable("Gemini", "request_kind");
    }
    const { conversation, images } = imageConversation(history.slice(leading));
    const forcedTool = typeof choice === "object" ? tools.find(tool => tool.function.name === choice.function.name) : undefined;
    const forced = choice === "required" ? "Use one of the caller tools."
      : typeof choice === "object" ? `Use the required caller tool ${forcedTool ? claudeToolName(forcedTool) : choice.function.name}.` : undefined;
    const alias = Object.entries(this.config.models).find(([, model]) => model === request.model)?.[0];
    const requested = (request.reasoning as { effort?: string } | undefined)?.effort;
    const supported = alias ? this.config.modelMetadata?.[alias]?.reasoningEfforts : undefined;
    const antigravity = this.config.geminiCli === "antigravity";
    const effort = requested && supported?.includes(requested) && (!antigravity || (antigravityEfforts as readonly string[]).includes(requested)) ? requested : undefined;
    const summaryVisible = (request.reasoning as { summary?: string } | undefined)?.summary !== "none";
    const home = this.config.geminiHome;
    if (!home) throw new ProviderError("invalid_request", "The Gemini provider has no Gemini home", 400);
    await (antigravity ? ensureAntigravityHome(home) : ensureGeminiHome(home));
    if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499);
    // A request with no caller conversation identity is a single turn of its own: it gets a fresh session and is never
    // recorded in the ended-store, because nothing is owed to a conversation the caller never named.
    const input: GeminiLiveInput = { scope: this.config.id, home, conversationId: conversationId ?? "", model: request.model, effort,
      command: await (antigravity ? antigravityCommand() : geminiCommand()), system, ephemeral: conversationId === undefined,
      provision: directory => antigravity ? provisionAntigravityHome(home, directory) : provisionGeminiHome(home, directory),
      // The CLI never runs against the persistent home (it would record every prompt there): `provision` supplies each process's own.
      env: () => { throw new ProviderError("cli_failed", "The Gemini CLI must run in a disposable home", 502); }, tools, allTools: normalized.tools || [], catalog: claudeMcpCatalog(tools, true), choice, forced, request, conversation, images,
      leading, summaryVisible, observe: usage => context.observeCacheUsage?.(usage) };
    // A live session continues the conversation's process; it never replays history and has no fallback transport.
    yield* await (antigravity ? antigravityLive(settings) : geminiLive(settings)).attach(input, signal);
  }
}
