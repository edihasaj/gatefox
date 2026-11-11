---
summary: 'Compaction policy and model changes for gateway chats in the desktop adapter.'
read_when:
  - Changing compaction overrides, context windows or model switching for gateway chats
  - Investigating compaction or a refused model switch in a gateway chat
---

# Compaction and model changes

Part of the [Codex app-server adapter](app-server.md).

The pinned SDK normally compacts a long chat with its previous model before
switching to a model with a smaller context window. An unavailable or exhausted
previous provider can therefore block a model change even after the new selection
has been saved.

Releases containing the verified gateway-only SDK perform ordinary automatic
compaction with the selected model inside the caller's original turn. The SDK
uses its actual token estimate, reasoning effort, goal state, cancellation, and
history replacement. Every compaction item retains that user turn's ID; the
adapter does not submit a preceding manual turn. Declared compatibility-hash
changes retain the upstream SDK's compatibility handling. This executable is
used only in private gateway homes. The original signed native SDK and its
authentication remain unchanged.

The installer records the pinned SDK revision, exact runtime patch, dependency
lock repair, and binary checksum. Invalid or mismatched artifacts refuse a new
gateway executor. A shared generation advertises selected-model compaction only
after its host verifies the requested binary checksum. Its checksum participates
in generation identity, so a newer executable cannot replace loaded work.

The verified Gateway SDK applies paired role context and compaction overrides to
legacy `managed/*` policies and the named `qwen/qwen3.8-flash-next` worker model.
Earlier SDK builds applied these fields only to managed names: named Qwen roles
could inherit the catalog's larger window despite smaller values in their files.
The named-worker regression checks both catalog presence and absence, real tool
execution, compaction and cold resume. Native SDK behavior and unrelated named
roles remain unchanged. Existing workers retain their loaded configuration.

Legacy packages without that artifact retain the adapter recovery below. For
those per-connection gateway executors, the adapter checks public current-window
usage against the selected model's frozen context metadata. It also records real
failed compaction events. On the next explicit user message, a qualified idle chat
is compacted with the selected gateway model before that message is submitted.
The adapter waits for the actual compaction item and successful turn completion;
an empty RPC acknowledgement alone does not establish success. Stop cancels only
the observed compaction turn and prevents submission of the waiting message.
Failure returns one application error and requires another explicit retry.

Active turns retain normal SDK steering. Recovery never pauses an active goal;
pause or finish that goal first. Shared executors require explicit compaction
because the SDK cannot atomically check idle state and start compaction across
independent clients. Unknown context metadata is not replaced with cumulative
billing totals. A confirmed rollback clears the recovery metadata. Known non-null
compaction hashes are rejected because the SDK does not expose the previous-turn
hash needed to prove format compatibility.

The SDK owns history replacement and retains its original rollout. Summaries are
lossy, and the SDK can trim the request copy to fit the selected model; this does
not guarantee exact preservation of every detail in a smaller context window.
An uncertain late SDK start remains guarded until its actual completion. Reconnect
the chat's computer connection if that guard requests it. The adapter never
fabricates a completion or clears a live writer lock.

These changes require a fresh adapter connection and gateway executor. Installing
a release preserves an already-loaded older adapter and its active chats. The
legacy manual recovery can bind the desktop's pending message to the preceding
compaction turn; backend completion alone does not prove rendered association.
The selected-turn fixture checks the actual SDK event IDs and replays the tested
desktop handlers; a rendered check remains a separate release gate.

The launch procedure and real Claude/Codex 2 conversations have been verified
in the rendered desktop on MacBook Pro 2. Initial activation requires a fresh
app launch with these environment variables. Test on another machine before
relaunching a working app.

Max and Ultra are separate desktop display choices. Under Model features, enable
the offered levels in Available reasoning efforts. Availability varies by model
and the app's feature settings. Enable the choices in the app that renders the
picker; enabling them on a remote Mac does not change this Mac's controls.
The gateway persists these explicit display changes in its private settings and
does not advertise unsupported provider effort levels.

