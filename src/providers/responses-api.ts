import { apiCredential, type ProviderConfig } from "../config.js";
import { accessToken } from "../auth/chatgpt.js";
import { normalizeResponsesTools } from "../protocol/request.js";
import { readEvents } from "../protocol/sse.js";
import type { ResponsesRequest, InferenceEvent, ResponseToolIdentity, Usage } from "../protocol/types.js";
import { ProviderError, type Provider } from "./provider.js";
import { responsesHttpError, responsesStreamError } from "./responses-errors.js";
import { publicServiceTier } from "../protocol/types.js";
import { setTimeout as delay } from "node:timers/promises";

export class ResponsesAPI implements Provider {
  constructor(private readonly config: ProviderConfig) {}
  async *infer(request: ResponsesRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    const requestedTier = request.service_tier;
    if (requestedTier !== undefined && requestedTier !== null && !publicServiceTier(requestedTier)) throw new ProviderError("invalid_request", "Invalid Responses service tier", 400);
    const tier = requestedTier === "fast" && this.config.type === "codex-subscription" ? "priority" : requestedTier;
    if (this.config.type === "codex-subscription" && tier && !["auto", "default"].includes(String(tier))) {
      const metadata = Object.entries(this.config.models).filter(([, model]) => model === request.model).map(([alias]) => this.config.modelMetadata?.[alias]);
      const declared = metadata.filter(entry => entry?.serviceTiers !== undefined);
      if (declared.length && !declared.some(entry => entry?.serviceTiers?.some(option => option.id === tier))) throw new ProviderError("invalid_request", "Selected Codex model does not offer this service tier", 400);
    }
    const normalized = { ...request };
    if (tier === undefined || tier === null) delete normalized.service_tier;
    else normalized.service_tier = tier;
    for (let attempt = 0; ; attempt++) {
      let published = false;
      try {
        for await (const event of this.attempt(normalized, signal)) { published = true; yield event; }
        return;
      } catch (error) {
        // Caller tools run outside this provider. Retry only a known transient
        // failure before publishing any output, keeping partial turns intact.
        if (attempt || published || signal.aborted || !(error instanceof ProviderError)) throw error;
        const temporary = ["server_error", "server_is_overloaded"].includes(error.upstream?.code || "") ||
          (error.upstream?.event === "http" && ["upstream_unavailable", "rate_limit_exceeded"].includes(error.code));
        const backoff = error.upstream?.retryAfterMs ?? 1000;
        if (!temporary || backoff > 30000) throw error;
        console.error(JSON.stringify({ event: "provider_retry", attempt: 2, upstreamCode: error.upstream?.code }));
        await delay(backoff, undefined, { signal });
      }
    }
  }
  private async *attempt(request: ResponsesRequest, signal: AbortSignal): AsyncGenerator<InferenceEvent> {
    const plan = this.config.type === "codex-subscription";
    let credential: string | undefined;
    try { credential = plan ? await accessToken(this.config.credentialFile!) : await apiCredential(this.config); }
    catch { throw new ProviderError("authentication", "ChatGPT provider requires login", 401); }
    if (!credential) throw new ProviderError("authentication", "API provider credential is missing", 401);
    const body: ResponsesRequest = { ...request, stream: true };
    const hideSummary = (request.reasoning as { summary?: string } | undefined)?.summary === "none";
    // Responses wire values omit the summary to disable it. Codex's local
    // setting uses "none", which is not accepted by the upstream endpoint.
    if (hideSummary) { body.reasoning = { ...(body.reasoning as Record<string, unknown>) }; delete (body.reasoning as Record<string, unknown>).summary; }
    let defaultNamespace = "";
    if (plan) {
      if (body.previous_response_id) throw new ProviderError("invalid_request", "ChatGPT plan requires replayed history rather than previous_response_id", 400);
      const unsupported = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user"];
      if (unsupported.some(key => body[key] !== undefined)) throw new ProviderError("invalid_request", "ChatGPT plan request contains unsupported options", 400);
      body.store = false;
      body.include = [...new Set([...(Array.isArray(body.include) ? body.include as string[] : []), "reasoning.encrypted_content"])];
      body.input = typeof request.input === "string" ? [{ type: "message", role: "user", content: request.input }] : request.input.map(item =>
        "role" in item && item.role === "system" ? { ...item, role: "developer" as const } : { ...item });
      const namespaces = new Set(request.tools?.filter(tool => tool.type === "namespace").map(tool => tool.name));
      defaultNamespace = "gateway";
      while (namespaces.has(defaultNamespace)) defaultNamespace += "_";
      const flat = request.tools?.filter(tool => tool.type !== "namespace") || [];
      body.tools = [...(request.tools?.filter(tool => tool.type === "namespace") || []), ...(flat.length ? [{ type: "namespace" as const, name: defaultNamespace, description: "Caller-dispatched tools", tools: flat.map(tool => tool.type === "function" && "function" in tool ? { type: "function" as const, ...tool.function, responseTool: undefined } : tool) }] : [])];
      if (Array.isArray(body.input)) body.input = body.input.map(item => "name" in item && item.name && !item.namespace ? { ...item, namespace: defaultNamespace } : item);
      if (typeof body.tool_choice === "object" && "name" in body.tool_choice && !body.tool_choice.namespace) body.tool_choice = { ...body.tool_choice, namespace: defaultNamespace };
    }
    const definitions = normalizeResponsesTools(request.tools);
    const identities = new Map(definitions.map(tool => [tool.function.name, tool.function.responseTool!]));
    const base = plan ? "https://api.openai.com/v1" : this.config.baseUrl!.replace(/\/$/, "");
    const response = await fetch(`${base}/responses`, { method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` }, body: JSON.stringify(body) });
    if (!response.ok) throw await responsesHttpError(response);
    if (!response.body) throw new ProviderError("incomplete", "Provider returned no stream");
    let done = false; let textSeen = false; const calls = new Set<string>();
    const identityFor = (item: Record<string, unknown>): ResponseToolIdentity => {
      const namespace = item.namespace === defaultNamespace ? undefined : item.namespace as string | undefined;
      const name = String(item.name); const alias = namespace ? `${namespace}.${name}` : name;
      const identity = identities.get(alias);
      if (!identity) throw new ProviderError("invalid_tool_call", "Provider returned a tool outside the caller's catalog");
      return identity;
    };
    for await (const event of readEvents(response.body)) {
      if (!hideSummary && event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") yield { type: "reasoning", text: event.delta, id: String(event.item_id), summaryIndex: Number(event.summary_index) || 0 };
      if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && (event.item as { type?: string })?.type === "reasoning") yield { type: "reasoning-state", item: hideSummary ? { ...(event.item as Record<string, unknown>), summary: [] } : event.item as Record<string, unknown> };
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") { textSeen = true; yield { type: "text", text: event.delta }; }
      if (event.type === "response.output_item.done") {
        const item = event.item as Record<string, unknown>;
        if (item.type === "function_call" || item.type === "custom_tool_call") {
          if (typeof item.call_id !== "string" || calls.has(item.call_id)) throw new ProviderError("invalid_tool_call", "Provider returned an invalid or duplicate call ID");
          calls.add(item.call_id);
          if ((item.type === "custom_tool_call" && typeof item.input !== "string") || (item.type === "function_call" && typeof item.arguments !== "string")) throw new ProviderError("invalid_tool_call", "Provider returned invalid tool input");
          yield { type: "tool", call: { id: item.call_id, type: "function", responseTool: identityFor(item), function: {
            name: String(item.name), arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: item.input }) : String(item.arguments),
          } } };
        }
      }
      if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") throw responsesStreamError(event, response.headers.get("x-request-id") || undefined);
      if (event.type === "response.completed") {
        const completed = event.response as { status?: string; output_text?: string; usage?: Usage; service_tier?: unknown };
        if (completed.status !== "completed") throw new ProviderError("incomplete", "Provider did not complete the response");
        if (!textSeen && completed.output_text) yield { type: "text", text: completed.output_text };
        done = true;
        const serviceTier = publicServiceTier(completed.service_tier);
        yield { type: "done", usage: completed.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, ...(serviceTier ? { serviceTier } : {}) };
        break;
      }
    }
    if (!done) throw new ProviderError("incomplete", "Provider stream ended without completion");
  }
}
