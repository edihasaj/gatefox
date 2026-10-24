import { apiCredential, bridgesToolSearch, type ProviderConfig } from "../config.js";
import { accessToken, ChatGPTLoginRequired, ChatGPTRefreshFailed, type OAuthFailureDetail } from "../auth/chatgpt.js";
import { agentMessageInput, declaredResponsesTools, normalizeResponsesTools, searchLoadedTools } from "../protocol/request.js";
import { BridgeCallError, bridgeToolSearch, bridgedSearchCall, missingTools } from "../protocol/tool-search-bridge.js";
import { readEvents } from "../protocol/sse.js";
import type { ResponsesInputItem, ResponsesNamespaceTool, ResponsesRequest, ResponsesTool, ResponsesToolSearchTool, InferenceEvent, ResponseToolIdentity, Usage } from "../protocol/types.js";
import { ProviderError, type InferenceContext, type Provider, type ProviderStreamDiagnostic } from "./provider.js";
import { observeResponsesStream, responsesEOFError, responsesHttpError, responsesStreamError } from "./responses-errors.js";
import { publicServiceTier } from "../protocol/types.js";
import { setTimeout as delay } from "node:timers/promises";
import { ResponsesOutput } from "./responses-output.js";
import { createHash } from "node:crypto";
import { telemetry } from "../telemetry.js";
import { reasoningScope } from "../protocol/reasoning-state.js";
import { unwrapTurnState, wrapTurnState } from "../protocol/turn-state.js";
import { plaintextCollaborationTransport, subscriptionCollaborationTransport } from "../protocol/collaboration-transport.js";
import { apiRoutingHeaders } from "./api-routing.js";
import { grokToolBridge } from "./grok-tools.js";
import { codexUsageFromEvent, codexUsageFromHeaders, credentialRevision, observeCodexUsage, type CodexUsageObserver } from "./codex-usage.js";
import { classifyNetworkFailure, type ProviderNetworkStage } from "../provider-network.js";

/** Convert only a recognized raw transport error at a fetch/body boundary. */
function networkProviderError(error: unknown, stage: ProviderNetworkStage): ProviderError | undefined {
  try { if (error instanceof ProviderError) return; } catch { return; }
  const failure = classifyNetworkFailure(error);
  if (failure.kind === "unknown" || failure.kind === "abort") return;
  return new ProviderError("upstream_unavailable", "Provider connection failed or disconnected; retry when its connection is available", 503, {
    event: "network", stage, ...(failure.code ? { code: failure.code } : {}), ...(failure.kind === "transient" ? { retryableNetwork: true as const } : {}),
  });
}

