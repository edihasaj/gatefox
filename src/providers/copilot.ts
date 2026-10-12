import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "../config.js";
import { responsesToChatRequest } from "../protocol/request.js";
import type { ResponsesRequest, InferenceEvent, OpenAITool, OpenAIToolCall, Usage } from "../protocol/types.js";
import { openCopilot } from "./copilot-client.js";
import { record } from "./copilot-rpc.js";
import { ProviderError, type Provider } from "./provider.js";
import { imageConversation } from "../protocol/images.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { copilotContextFailure } from "./context-errors.js";

export function copilotEffort(config: ProviderConfig, request: ResponsesRequest): string | undefined {
  const effort = record(request.reasoning).effort;
  const alias = Object.entries(config.models).find(([, model]) => model === request.model)?.[0];
  const supported = alias ? config.modelMetadata?.[alias]?.reasoningEfforts : undefined;
  if (effort !== undefined && (typeof effort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort) || (supported && !supported.includes(effort)))) throw new ProviderError("invalid_request", "Selected Copilot model does not support this reasoning effort", 400);
  return effort as string | undefined;
}

export function nativeCopilotCalls(value: unknown, tools: OpenAITool[]): OpenAIToolCall[] {
  if (!Array.isArray(value)) throw new ProviderError("invalid_tool_call", "Copilot returned invalid tool requests");
  const ids = new Set<string>();
  return value.map(raw => {
    const call = record(raw); const match = typeof call.name === "string" && call.name.match(/^gateway_tool_(\d+)$/);
    const definition = match ? tools[Number(match[1])]?.function : undefined;
    if (!definition || call.type !== "function" || typeof call.toolCallId !== "string" || !call.toolCallId || ids.has(call.toolCallId) || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new ProviderError("invalid_tool_call", "Copilot returned an unknown, duplicate, or malformed tool call");
    ids.add(call.toolCallId);
    if (definition.responseTool?.type === "custom" && typeof record(call.arguments).input !== "string") throw new ProviderError("invalid_tool_call", "Free-form input must be a string");
    return { id: call.toolCallId, type: "function", responseTool: definition.responseTool, function: { name: definition.name, arguments: JSON.stringify(call.arguments) } };
  });
}

export class CopilotSubscription implements Provider {
  constructor(private readonly config: ProviderConfig) {}
  async *infer(request: ResponsesRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    const normalized = responsesToChatRequest(request); const choice = normalized.tool_choice;
    const tools = choice === "none" ? [] : (normalized.tools || []).filter(tool => typeof choice !== "object" || tool.function.name === choice.function.name);
    const effort = copilotEffort(this.config, request);
    const summary = record(request.reasoning).summary;
    const { conversation, images } = imageConversation(normalized.messages);
    const client = await openCopilot(this.config, signal); const sessionId = randomUUID();
    let text = ""; let final = false; let subscriptionVerified = false;
    let usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    try {
      await client.rpc.request("session.create", {
        sessionId, model: request.model, allowedModels: [request.model], streaming: true, ...(effort ? { reasoningEffort: effort } : {}),
        reasoningSummary: summary === "none" ? "none" : summary === "detailed" ? "detailed" : "concise",
        tools: tools.map((tool, index) => ({ name: `gateway_tool_${index}`, description: `Caller tool ${tool.function.name}. ${tool.function.description || ""}`, parameters: tool.function.parameters || { type: "object", properties: {} } })),
        availableTools: tools.map((_, index) => `gateway_tool_${index}`),
        systemMessage: { mode: "replace", content: "You are an inference backend. Respect system/developer messages in the supplied conversation. Use only supplied caller-dispatched tools. The caller executes actions and supplies results. Never execute native tools, spawn agents, or invent tool-call text. Otherwise answer normally." },
        workingDirectory: client.directory, configDir: client.directory, enableConfigDiscovery: false,
        enableSkills: false, enableFileHooks: false, enableHostGitOperations: false, enableSessionStore: false,
        mcpServers: {}, pluginDirectories: [], customAgents: [], infiniteSessions: { enabled: false },
        memory: { enabled: false }, requestPermission: true, requestUserInput: false,
      });
      const aliases = tools.map((tool, index) => ({ caller: tool.function.name, native: `gateway_tool_${index}` }));
      const attachments = await Promise.all(images.map(async ({ label, image }) => {
        const extension = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType.split("/")[1];
        const path = join(client.directory, `${label}.${extension}`);
        await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
        return { type: "file", path, displayName: label };
      }));
      await client.rpc.request("session.send", { sessionId, ...(attachments.length ? { attachments } : {}), prompt: `Tool names: ${JSON.stringify(aliases)}\n${choice === "required" || typeof choice === "object" ? "Use the required caller tool.\n" : ""}Conversation: ${JSON.stringify(conversation)}` });
      for await (const message of client.rpc.notifications()) {
        const params = record(message.params); if (params.sessionId !== sessionId) continue;
        const event = record(params.event); const data = record(event.data);
        if (event.agentId) throw new ProviderError("invalid_stream", "Copilot emitted an unexpected sub-agent event");
        if (event.type === "permission.requested" || event.type === "external_tool.requested") throw new ProviderError("invalid_tool_call", "Copilot requested execution beyond caller-dispatched inference");
        if (event.type === "session.error") {
          const context = copilotContextFailure(data); if (context) throw context;
          const diagnostic = typeof data.message === "string" ? data.message : "";
          if (/unsupported value|invalid value|not supported with|model.+not available/i.test(diagnostic)) throw new ProviderError("invalid_request", "Copilot rejected the requested model or reasoning option", 400);
          if (/rate.?limit|usage.?limit|quota.+exceed/i.test(diagnostic)) throw new ProviderError("usage_limit", "Copilot subscription usage limit reached", 429);
          throw new ProviderError("inference_failed", "Copilot inference did not complete; check its subscription and model access");
        }
        if (event.type === "assistant.message_delta" && typeof data.deltaContent === "string") {
          text += data.deltaContent; if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new ProviderError("output_too_large", "Copilot output exceeds 8 MiB");
          yield { type: "text", text: data.deltaContent };
        }
        if (event.type === "assistant.reasoning_delta" && typeof data.deltaContent === "string" && summary !== "none") yield { type: "reasoning", text: data.deltaContent, ...(typeof data.reasoningId === "string" ? { id: data.reasoningId } : {}) };
        if (event.type === "assistant.usage") {
          if (data.isByok === true) throw new ProviderError("account_route", "Copilot attempted BYOK inference");
          if (data.isByok !== false && data.provider !== "copilot") throw new ProviderError("subscription_unverified", "Copilot did not verify subscription inference");
          subscriptionVerified = true;
          const input = typeof data.inputTokens === "number" ? data.inputTokens : 0; const output = typeof data.outputTokens === "number" ? data.outputTokens : 0;
          usage = { input_tokens: input, output_tokens: output, total_tokens: input + output };
        }
        if (event.type === "assistant.message") {
          // Protocol 3 in CLI 1.0.91 omits this optional field. Its preceding
          // isByok:false usage and exact model still attest the subscription route.
          if (data.providerId !== undefined && data.providerId !== "copilot") throw new ProviderError("provider_route", "Copilot changed the requested subscription route");
          if (data.model !== request.model) {
            const actual = typeof data.model === "string" && Object.values(this.config.models).includes(data.model) ? data.model : "an unexpected model";
            throw new ProviderError("model_route", `Copilot returned ${actual} instead of the requested model`);
          }
          if (!subscriptionVerified) throw new ProviderError("subscription_unverified", "Copilot did not verify subscription inference");
          const content = typeof data.content === "string" ? data.content : "";
          if (!content.startsWith(text)) throw new ProviderError("inconsistent_stream", "Copilot final text differs from streamed text");
          if (content.length > text.length) yield { type: "text", text: content.slice(text.length) };
          final = true;
          if (Array.isArray(data.toolRequests) && data.toolRequests.length) {
            for (const call of nativeCopilotCalls(data.toolRequests, tools)) yield { type: "tool", call };
            yield { type: "done", usage }; return;
          }
          if (choice === "required" || typeof choice === "object") throw new ProviderError("invalid_tool_call", "Copilot did not return the required tool call");
        }
        if (event.type === "assistant.idle") {
          if (!final) throw new ProviderError("incomplete", "Copilot became idle without a final response");
          yield { type: "done", usage }; return;
        }
      }
      throw new ProviderError("incomplete", "Copilot stream ended without completion");
    } catch (error) { if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499); throw error; }
    finally { await client.close(sessionId); }
  }
}
