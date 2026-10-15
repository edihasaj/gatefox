import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "../config.js";
import { responsesToChatRequest } from "../protocol/request.js";
import type { ResponsesRequest, InferenceEvent } from "../protocol/types.js";
import { openCopilot } from "./copilot-client.js";
import { record } from "./copilot-rpc.js";
import { ProviderError, type Provider } from "./provider.js";
import { imageConversation } from "../protocol/images.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CopilotTurn } from "./copilot-turn.js";

export { nativeCopilotCalls } from "./copilot-turn.js";

/** Protocol 3 supports Auto routing profiles, but no selected-model service tier. */
export function validateCopilotServiceTier(request: ResponsesRequest): void {
  const tier = request.service_tier;
  if (tier === undefined || tier === null || tier === "auto" || tier === "default") return;
  if (tier === "priority" || tier === "fast") throw new ProviderError("invalid_request", "Copilot Fast mode is unavailable: its CLI does not support a priority tier for the selected model", 400);
  throw new ProviderError("invalid_request", "Copilot does not support the requested service tier", 400);
}

export function copilotEffort(config: ProviderConfig, request: ResponsesRequest): string | undefined {
  const effort = record(request.reasoning).effort;
  const alias = Object.entries(config.models).find(([, model]) => model === request.model)?.[0];
  const supported = alias ? config.modelMetadata?.[alias]?.reasoningEfforts : undefined;
  if (effort !== undefined && (typeof effort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort) || (supported && !supported.includes(effort)))) throw new ProviderError("invalid_request", "Selected Copilot model does not support this reasoning effort", 400);
  return effort as string | undefined;
}

export class CopilotSubscription implements Provider {
  constructor(private readonly config: ProviderConfig) {}
  async *infer(request: ResponsesRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    validateCopilotServiceTier(request);
    const normalized = responsesToChatRequest(request); const choice = normalized.tool_choice;
    const tools = choice === "none" ? [] : (normalized.tools || []).filter(tool => typeof choice !== "object" || tool.function.name === choice.function.name);
    const effort = copilotEffort(this.config, request);
    const summary = record(request.reasoning).summary;
    const { conversation, images } = imageConversation(normalized.messages);
    const client = await openCopilot(this.config, signal); const sessionId = randomUUID();
    const turn = new CopilotTurn({ model: request.model, offered: Object.values(this.config.models), tools, choice, summary });
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
        const step = turn.accept(record(params.event));
        yield* step.events;
        if (step.end) { yield turn.done(); return; }
      }
      throw new ProviderError("incomplete", "Copilot stream ended without completion");
    } catch (error) { if (signal.aborted) throw new ProviderError("cancelled", "Request cancelled", 499); throw error; }
    finally { await client.close(sessionId); }
  }
}
