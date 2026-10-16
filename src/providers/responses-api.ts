import { apiCredential, type ProviderConfig } from "../config.js";
import { accessToken, ChatGPTLoginRequired, ChatGPTRefreshFailed, type OAuthFailureDetail } from "../auth/chatgpt.js";
import { agentMessageInput, declaredResponsesTools, normalizeResponsesTools } from "../protocol/request.js";
import { readEvents } from "../protocol/sse.js";
import type { ResponsesInputItem, ResponsesRequest, InferenceEvent, ResponseToolIdentity, Usage } from "../protocol/types.js";
import { ProviderError, type InferenceContext, type Provider, type ProviderStreamDiagnostic } from "./provider.js";
import { observeResponsesStream, responsesEOFError, responsesHttpError, responsesStreamError } from "./responses-errors.js";
import { publicServiceTier } from "../protocol/types.js";
import { setTimeout as delay } from "node:timers/promises";
import { ResponsesOutput } from "./responses-output.js";
import { createHash } from "node:crypto";
import { telemetry } from "../telemetry.js";
import { reasoningScope } from "../protocol/reasoning-state.js";
import { unwrapTurnState, wrapTurnState } from "../protocol/turn-state.js";

export class ResponsesAPI implements Provider {
  /** The subscription endpoint's sticky-routing token reaches the caller as a transport event. */
  readonly emitsTransport: boolean;
  private readonly scope: string;
  constructor(private readonly config: ProviderConfig) { this.emitsTransport = config.type === "codex-subscription"; this.scope = reasoningScope(config); }
  async *infer(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext = {}): AsyncGenerator<InferenceEvent> {
    const requestedTier = request.service_tier;
    if (requestedTier !== undefined && requestedTier !== null && !publicServiceTier(requestedTier)) throw new ProviderError("invalid_request", "Invalid Responses service tier", 400);
    const tier = requestedTier === "fast" && this.config.type === "codex-subscription" ? "priority" : requestedTier;
    // Native Codex never refuses Flex: the SDK sends it for every model, so it is exempt from the catalog check.
    if (this.config.type === "codex-subscription" && tier && !["auto", "default", "flex"].includes(String(tier))) {
      const metadata = Object.entries(this.config.models).filter(([, model]) => model === request.model).map(([alias]) => this.config.modelMetadata?.[alias]);
      const declared = metadata.filter(entry => entry?.serviceTiers !== undefined);
      if (declared.length && !declared.some(entry => entry?.serviceTiers?.some(option => option.id === tier))) throw new ProviderError("invalid_request", "Selected Codex model does not offer this service tier", 400);
    }
    const normalized = { ...request };
    if (tier === undefined || tier === null) delete normalized.service_tier;
    else normalized.service_tier = tier;
    // The turn-state is opaque and scoped to this account route; a value from another route is dropped.
    let turnState = this.emitsTransport ? unwrapTurnState(context.turnState, this.scope) : undefined; let transported = false;
    for (let attempt = 0; ; attempt++) {
      let published = false;
      try {
        for await (const event of this.attempt(normalized, signal, context, turnState)) {
          // Response headers are not output, so they never prevent the retry. Only the first reaches the
          // caller, and a retry carries the turn-state it returned, as Codex does for the rest of a turn.
          if (event.type === "transport") { if (!transported) { transported = true; turnState ??= unwrapTurnState(event.turnState, this.scope); yield event; } continue; }
          published = true; yield event;
        }
        return;
      } catch (error) {
        // Caller tools run outside this provider. Retry only a known transient
        // failure before publishing any output, keeping partial turns intact.
        if (attempt || published || signal.aborted || !(error instanceof ProviderError)) throw error;
        // A failed login refresh is never retried here: the refresh token is single-use, so a second
        // token request in the same turn could spend or reuse it. Codex reconnects on the 503 instead.
        if (error.upstream?.event === "oauth_refresh") throw error;
        // Body codes mark a transient failure only in the stream; HTTP 5xx is covered below.
        const temporary = (error.upstream?.event !== "http" && ["server_error", "server_is_overloaded"].includes(error.upstream?.code || "")) ||
          (error.upstream?.event === "http" && ["upstream_unavailable", "rate_limit_exceeded"].includes(error.code)) ||
          (error.code === "incomplete" && error.upstream?.code === "missing_terminal" && error.upstream.event === "eof");
        const backoff = error.upstream?.retryAfterMs ?? 1000;
        if (!temporary || backoff > 30000) throw error;
        console.error(JSON.stringify({ event: "provider_retry", attempt: 2, upstreamCode: error.upstream?.code }));
        telemetry("provider_retry", { provider: this.config.id, attempt: 2, code: error.code, upstreamCode: error.upstream?.code, backoffMs: backoff });
        await delay(backoff, undefined, { signal });
      }
    }
  }
  private async *attempt(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext, turnState: string | undefined): AsyncGenerator<InferenceEvent> {
    const plan = this.config.type === "codex-subscription";
    let credential: string | undefined;
    try { credential = plan ? await accessToken(this.config.credentialFile!) : await apiCredential(this.config); }
    catch (error) {
      // Only a login that needs the user is final. A refresh that failed on the network (for
      // example right after the Mac wakes) or on a 5xx is retried by Codex instead of ending the chat.
      // The OAuth error code is one of a fixed set (never reply text), so it can name the reason.
      const detail: OAuthFailureDetail = error instanceof ChatGPTLoginRequired || error instanceof ChatGPTRefreshFailed ? error.detail : {};
      const upstream = detail.httpStatus ? { code: detail.oauthError, event: "oauth_refresh", httpStatus: detail.httpStatus } : undefined;
      const named = detail.oauthError && detail.oauthError !== "none" ? detail.oauthError : undefined;
      if (!plan || error instanceof ChatGPTLoginRequired) throw new ProviderError("authentication", `ChatGPT provider requires login${named ? ` (refresh rejected: ${named})` : ""}`, 401, upstream);
      throw new ProviderError("upstream_unavailable", `ChatGPT login refresh failed temporarily${named ? ` (${named})` : ""}; retry shortly`, 503, upstream);
    }
    if (!credential) throw new ProviderError("authentication", "API provider credential is missing", 401);
    const body: ResponsesRequest = { ...request, stream: true };
    // Public Responses endpoints reject agent_message items; send their text as a user message instead.
    if (Array.isArray(request.input)) body.input = request.input.flatMap((item): ResponsesInputItem[] => { if ((item as { type?: string }).type !== "agent_message") return [item]; const message = agentMessageInput(item as unknown as Record<string, unknown>); return message ? [message] : []; });
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
      body.input = typeof request.input === "string" ? [{ type: "message", role: "user", content: request.input }] : (body.input as ResponsesInputItem[]).map(item =>
        "role" in item && item.role === "system" ? { ...item, role: "developer" as const } : { ...item });
      const namespaces = new Set(request.tools?.filter(tool => tool.type === "namespace").map(tool => tool.name));
      defaultNamespace = "gateway";
      while (namespaces.has(defaultNamespace)) defaultNamespace += "_";
      const flat = request.tools?.filter(tool => tool.type !== "namespace") || [];
      body.tools = [...(request.tools?.filter(tool => tool.type === "namespace") || []), ...(flat.length ? [{ type: "namespace" as const, name: defaultNamespace, description: "Caller-dispatched tools", tools: flat.map(tool => tool.type === "function" && "function" in tool ? { type: "function" as const, ...tool.function, responseTool: undefined } : tool) }] : [])];
      // Only calls of top-level tools move into the gateway namespace; tools declared
      // in Responses lite `additional_tools` items keep their own namespace.
      const flatNames = new Set(flat.flatMap(tool => tool.type === "function" && "function" in tool ? [tool.function.name] : "name" in tool && typeof tool.name === "string" ? [tool.name] : []));
      if (Array.isArray(body.input)) body.input = body.input.map(item => "name" in item && item.name && !item.namespace && flatNames.has(String(item.name)) ? { ...item, namespace: defaultNamespace } : item);
      if (typeof body.tool_choice === "object" && "name" in body.tool_choice && !body.tool_choice.namespace) body.tool_choice = { ...body.tool_choice, namespace: defaultNamespace };
    }
    const definitions = normalizeResponsesTools(declaredResponsesTools(request));
    const identities = new Map(definitions.map(tool => [tool.function.name, tool.function.responseTool!]));
    const base = plan ? "https://api.openai.com/v1" : this.config.baseUrl!.replace(/\/$/, "");
    // The subscription endpoint keeps a conversation's prompt cache warm only
    // when it sees the caller's own session and thread identifiers.
    const routing = plan ? { ...(context.sessionId ? { "session-id": context.sessionId } : {}), ...(context.threadId ? { "thread-id": context.threadId } : {}),
      ...(turnState ? { "x-codex-turn-state": turnState } : {}) } : {};
    const response = await fetch(`${base}/responses`, { method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}`, ...routing }, body: JSON.stringify(body) });
    if (!response.ok) throw await responsesHttpError(response);
    if (!response.body) throw new ProviderError("incomplete", "Provider returned no stream");
    // Always announce the response head, so the caller's headers never wait for a turn-state that may not come.
    if (plan) { const returned = wrapTurnState(response.headers.get("x-codex-turn-state"), this.scope); yield { type: "transport", ...(returned ? { turnState: returned } : {}) }; }
    let done = false; const output = new ResponsesOutput();
    const calls = new Map<string, { signature: string; identity: string; input: string }>();
    const unfinished = new Map<string, { identity: string; length: number; digest: string }>();
    const stream: ProviderStreamDiagnostic = { events: 0, reasoningItems: 0, textDeltas: 0, toolCalls: 0 };
    const identityFor = (item: Record<string, unknown>): ResponseToolIdentity => {
      const namespace = item.namespace === defaultNamespace ? undefined : item.namespace as string | undefined;
      const name = String(item.name); const alias = namespace ? `${namespace}.${name}` : name;
      const identity = identities.get(alias);
      if (!identity) throw new ProviderError("invalid_tool_call", "Provider returned a tool outside the caller's catalog");
      return identity;
    };
    const toolInput = (item: Record<string, unknown>) => {
      const invalid = () => new ProviderError("invalid_tool_call", "Provider returned an invalid or duplicate tool call");
      if (typeof item.call_id !== "string" || !item.call_id || item.call_id.length > 1024 || item.call_id.includes("\0") ||
        typeof item.name !== "string" || !item.name || (item.namespace !== undefined && typeof item.namespace !== "string") ||
        (item.id !== undefined && (typeof item.id !== "string" || !item.id || item.id.length > 1024 || item.id.includes("\0")))) throw invalid();
      const arguments_ = item.type === "custom_tool_call" ? item.input : item.arguments;
      if (typeof arguments_ !== "string") throw invalid();
      const responseTool = identityFor(item);
      return { id: item.call_id, name: item.name, input: arguments_, responseTool, identity: JSON.stringify([item.type, responseTool]) };
    };
    const matchesPending = (value: ReturnType<typeof toolInput>) => {
      const pending = unfinished.get(value.id);
      if (pending && (pending.identity !== value.identity || createHash("sha256").update(value.input.slice(0, pending.length)).digest("hex") !== pending.digest)) throw new ProviderError("invalid_tool_call", "Provider changed an unfinished tool call");
    };
    const partialTool = (item: Record<string, unknown>): void => {
      const value = toolInput(item); matchesPending(value);
      const completed = calls.get(value.id);
      if (completed) {
        if (completed.identity !== value.identity || !completed.input.startsWith(value.input)) throw new ProviderError("invalid_tool_call", "Provider changed a completed tool call");
        return;
      }
      if (!unfinished.has(value.id) && calls.size + unfinished.size >= 1024) throw new ProviderError("invalid_tool_call", "Provider returned too many tool calls");
      unfinished.set(value.id, { identity: value.identity, length: value.input.length, digest: createHash("sha256").update(value.input).digest("hex") });
    };
    const tool = (item: Record<string, unknown>, snapshot: boolean): InferenceEvent[] => {
      const invalid = () => new ProviderError("invalid_tool_call", "Provider returned an invalid or duplicate tool call");
      const value = toolInput(item), arguments_ = value.input;
      if (item.status !== undefined && item.status !== "completed") throw invalid();
      if (item.type === "function_call") try { JSON.parse(arguments_); } catch { throw invalid(); }
      matchesPending(value);
      const signature = JSON.stringify([item.type, item.name, item.namespace, arguments_]);
      const previous = calls.get(value.id);
      if (previous !== undefined) {
        if (snapshot && previous.signature === signature) return [];
        throw invalid();
      }
      if (!unfinished.has(value.id) && calls.size + unfinished.size >= 1024) throw invalid();
      unfinished.delete(value.id); calls.set(value.id, { signature, identity: value.identity, input: arguments_ }); stream.toolCalls = calls.size;
      output.toolBoundary();
      return [{ type: "tool", call: { id: value.id, type: "function", responseTool: value.responseTool, function: {
        name: value.name, arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: arguments_ }) : arguments_,
      } } }];
    };
    const itemDone = (item: Record<string, unknown>, snapshot = false, interrupted = false): InferenceEvent[] => {
      if (item.type === "message") return output.done(item, snapshot, interrupted || item.status === "incomplete");
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        // An interrupted final snapshot can contain an unfinished call. Only a
        // genuine item.done boundary or explicitly completed snapshot dispatches it.
        if ((interrupted || item.status === "incomplete" || item.status === "in_progress") && item.status !== "completed") {
          if (item.status !== undefined && item.status !== "in_progress" && item.status !== "incomplete") throw new ProviderError("invalid_tool_call", "Provider returned invalid tool completion metadata");
          partialTool(item);
          return [];
        }
        return tool(item, snapshot);
      }
      if (item.type === "reasoning") return [{ type: "reasoning-state", item: hideSummary ? { ...item, summary: [] } : item }];
      throw new ProviderError("invalid_output", "Provider returned unsupported response output");
    };
    for await (const event of readEvents(response.body)) {
      observeResponsesStream(stream, event);
      if (!hideSummary && event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") yield { type: "reasoning", text: event.delta, id: String(event.item_id), summaryIndex: Number(event.summary_index) || 0 };
      if (event.type === "response.output_item.added") {
        const item = event.item as Record<string, unknown>;
        if (item?.type === "message") output.added(item);
        if (item?.type === "reasoning") yield { type: "reasoning-state", item: hideSummary ? { ...item, summary: [] } : item };
      }
      if (event.type === "response.output_text.delta") yield* output.delta(event);
      if (event.type === "response.output_item.done") {
        const item = event.item as Record<string, unknown>;
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new ProviderError("invalid_output", "Provider returned invalid response output");
        yield* itemDone(item);
      }
      const terminal = event.type === "response.completed" || event.type === "response.incomplete";
      const completed = event.response as { id?: unknown; status?: unknown; error?: unknown; incomplete_details?: { reason?: unknown }; output_text?: unknown; output?: unknown; usage?: Usage; service_tier?: unknown; end_turn?: unknown };
      const interrupted = event.type === "response.incomplete" && completed?.incomplete_details?.reason === "interrupted";
      const capped = context.clientProtocol === "messages" && event.type === "response.incomplete" && completed?.incomplete_details?.reason === "max_output_tokens";
      if (event.type === "error" || event.type === "response.failed" || (event.type === "response.incomplete" && !interrupted && !capped)) throw responsesStreamError(event, response.headers.get("x-request-id") || undefined);
      if (terminal) {
        if (!completed || typeof completed !== "object" || Array.isArray(completed)) throw new ProviderError("invalid_output", "Provider returned invalid response completion metadata");
        if (completed.error !== undefined && completed.error !== null) throw responsesStreamError(event, response.headers.get("x-request-id") || undefined);
        if (completed.status !== undefined && completed.status !== (interrupted || capped ? "incomplete" : "completed")) throw new ProviderError("incomplete", "Provider did not complete the response");
        if ((interrupted || capped || completed.status === undefined) && (typeof completed.id !== "string" || !completed.id || completed.id.length > 1024 || completed.id.includes("\0"))) throw new ProviderError("invalid_output", "Provider returned invalid response completion identity");
        if (completed.end_turn !== undefined && typeof completed.end_turn !== "boolean") throw new ProviderError("invalid_output", "Provider returned invalid turn completion metadata");
        if (completed.output !== undefined) {
          if (!Array.isArray(completed.output) || completed.output.length > 1024) throw new ProviderError("invalid_output", "Provider returned invalid response output");
          const snapshotIds = new Set<string>(); const snapshotCalls = new Set<string>();
          for (const item of completed.output) {
            if (!item || typeof item !== "object" || Array.isArray(item)) throw new ProviderError("invalid_output", "Provider returned invalid response output");
            if (item.id !== undefined) {
              if (typeof item.id !== "string" || !item.id || item.id.length > 1024 || item.id.includes("\0") || snapshotIds.has(item.id)) throw new ProviderError("invalid_output", "Provider returned invalid or duplicate output identity");
              snapshotIds.add(item.id);
            }
            if (item.type === "function_call" || item.type === "custom_tool_call") {
              if (typeof item.call_id !== "string" || snapshotCalls.has(item.call_id)) throw new ProviderError("invalid_tool_call", "Provider returned a duplicate tool call");
              snapshotCalls.add(item.call_id);
            }
            yield* itemDone(item, true, interrupted || capped);
          }
        }
        if (!output.hasText && completed.output_text !== undefined) {
          if (typeof completed.output_text !== "string") throw new ProviderError("invalid_output", "Provider returned invalid assistant output");
          yield* output.legacy(completed.output_text);
        }
        if (!interrupted && unfinished.size) throw new ProviderError("invalid_tool_call", "Provider completed the response with unfinished tool calls");
        if (capped && calls.size) throw new ProviderError("incomplete", "Provider reached its output limit while returning tools");
        yield* output.finish(interrupted || capped);
        done = true;
        const serviceTier = publicServiceTier(completed.service_tier);
        yield { type: "done", usage: completed.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, ...(serviceTier ? { serviceTier } : {}),
          ...(capped ? { stopReason: "max_tokens" as const } : {}),
          ...(interrupted ? { interrupted: true, endTurn: false } : completed.end_turn === undefined ? {} : { endTurn: completed.end_turn }) };
        break;
      }
    }
    if (!done) throw responsesEOFError(stream, response.headers.get("x-request-id") || undefined);
  }
}