export class ResponsesAPI implements Provider {
  /** The subscription endpoint's sticky-routing token reaches the caller as a transport event. */
  readonly emitsTransport: boolean;
  private readonly scope: string;
  /** `onCodexUsage` only ever sees what the Codex subscription backend itself reported; it cannot affect a request. */
  constructor(private readonly config: ProviderConfig, private readonly onCodexUsage?: CodexUsageObserver) { this.emitsTransport = config.type === "codex-subscription"; this.scope = reasoningScope(config); }
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
    let normalized = { ...request }; let bridgeName: string | undefined;
    // An opted-in Codex route sends the client's search as a function (see tool-search-bridge.ts); once per request, not per retry.
    if (this.config.type === "codex-subscription" && bridgesToolSearch(this.config)) {
      // Only a request that declares search can make the model call the bridge function, so only then are calls intercepted.
      const bridged = bridgeToolSearch(normalized); normalized = bridged.request; bridgeName = bridged.counts.tools ? bridged.name : undefined;
      if (bridged.counts.tools || bridged.counts.calls || bridged.counts.outputs) telemetry("tool_search_bridged", { provider: this.config.id, ...bridged.counts });
    }
    if (tier === undefined || tier === null) delete normalized.service_tier;
    else normalized.service_tier = tier;
    // The turn-state is opaque and scoped to this account route; a value from another route is dropped.
    let turnState = this.emitsTransport ? unwrapTurnState(context.turnState, this.scope) : undefined; let transported = false;
    for (let attempt = 0; ; attempt++) {
      let published = false;
      try {
        for await (const event of this.attempt(normalized, signal, context, turnState, bridgeName)) {
          // Response headers are not output, so they never prevent the retry. Only the first reaches the
          // caller, and a retry carries the turn-state it returned, as Codex does for the rest of a turn.
          if (event.type === "transport") { if (!transported) { transported = true; turnState ??= unwrapTurnState(event.turnState, this.scope); yield event; } continue; }
          published = true; yield event;
        }
        return;
      } catch (error) {
        // Caller tools run outside this provider. Retry only a known transient
        // failure before publishing any output, keeping partial turns intact.
        let typed = false; try { typed = error instanceof ProviderError; } catch { /* Hostile errors are never retryable. */ }
        if (attempt || published || signal.aborted || !typed) throw error;
        const failure = error as ProviderError;
        // A failed login refresh is never retried here: the refresh token is single-use, so a second
        // token request in the same turn could spend or reuse it. Codex reconnects on the 503 instead.
        if (failure.upstream?.event === "oauth_refresh") throw failure;
        // Body codes mark a transient failure only in the stream; HTTP 5xx is covered below.
        const temporary = failure.upstream?.event === "network" && failure.upstream.retryableNetwork === true ||
          (failure.upstream?.event !== "http" && ["server_error", "server_is_overloaded"].includes(failure.upstream?.code || "")) ||
          (failure.upstream?.event === "http" && ["upstream_unavailable", "rate_limit_exceeded"].includes(failure.code)) ||
          (failure.code === "inference_failed" && ["error", "response.failed"].includes(failure.upstream?.event || "") && failure.upstream?.code === "unknown") ||
          (failure.code === "incomplete" && failure.upstream?.code === "missing_terminal" && failure.upstream.event === "eof");
        const backoff = failure.upstream?.retryAfterMs ?? 1000;
        if (!temporary || backoff > 30000) throw failure;
        const upstreamCode = failure.upstream?.code;
        const networkStage = failure.upstream?.event === "network" ? failure.upstream.stage : undefined;
        console.error(JSON.stringify({ event: "provider_retry", attempt: 2, ...(upstreamCode ? { upstreamCode } : {}) }));
        telemetry("provider_retry", { provider: this.config.id, attempt: 2, code: failure.code, ...(upstreamCode ? { upstreamCode } : {}), ...(networkStage ? { upstreamStage: networkStage } : {}), backoffMs: backoff });
        await delay(backoff, undefined, { signal });
      }
    }
  }
  private async *attempt(request: ResponsesRequest, signal: AbortSignal, context: InferenceContext, turnState: string | undefined, bridgeName?: string): AsyncGenerator<InferenceEvent> {
    const plan = this.config.type === "codex-subscription";
    let credential: string | undefined;
    // The credential file as it was before and after the token was read. If it changed in between (a refresh or a replacement),
    // the account this request ran as is unknown, so no counter from it is attributed to any account.
    const revisionBefore = plan && this.onCodexUsage ? credentialRevision(this.config.credentialFile) : undefined;
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
    const revision = revisionBefore !== undefined && credentialRevision(this.config.credentialFile) === revisionBefore ? revisionBefore : undefined;
    const body: ResponsesRequest = { ...request, stream: true };
    // Public Responses endpoints reject agent_message items; send their text as a user message instead.
    if (Array.isArray(request.input)) body.input = request.input.flatMap((item): ResponsesInputItem[] => { if ((item as { type?: string }).type !== "agent_message") return [item]; const message = agentMessageInput(item as unknown as Record<string, unknown>); return message ? [message] : []; });
    const hideSummary = (request.reasoning as { summary?: string } | undefined)?.summary === "none";
    // Responses wire values omit the summary to disable it. Codex's local
    // setting uses "none", which is not accepted by the upstream endpoint.
    if (hideSummary) { body.reasoning = { ...(body.reasoning as Record<string, unknown>) }; delete (body.reasoning as Record<string, unknown>).summary; }
    const hosted = (tool: unknown) => typeof tool === "object" && tool !== null && (tool as { type?: unknown }).type === "web_search";
    const hostedItem = (item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item) && (item as { type?: unknown }).type === "web_search_call";
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
      // The ChatGPT backend refuses a forwarded `tool_search` tool (HTTP 400, seen in production on 0.4.4), so the tool, in the
      // request or in a Responses lite `additional_tools` item, and any replayed search items are dropped; the rest of the turn
      // runs as it would without search. Codex rows keep search off, so only an engine that still holds an older catalog sends them.
      // The hosted `web_search` tool is the one hosted tool this backend allows (its refusal names it: `subscription_sharing_
      // unsupported_capability`), so it is forwarded unchanged: at the top level, never in the gateway namespace, kept inside
      // `additional_tools` items, and its replayed `web_search_call` items go upstream as sent.
      const search = (tool: unknown) => typeof tool === "object" && tool !== null && (tool as { type?: unknown }).type === "tool_search";
      const searchItem = (item: ResponsesInputItem) => "type" in item && (item.type === "tool_search_call" || item.type === "tool_search_output");
      let droppedTools = (request.tools || []).filter(search).length, droppedItems = 0;
      const forwarded = (tool: ResponsesTool) => tool.type === "namespace" || hosted(tool);
      const flat = (request.tools?.filter(tool => !forwarded(tool) && !search(tool)) || []) as Exclude<ResponsesTool, ResponsesNamespaceTool | ResponsesToolSearchTool>[];
      if (Array.isArray(body.input)) body.input = (body.input as ResponsesInputItem[]).flatMap((item): ResponsesInputItem[] => {
        if (searchItem(item)) { droppedItems++; return []; }
        const lite = item as unknown as { type?: unknown; tools?: unknown };
        if (lite.type !== "additional_tools" || !Array.isArray(lite.tools)) return [item];
        const kept = lite.tools.filter(tool => !search(tool)); // hosted web_search inside the item is kept, as sent
        droppedTools += lite.tools.length - kept.length;
        return kept.length === lite.tools.length ? [item] : kept.length ? [{ ...item, tools: kept } as ResponsesInputItem] : [];
      });
      if (droppedTools || droppedItems) telemetry("tool_search_dropped", { provider: this.config.id, tools: droppedTools, items: droppedItems });
      body.tools = [...(request.tools?.filter(forwarded) || []), ...(flat.length ? [{ type: "namespace" as const, name: defaultNamespace, description: "Caller-dispatched tools", tools: flat.map(tool => tool.type === "function" && "function" in tool ? { type: "function" as const, ...tool.function, responseTool: undefined } : tool) }] : [])];
      // Only calls of top-level tools move into the gateway namespace; tools declared
      // in Responses lite `additional_tools` items keep their own namespace.
      const flatNames = new Set(flat.flatMap(tool => tool.type === "function" && "function" in tool ? [tool.function.name] : "name" in tool && typeof tool.name === "string" ? [tool.name] : []));
      if (Array.isArray(body.input)) body.input = body.input.map(item => "name" in item && item.name && !item.namespace && flatNames.has(String(item.name)) ? { ...item, namespace: defaultNamespace } : item);
      if (typeof body.tool_choice === "object" && "name" in body.tool_choice && !body.tool_choice.namespace) body.tool_choice = { ...body.tool_choice, namespace: defaultNamespace };
    } else {
      // A Responses endpoint the caller reached is not the Codex subscription backend: it gets no hosted web search it never
      // declared. The server already dropped and counted it before translation (`web_search_dropped`); this keeps the wire clean.
      // Nor does it get the client's tool_search or its replayed items (the server counted them as `tool_search_dropped`); the
      // tools an earlier search loaded stay declared, so a chat that switched here from a bridged Codex route can call them.
      const search = (tool: unknown) => typeof tool === "object" && tool !== null && (tool as { type?: unknown }).type === "tool_search";
      const own = ((body.tools as unknown[] | undefined) ?? []).filter(tool => !hosted(tool) && !search(tool));
      // Every explicit declaration wins over a copy a search loaded, including tools declared in `additional_tools` items.
      const lifted = Array.isArray(body.input) ? (body.input as unknown[]).flatMap(item => item !== null && typeof item === "object" && (item as { type?: unknown }).type === "additional_tools"
        && Array.isArray((item as { tools?: unknown }).tools) ? (item as { tools: unknown[] }).tools : []) : [];
      const loaded = missingTools(searchLoadedTools(request.input), [...own, ...lifted]) as ResponsesTool[];
      // A tool_choice naming hosted search has nothing to run here; it drops to auto, as translation already did.
      if (typeof body.tool_choice === "object" && body.tool_choice !== null && (body.tool_choice as { type?: unknown }).type === "web_search") body.tool_choice = "auto";
      if (Array.isArray(body.tools) || loaded.length) body.tools = [...loaded, ...own] as ResponsesTool[];
      if (Array.isArray(body.input)) body.input = (body.input as ResponsesInputItem[]).flatMap((item): ResponsesInputItem[] => {
        if (hostedItem(item) || (item as { type?: unknown }).type === "tool_search_call" || (item as { type?: unknown }).type === "tool_search_output") return [];
        const lite = item as unknown as { type?: unknown; tools?: unknown };
        if (lite.type !== "additional_tools" || !Array.isArray(lite.tools)) return [item];
        const kept = lite.tools.filter(tool => !hosted(tool) && !search(tool));
        return kept.length === lite.tools.length ? [item] : kept.length ? [{ ...item, tools: kept } as ResponsesInputItem] : [];
      });
    }
    const definitions = normalizeResponsesTools(declaredResponsesTools(request), { toolSearch: plan, webSearch: plan });
    const identities = new Map(definitions.map(tool => [tool.function.name, tool.function.responseTool!]));
    // On the Codex route top-level tools go up inside the gateway namespace and `additional_tools` tools keep their own, so a
    // call is resolved against the list it was declared in first. A tool whose type changed between history and the current
    // list then keeps the type of the declaration the call belongs to; the merged catalog is the fallback.
    const scoped = (scope: Partial<ResponsesRequest>) => new Map(normalizeResponsesTools(declaredResponsesTools({ ...request, ...scope }), { toolSearch: plan, webSearch: plan }).map(tool => [tool.function.name, tool.function.responseTool!]));
    const current = plan ? scoped({ input: [] }) : identities, history = plan ? scoped({ tools: [] }) : identities;
    const base = plan ? "https://api.openai.com/v1" : this.config.baseUrl!.replace(/\/$/, "");
    // The subscription endpoint keeps a conversation's prompt cache warm only
    // when it sees the caller's own session and thread identifiers.
    const routing = plan ? { ...(context.sessionId ? { "session-id": context.sessionId } : {}), ...(context.threadId ? { "thread-id": context.threadId } : {}),
      ...(turnState ? { "x-codex-turn-state": turnState } : {}) } : {};
    const collaborationTransport = plan ? subscriptionCollaborationTransport(body) : { body: plaintextCollaborationTransport(body) };
    const grokTools = !plan ? grokToolBridge(this.config, request, collaborationTransport.body) : undefined;
    const outgoing = grokTools?.body || collaborationTransport.body;
    let response: Response;
    try {
      response = await fetch(`${base}/responses`, { method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}`, ...(!plan ? apiRoutingHeaders(this.config, context) : {}), ...routing }, body: JSON.stringify(outgoing) });
    } catch (error) {
      throw networkProviderError(error, "connect") ?? error;
    }
    // When the backend sends them, quota headers are read on success and on failure alike. The live backend may omit them, and
    // then nothing is observed.
    if (plan) try { observeCodexUsage(this.onCodexUsage, codexUsageFromHeaders(response.headers), revision); } catch { /* Observation never fails inference. */ }
    if (!response.ok) throw await responsesHttpError(response);
    if (!response.body) throw new ProviderError("incomplete", "Provider returned no stream");
    // Always announce the response head, so the caller's headers never wait for a turn-state that may not come.
    if (plan) { const returned = wrapTurnState(response.headers.get("x-codex-turn-state"), this.scope); yield { type: "transport", ...(returned ? { turnState: returned } : {}) }; }
    let done = false; const output = new ResponsesOutput();
    const calls = new Map<string, { signature: string; identity: string; input: string; encryptedArgs: string }>();
    const unfinished = new Map<string, { identity: string; encryptedArgs: string; length: number; digest: string }>();
    const stream: ProviderStreamDiagnostic = { events: 0, reasoningItems: 0, textDeltas: 0, toolCalls: 0 };
    const identityFor = (item: Record<string, unknown>): ResponseToolIdentity => {
      const upstreamNamespace = item.namespace as string | undefined;
      // `gateway_collaboration` is a subscription-only wire alias. Resolve it
      // before catalog lookup so the client continues to execute collaboration.
      const effectiveNamespace = collaborationTransport.alias !== undefined && upstreamNamespace === collaborationTransport.alias ? "collaboration" : upstreamNamespace;
      const namespace = effectiveNamespace === defaultNamespace ? undefined : effectiveNamespace;
      const name = String(item.name); const alias = namespace ? `${namespace}.${name}` : name;
      const identity = (effectiveNamespace === defaultNamespace ? current : plan ? history : identities).get(alias) ?? identities.get(alias);
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
      const encrypted = item.encrypted_function_args;
      if (encrypted !== undefined && (!Array.isArray(encrypted) || encrypted.some(value => typeof value !== "string"))) throw invalid();
      const responseTool = identityFor(item);
      const effectiveNamespace = collaborationTransport.alias !== undefined && item.namespace === collaborationTransport.alias ? "collaboration" : item.namespace as string | undefined;
      const encryptedFunctionArgs = encrypted === undefined ? undefined : [...encrypted] as string[];
      // Missing and explicitly-empty metadata are distinct upstream facts. Preserve
      // that distinction while checking partial items and final snapshots.
      const encryptedArgs = encryptedFunctionArgs === undefined ? "missing" : JSON.stringify(encryptedFunctionArgs);
      return { id: item.call_id, name: item.name, namespace: effectiveNamespace, input: arguments_, responseTool, encryptedFunctionArgs, encryptedArgs,
        identity: JSON.stringify([item.type, responseTool]) };
    };
    const matchesPending = (value: ReturnType<typeof toolInput>) => {
      const pending = unfinished.get(value.id);
      if (pending && (pending.identity !== value.identity || pending.encryptedArgs !== value.encryptedArgs || createHash("sha256").update(value.input.slice(0, pending.length)).digest("hex") !== pending.digest)) throw new ProviderError("invalid_tool_call", "Provider changed an unfinished tool call");
    };
    const partialTool = (item: Record<string, unknown>): void => {
      const value = toolInput(item); matchesPending(value);
      const completed = calls.get(value.id);
      if (completed) {
        if (completed.identity !== value.identity || completed.encryptedArgs !== value.encryptedArgs || !completed.input.startsWith(value.input)) throw new ProviderError("invalid_tool_call", "Provider changed a completed tool call");
        return;
      }
      if (!unfinished.has(value.id) && calls.size + unfinished.size >= 1024) throw new ProviderError("invalid_tool_call", "Provider returned too many tool calls");
      unfinished.set(value.id, { identity: value.identity, encryptedArgs: value.encryptedArgs, length: value.input.length, digest: createHash("sha256").update(value.input).digest("hex") });
    };
    const tool = (item: Record<string, unknown>, snapshot: boolean): InferenceEvent[] => {
      const invalid = () => new ProviderError("invalid_tool_call", "Provider returned an invalid or duplicate tool call");
      const value = toolInput(item), arguments_ = value.input;
      if (item.status !== undefined && item.status !== "completed") throw invalid();
      if (item.type === "function_call") try { JSON.parse(arguments_); } catch { throw invalid(); }
      if (grokTools && !grokTools.validCustomEnvelope(value.responseTool, arguments_)) throw invalid();
      matchesPending(value);
      const signature = JSON.stringify([item.type, item.name, value.namespace, arguments_, value.encryptedArgs]);
      const previous = calls.get(value.id);
      if (previous !== undefined) {
        if (snapshot && previous.signature === signature) return [];
        throw invalid();
      }
      if (!unfinished.has(value.id) && calls.size + unfinished.size >= 1024) throw invalid();
      unfinished.delete(value.id); calls.set(value.id, { signature, identity: value.identity, input: arguments_, encryptedArgs: value.encryptedArgs }); stream.toolCalls = calls.size;
      output.toolBoundary();
      return [{ type: "tool", call: { id: value.id, type: "function", responseTool: value.responseTool,
        ...(value.encryptedFunctionArgs === undefined ? {} : { encryptedFunctionArgs: value.encryptedFunctionArgs }), function: {
          name: value.name, arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: arguments_ }) : arguments_,
        } } }];
    };
    // Search items the ChatGPT backend produced (client or server executed) reach the client as sent, once each.
    const searchItems = new Set<string>();
    const searchItem = (item: Record<string, unknown>): InferenceEvent[] => {
      const key = `${item.type}:${typeof item.id === "string" && item.id ? item.id : typeof item.call_id === "string" && item.call_id ? item.call_id : JSON.stringify(item)}`;
      if (searchItems.has(key)) return [];
      if (searchItems.size >= 1024) throw new ProviderError("invalid_output", "Provider returned too many search items");
      searchItems.add(key); output.toolBoundary();
      return [{ type: "native-item", item }];
    };
    // The bridge function stands for the client's search: it goes back as the `tool_search_call` the client runs, never as a tool.
    const isBridge = (item: Record<string, unknown> | undefined) => !!bridgeName && item?.type === "function_call" && item.name === bridgeName && (item.namespace === undefined || item.namespace === defaultNamespace);
    const bridgedCall = (item: Record<string, unknown>) => {
      try { return bridgedSearchCall(item, bridgeName, defaultNamespace)!; }
      catch (error) { if (error instanceof BridgeCallError) throw new ProviderError("invalid_tool_call", "Provider returned an invalid or duplicate tool call"); throw error; }
    };
    const itemDone = (item: Record<string, unknown>, snapshot = false, interrupted = false): InferenceEvent[] => {
      item = grokTools?.restoreItem(item) || item;
      if (plan && (item.type === "tool_search_call" || item.type === "tool_search_output" || item.type === "web_search_call")) {
        // An interrupted final snapshot can hold a search item that never finished; like an unfinished function call, it is withheld.
        if (interrupted && item.status !== "completed") return [];
        return searchItem(item);
      }
      if (item.type === "message") return output.done(item, snapshot, interrupted || item.status === "incomplete");
      // An unfinished bridge call is withheld like an unfinished function call; its arguments are parsed only once complete.
      if (isBridge(item)) return (interrupted || item.status === "incomplete" || item.status === "in_progress") && item.status !== "completed" ? [] : searchItem(bridgedCall(item));
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
    try { for await (const event of readEvents(response.body)) {
      observeResponsesStream(stream, event);
      if (plan && event.type === "codex.rate_limits") try { observeCodexUsage(this.onCodexUsage, codexUsageFromEvent(event), revision); } catch { /* Observation never fails inference. */ }
      if (!hideSummary && event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") yield { type: "reasoning", text: event.delta, id: String(event.item_id), summaryIndex: Number(event.summary_index) || 0 };
      if (event.type === "response.output_item.added") {
        const item = grokTools?.restoreItem(event.item as Record<string, unknown>) || event.item as Record<string, unknown>;
        if (item?.type === "message") output.added(item);
        if (item?.type === "reasoning") yield { type: "reasoning-state", item: hideSummary ? { ...item, summary: [] } : item };
        // Encryption metadata is an explicit transport fact. Record it at the
        // first output boundary so a later done item or final snapshot cannot
        // replace it with plaintext (or different opaque state). Ordinary early
        // calls omit enough fields on some upstreams that they must stay lax
        // until their completed boundary.
        if ((item?.type === "function_call" || item?.type === "custom_tool_call") && Object.hasOwn(item, "encrypted_function_args") && !isBridge(item)) partialTool(item);
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
    } } catch (error) {
      throw networkProviderError(error, "stream") ?? error;
    }
    if (!done) throw responsesEOFError(stream, response.headers.get("x-request-id") || undefined);
  }
}
