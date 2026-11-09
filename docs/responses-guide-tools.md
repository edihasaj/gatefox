---
summary: 'Caller and hosted tools on Responses routes: Claude tool identity, Chat Completions tool-call shapes, repeated declarations, the tool search bridge, and hosted web search.'
read_when:
  - Changing tool declarations, tool search bridging, or hosted tool forwarding
  - Debugging a garbled, duplicate, undeclared, or refused tool call
  - Adding a route that must drop or bridge a tool type
---

# Responses tools across routes

Part of [Responses support](responses.md). The client owns tool execution; these are the rules for how tool declarations and tool calls travel on each route. Request plumbing and failure classes are on [Responses protocol, streaming, and failures](responses-guide-protocol.md), and per-provider adapter behavior is on [Responses provider adapters and images](responses-guide-providers.md).

## Claude tool declarations and call identity

The Claude adapter accepts text and inline-image messages, function calls and outputs, custom tool
calls and outputs, and function/custom tools grouped in namespaces. It also accepts
the older nested function definition format for existing Chat Completions clients.

Claude tool definitions become native virtual MCP declarations. Native calls
return with their original name, namespace, and call ID. Custom tool input returns
as a string rather than JSON-encoded function arguments. The caller validates and
executes the tool; the gateway does not execute it or enforce grammar constraints.
The private gateway MCP server loads before Claude begins inference. It disables
nonblocking startup and marks its catalog `alwaysLoad`, keeping the caller action
surface available at startup. Rejected Claude calls log fixed categories for
unknown tools, internal search/wait helpers, duplicate IDs, malformed input, or a
missing required call. Names and arguments are never included in those logs.
Claude's private MCP names derive from the caller identity rather than its index
in a particular request. Reordering, deferred tools, and forced-tool filtering
therefore retain each binding. Replayed call/result names use those same native
names without altering arguments, IDs, results, or message content. Native tool
events can also use an exact caller alias or an unambiguous caller-local name;
ambiguous names, stale numeric aliases, and foreign tools are rejected.

## Chat Completions tool-call shapes

Chat Completions providers accept `finish_reason: "stop"` with tool calls only
when the caller explicitly selects a named tool, matching vLLM's named-tool
completion format. Every call still requires the selected tool identity, a
unique nonempty ID, and valid object JSON; custom tools also require string
`input`. Automatic, required, and disabled tool selection cannot complete with
`stop` plus tool calls. Truncated streams and tool calls capped by `length`
still fail. This applies to both Responses and Messages ingress.

A garbled call from a sampled Chat Completions model is a retryable failure, not a
final one. An unknown tool name, invalid JSON arguments or invalid tool input fails
the stream with `malformed_tool_call`, so Codex retries the request under its own
stream retry limit and the model samples again. Gateway itself does not replay the
request, and a caller that pins a temperature of zero can receive the same bad call
again. Over Messages ingress the same failure arrives as `api_error`, and retrying is
that client's decision. It checks every call in a batch before releasing any of
them, because a client runs a call as it arrives and a retry would otherwise repeat
a valid sibling. Identity faults that do not depend on sampling, such as a duplicate
or missing call ID, a changed ID or an unselected tool, stay final as
`invalid_tool_call`.

Local Qwen workers made this necessary. They returned names such as `tool=`,
`tool=tool_14` and `tool_1=apply_patch`, and the old final failure ended a worker's
turn on one bad completion, which sent the parent to a paid fallback model.

## Tool naming and replayed calls

Chat Completions providers receive each tool under its real name. A name the Chat
Completions grammar forbids, a duplicate, or a name shaped like `tool_N` falls back
to that tool's position. Opaque positions were the cause of Qwen's garbled calls: the
model must write the name back token by token, and at the index token it was unsure
what came next. Replaying 12 real failure contexts showed about a 6% chance of an
invalid token per call with positions and about 0.004% with real names; lowering the
temperature did not help. Gateway never maps a position back to a tool that has a real
wire name, because that would be a guess. See
[the evidence](evidence/qwen-tool-names-2026-11-05.json).