Ultra is Codex's top effort plus Codex's own task delegation. Native rows mark
it with `multi_agent_version` and `multi_agent_reasoning_effort`; with `v2`,
Codex offers its `collaboration` tools (spawn, follow up, message, wait, list and
interrupt agents). Model discovery copies both fields from the upstream catalog,
so gateway Codex models behave like native ones. Claude rows that support `max`
offer Ultra with `v2` delegation at `xhigh`. Codex sends `max` on the wire for
Ultra, and the Claude CLI's top level is `max`.

Model metadata follows each provider's own catalog. The inference server refreshes
it a minute after start and every six hours: Codex, Copilot and OpenAI-compatible
providers from their `/v1/models`, and Claude from the CLI's model list. Only the
metadata of configured models changes; adding or removing routes stays an explicit
`gateway discover PROVIDER --load`. A discovery failure keeps the saved metadata. This background
refresh never refreshes a Codex login: a provider whose access token would need a refresh
is skipped for that round and recorded as `model_metadata_skipped`, and the next real request
refreshes it (see [responses](responses.md) and [diagnostics](diagnostics.md)).
Claude also reports the context window the CLI actually used in every response
(`modelUsage.contextWindow`); the server saves it in `observed-context-windows.json`
and the next refresh adopts it, so a window never needs a manual table. Clients
receive the new catalog the next time the app starts its app-server.

The initial Claude windows were measured on a subscription on 13 Oct 2026 and
rechecked on 11 Nov 2026. The 5.x models (including Mythos 5.1), Opus 4.8 and
Opus 4.7 run with 1M under their plain IDs. Opus 4.6 and Fable 5.2 run as the
CLI's `[1m]` variants, which the subscription includes; Claude CLI 2.1.299 does
not yet recognize Fable 5.2 and runs its plain ID at 200K. Their gateway aliases
keep the plain IDs so saved chats keep working. Sonnet 4.6's 1M variant needs
paid usage credits, and Haiku 4.5 has none (its `[1m]` variant silently runs a
different model), so both report 200K.
Other personal Claude settings are not applied: a fallback model would silently
change the caller's model, and hooks, MCP servers and permissions must not run
inside an inference backend.