The Anthropic API provider still addresses tools by position. On both, a replayed
call can only stay structured when its tool is declared in the same request. Codex's local compaction replays the
whole chat without its tools, and an MCP tool can be deferred or disconnected
later in a chat. A replayed call to an undeclared tool therefore stays in the
history as text, `[Earlier tool call NAME: ARGUMENTS]`, and its result becomes
`[Result of earlier tool call NAME]` followed by the output. Calls to declared
tools keep their structured form. Before this change the whole request failed
with "Historical tool is absent from the current catalog", so long Qwen chats
could not compact. A current `tool_choice` that names an undeclared tool is
still refused.

The same compaction request carries `tool_choice` but no tools. vLLM refuses
that combination with HTTP 400 ("When using `tool_choice`, `tools` must be
set"). For Chat Completions providers with no declared tools, `auto` and `none`
both mean that nothing can be called, so the gateway omits the field. `required` and a named
tool still fail, because no tool can satisfy them.

## Rejections and empty completions

Every HTTP 400 from a Chat Completions server records `chat_request_rejected` with
the provider id, a fixed `reason` (`tool_choice_without_tools`, `context_length`,
`output_tokens`, `reasoning_effort`, `tool_schema`, `model`, `message_format` or
`unknown`) and, when the server names one from a fixed list, the `param`. The
server's message text is never recorded. `scripts/e2e-chat-compaction.mjs` checks
the compaction shapes against a real provider before a release.

For Responses ingress, a Chat Completions reply that ends with `stop` but
contains no answer text or tool call fails as `incomplete`. Reasoning alone,
including reasoning hidden by `summary: "none"`, cannot complete an agent turn.
The gateway preserves reported token usage and emits `response.failed` rather
than silently marking the response completed. It does not retry that request
internally or change the selected model. The separate opt-in Messages empty
completion recovery policy remains unchanged.

## Repeated tool declarations

A long chat can declare the same tool more than once: in several Responses lite
`additional_tools` input items, or in an `additional_tools` item and again in the current
top-level `tools` list. The ChatGPT backend accepts this, so the gateway merges the
declarations into its own catalog instead of refusing the request (`duplicate_tool`).

- **Identity.** A function or custom tool is identified by its name, qualified by its
  namespace for a namespace tool (the default `functions` namespace is unqualified, like a
  top-level tool). Any other typed tool, such as `tool_search`, is identified by its
  `type`. The same local name in two different namespaces stays two tools.
- **Precedence.** The current request's top-level `tools` win over any history
  declaration. Among `additional_tools` items a later item wins over an earlier one, and
  within one list a later entry wins over an earlier one. An exact duplicate is dropped; a
  differing one is replaced by the winner. A tool or its namespace keeps the position of
  its first declaration.
- **Scope.** Only the gateway's own catalog is merged. On the Codex route the original
  input items still go upstream unchanged (apart from the `tool_search` drops below).
- **Telemetry.** When anything merged, the gateway records `tool_declarations_merged` with
  the counts `replaced` and `identical`, once per request, never a name, definition or
  argument ([diagnostics](diagnostics.md#local-telemetry)).

Malformed declarations still fail with their own reasons (`invalid_shape`,
`unsupported_tool`) unless a valid declaration of the same tool supersedes them; only a
repeated name no longer fails a request.

## Tool search on the Codex subscription route

Native Codex rows can enable `supports_search_tool`, so the client sends a `tool_search`
tool, declares it either at the top level or inside a Responses lite `additional_tools`
input item, and later replays `tool_search_call` and `tool_search_output` items. The
search itself runs in the client (`execution: "client"`): Codex searches its deferred
tools and replays the matching definitions in `tool_search_output`. The ChatGPT backend
refuses the `tool_search` type through the gateway's shared-subscription login (HTTP 400
`subscription_sharing_unsupported_capability`, quoted in [hosted web search](#hosted-web-search);
first seen on 0.4.4, where every Codex 2 turn failed with "Provider returned HTTP 400").
**Search is therefore off by default.** A `codex-subscription` provider can opt in to a
bridge with `"toolSearch": "bridge"` in `gateway.json`; `"off"` is the default, and any
other provider type refuses the setting. `gateway tool-search on`, `off` and `status` set,
remove and show it for every `codex-subscription` provider; the command validates the edited
file before saving it and changes no other field. The setting is capability metadata, so a change
applies live, without a rebind; a chat started before the change keeps its catalog until
Codex loads the new one.

- **Codex subscription route, off.** Before sending upstream, the gateway drops any
  `tool_search` tool, at the top level or inside an `additional_tools` item (an item left
  with no tool is dropped too), and any `tool_search_call` or `tool_search_output` input
  item. This covers an engine that still holds an older catalog with search on. The rest
  of the request is unchanged and keeps its order, including `tool_choice`, so the turn
  runs as it would without search. When anything was dropped, the gateway records
  `tool_search_dropped` with the count of tools and items
  ([diagnostics](diagnostics.md#local-telemetry)).
- **Codex subscription route, bridged.** The gateway sends search with tool types the
  backend accepts (`src/protocol/tool-search-bridge.ts`). The `tool_search` tool becomes an
  ordinary function with the same description and parameters, where it was declared: a
  top-level one joins the gateway namespace, and one inside an `additional_tools` item stays
  there. Its name is `tool_search`, or `tool_search_` and so on when a flat tool already
  has that name. A replayed `tool_search_call` becomes a `function_call` of that function,
  and its `tool_search_output` becomes a `function_call_output` that names the loaded
  tools, followed by the loaded tools themselves: in a new `additional_tools` item right
  after the output on a Responses lite request, so everything before that point (and the
  prompt cache for it) is unchanged, and appended to the top-level tools otherwise. That item
  carries the role of the request's own `additional_tools` item (Codex sends `developer`),
  because the backend refuses one without a role. A tool
  already declared is not declared again, `defer_loading` is removed because the bridge
  loads the tool explicitly, and only function, custom and namespace tools are loaded.
  When the model calls the function, the client receives a `tool_search_call` with the
  parsed arguments and runs the search; it is never dispatched as a caller tool, an
  interrupted unfinished one is withheld like an unfinished function call, and invalid
  arguments fail as `invalid_tool_call`. Calls of loaded tools resolve like any caller
  tool. Codex resends the whole history every turn, so the gateway keeps no state. The
  gateway records `tool_search_bridged` with counts only.
- **Verification.** `node scripts/probe-tool-search-bridge.mjs --dry-run` runs both rounds
  (the model searches, then calls the tool the search loaded) through the gateway's own
  provider code against a scripted backend, for a top-level and a Responses lite request, and
  checks that nothing of the `tool_search` type or `defer_loading` reaches the wire. Without
  `--dry-run` it makes the same four requests to the real backend. On 23 Oct 2026 all four
  completed: for both shapes the model called the search bridge, then called the fixture
  tool returned by that search. The dry run passed too. This establishes the bridge's
  real inference and replay behavior; it does not make the raw `tool_search` type supported
  by the subscription endpoint. The installed setting remains off until explicitly enabled.
- **Bridge risks.** Loading tools on a request
  that is not Responses lite changes the top-level tool list, which can lower prompt cache
  hits from that point. The model sees a function rather than the tool type it was trained
  with, so it may use search a little differently. In the seven days before the bridge was
  built, no native Codex chat on the test Mac used tool search at all, so its benefit
  depends on connecting many deferred MCP or connector tools.
- **Upstream search items.** If the upstream ever produces a `tool_search_call` or
  `tool_search_output`, it still streams back to the client as sent, once each; an
  interrupted final snapshot withholds a search item whose status is not `completed`.
- **Every other route.** Claude, Copilot, Grok, chat-completions, anthropic-api and generic
  Responses routes drop the `tool_search` tool and both item types instead of rejecting
  them, so a chat that switches away from a Codex route keeps working. The tools an earlier
  search loaded stay declared (ranked below any tool the request declares itself), so the
  new model can still call them. Each drop is recorded as `tool_search_dropped`. A forced
  `tool_choice: "required"` with only the search tool has nothing to call there and still
  fails with `unsupported_tool_choice`. Anthropic Messages requests carry only function tools.
- **Catalog.** `supports_search_tool` is published on only for a bridged route's rows, and
  a Codex 2 row keeps it on only when its native row has it on too. Every other row, and
  every native row carried for sub-agents, has it off, because a bare model name resolves to
  a route only when the request runs
  ([details](app-server.md#codex-2-rows-and-the-native-catalog)).
- **Ownership.** The client executes search and owns the deferred tool list. The gateway
  never runs a search; it only changes how search items travel. Tool names, queries and
  outputs are never logged; failures record only the fixed reason and the allowlisted item
  type.

## Hosted web search

Native Codex rows that carry `web_search_tool_type` send OpenAI's hosted `web_search`
tool, and the ChatGPT backend accepts exactly that one hosted tool through a shared
subscription: forwarding `tool_search` answers HTTP 400 `subscription_sharing_unsupported_capability`
-- "User subscription sharing currently supports only 'web_search' and developer-defined
'function' and 'custom' tools, including 'namespace'" -- which is why [tool search](#tool-search-on-the-codex-subscription-route)
is not forwarded as such (it is off, or bridged as a function) while web search is forwarded.

`scripts/probe-hosted-tools.mjs` asks the backend directly, one short request per case,
and records only status codes and fixed error fields. On 21 Oct 2026 it showed the refusal
above for `tool_search`, and showed that `web_search` passed the backend's tool check.
On 23 Oct 2026 a real request through `ResponsesAPI` completed with a completed
`web_search_call`, establishing actual hosted search execution too. The earlier run showed that
`https://chatgpt.com/backend-api/codex`, which native Codex uses, answers 401 to the
gateway's own login, so the gateway keeps `https://api.openai.com/v1`.

- **Codex subscription route.** The `web_search` tool, declared at the top level or inside a
  Responses lite `additional_tools` item, is forwarded upstream unchanged and never wrapped into
  the gateway namespace, and replayed `web_search_call` input items go upstream as sent. A
  `web_search_call` the backend produces streams back to the client as received, once each, and
  an interrupted final snapshot withholds one whose status is not `completed`, as it does a
  search item. `response.web_search_call.*` progress events are ignored. A forced
  `tool_choice: "required"` counts a declared `web_search` as satisfying the call.
- **Every other route.** Claude, Copilot, chat-completions, anthropic-api and generic Responses
  routes drop the tool and its replayed items before anything is translated or sent, so a chat
  that switches here from Codex 2 mid-turn keeps working; a `tool_choice` naming `web_search`
  drops to `auto` on those routes. When anything was dropped, the gateway records
  `web_search_dropped` with the count of tools and items
  ([diagnostics](diagnostics.md#local-telemetry)) -- counts only, never a name, query or result.
  Every other hosted tool type (`file_search`, `computer_use`, `image_generation`, ...) keeps
  failing with `unsupported_tool` on every route, exactly as before.
- **Catalog.** A Codex 2 row copies the native row's `web_search_tool_type`, so Codex sends the
  tool on it exactly as it does natively; Claude, Copilot and other rows lose the field, and
  `supports_search_tool` -- a different tool's flag -- stays off unless a route bridges tool search
  ([details](app-server.md#codex-2-rows-and-the-native-catalog)).
- **Ownership.** The backend runs the search and the client renders its items. The gateway never
  runs a search itself and never logs a query or result.