Codex 2 rows use Codex's native tool-output truncation (10,000 tokens) and window
share (95%), and keep the upstream's `truncation_policy`, `max_context_window` and
`auto_compact_token_limit` when discovery returns them. Other provider types keep
12,000 tokens and 90%. The upstream reports GPT-6.1-Sol at 500K with a maximum of
872K. On the desktop the adapter then applies the native row for the same model
([below](app-server.md#codex-2-rows-and-the-native-catalog)). The
refresh overwrites a hand-set `truncationPolicy` with the upstream value; an
`effectiveContextWindowPercent` override lasts while the upstream omits that field.
After an update the public catalog changes twice: once for the new defaults, then
about a minute later when the first refresh saves the upstream limits.

Native GPT-6.1-Sol rows also set `use_responses_lite` and
`supports_reasoning_effort_updates`. Discovery carries both, so Codex sends gateway
Sol the same lite request as native Sol: `reasoning.context: all_turns`, with tool
definitions in an `additional_tools` input item. The gateway reads tools from that
item for tool-call mapping, passes the item to the ChatGPT endpoint unchanged, and
applies its own default namespace only to calls of top-level tools. Other
providers skip the item when building their transcript.

A model that lacks the chat's speed tier (a Fast Codex chat switched to Claude)
runs its requests as Standard while the chat keeps its tier, as native Codex does.
See "Speed controls" for the full rule.

Sub-agents that Codex spawns from a gateway chat (delegation, Ultra, or agent
roles in the native configuration) inherit the gateway provider but take their
model from the role, often a bare name such as `gpt-5.6-terra`. The server serves
such a name through its vendor's subscription route: `gpt-…`, `o…` and `codex-…`
names use a Codex subscription, and `claude-…` names a Claude subscription.
With several accounts, set `"defaultForBareModels": true` on one provider per
vendor. Bare names then use only that account; a model it does not offer fails
instead of falling back to another account. Account-qualified aliases still
select their own routes. This is an operator-selected default, not automatic
inheritance of the parent account; the SDK sends no parent account selector.

Without a designation, exactly one account must offer the upstream model.
Multiple aliases in that account resolve to the lexically first alias. Other
routes serving the same model, such as Copilot, are not used for a bare name.
An unknown or ambiguous name still fails with `model_not_found`. Each resolution is logged as
`model_alias_resolved`. Before this, such sub-agents failed silently: Codex retried
the 404 five times and ended the turn with nothing.

Resuming or forking a gateway chat on the same model restores the chat's own
reasoning. The adapter records the effort and summary each gateway chat last ran with in
a private `desktop-thread-reasoning-<scope>.json` under its state directory,
fed by applied thread settings, turns that carry an effort, and chat
start/resume/fork results; an unknown (null) value never erases a saved level,
and a chat's record never transfers to another chat. When nothing is recorded
yet, for example after a gateway restart, the adapter seeds from the chat's own
rollout file in the executor's sessions directory, reading only records that
carry reasoning. A saved level belongs to the model it was saved with: a newer
observation for another model carries no effort or summary over to it, so
switching chats never inherits the previous model's Max. A gateway model whose
row offers no reasoning levels at all receives nothing restored, because there
is no level to restore to. A restored level the model does not offer is fitted down to
the closest offered level, or to that model's default when none qualify; the
adjustment is reported as `reasoning_effort_reset`. A resume that switches
models still receives a level the new model supports. A caller that sends its
own effort always wins over the restored one. A native chat receives nothing
from the adapter: its requests reach the engine exactly as the desktop sent them,
and the engine restores the chat's own model and effort
([native chats keep their model](app-server.md#native-chats-keep-their-model)).

## Switching to another tokenizer

Codex decides whether to compact with the counters the previous model reported.
Models from different families count the same history differently: on 30 Oct 2026
a chat that GPT-6.1-Terra measured at 591,583 tokens exceeded Claude Sonnet 5.5's
1,000,000-token window once the gateway rendered it for the Claude CLI. Sonnet's
advertised 900K limit let the switch through without compaction, and every retry
failed with "Codex ran out of room". The selected model cannot compact a history it
cannot read, so the SDK's own recovery does not help.

Before each user turn on a gateway chat, in both SDK forms and on shared executors,
the adapter reads the last non-zero measurement since the latest compaction or
rollback and the model whose turn recorded it (`turn_context`; the SDK's repeated
and zero overflow counters keep the earlier attribution). When that model's family
differs from the selected one, the measurement is recounted: switches to Claude from
another family by 1.7, other cross-family switches by 1.25, and switches away from
Claude not at all, because Claude counts the larger number. When the recount reaches
the selected model's usable window, the turn is refused before anything is sent:
"Switch back to MODEL, run /compact, then switch to MODEL again." The chat and its
history are unchanged. The refusal is recorded as `compaction_switch_refused`.

The same recount runs for a `turn/settings/update` that changes the running turn's
model, because that change reaches the next inference step without a user turn. A
refused change fails with the same message and the turn keeps its model.

Families come from the upstream model name: `claude-…` is Anthropic, and `gpt-…`,
`o…`, `codex-…` and `chatgpt-…` are OpenAI. Any other name is its own family. The
gateway publishes each row's family as `tokenizer_family` in its model catalog, computed
from the upstream name, because the alias a chat records can hide it: `team/large` and
`team/small` may both be one upstream family. The adapter keeps that field only when it
is a short plain name, and falls back to the alias text for a row without one, such as
a catalog from an older gateway. Codex ignores the extra key. A fact that cannot be
read, such as a missing rollout, never refuses a turn. Recorded counters that fit even
after a 1.7 recount skip the rollout read.

Codex 0.166 records the selected model in a small `turn_context` record, so the guard
can attribute nearly every measurement. Earlier SDKs wrote larger records that the
adapter often could not read, which left a same-family switch between differently named
aliases unchecked; with the published family such a switch is not refused.
