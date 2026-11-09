---
summary: 'Native picker selection, Codex subscription counters, model changes inside a loaded chat, and how Codex 2 rows borrow the native catalog.'
read_when:
  - Changing the native model picker, its placement or hidden rows
  - Investigating a missing Codex counter or a rejected configuration write of a model
  - Changing model selection for a loaded or running chat
  - Changing how Codex 2 rows copy native model metadata or node_repl policy
---

# Model catalog, picker and usage counters

Part of the [Codex app-server adapter](app-server.md).

## Native picker selection

`nativeModelPicker` in the gateway configuration optionally lists the exact
native model IDs offered in the desktop picker:

```json
{
  "nativeModelPicker": [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-5.6-terra",
    "gpt-6-luna"
  ]
}
```

`nativeModelPickerPlacement` controls where those native rows appear. The app's
**Connections → Native GPT fallback models** control offers the same choices:

| Value | Picker behavior |
| --- | --- |
| `first` | Native rows before gateway groups; the default when omitted. |
| `last` | Native rows after gateway groups, keeping fallback visible. |
| `hidden` | Native rows omitted from the normal picker, not disabled. |

For example, add `"nativeModelPickerPlacement": "last"` alongside the existing
model selection. Neither placement nor hiding changes the allowlist itself.
With `includeHidden: true`, hidden native rows are still returned with
`hidden: true`; gateway aliases and their relative order are unchanged.
Pagination applies after selection and placement. Existing native chats,
explicit native model requests, account defaults and native classification
continue to use the full native catalog. No automatic model or account failover
is introduced. Use `last` rather than `hidden` to keep fallback easy to reach.

This preference belongs to the local execution host's adapter, including a
client-only Mac using a shared inference gateway. It does not edit that shared
gateway's provider order or credentials. SSH chats use the remote execution
host's preference. When running without the gateway adapter, these picker
preferences have no effect on the stock native catalog.

Omitting `nativeModelPicker` retains every native row before placement is
applied. Its list must contain 1–256 unique
model IDs. Selection applies only to native rows returned by `model/list`, before
combined pagination; gateway aliases are unaffected. With `includeHidden: true`,
excluded native rows remain available with `hidden: true`. Vendor-hidden rows
are never made visible. This is a picker preference, not permission to use or
rebind a model: existing native chats, explicit model requests, subagents and
native/gateway classification retain the full catalog and their saved choices.
The adapter does not edit native authentication, configuration or model-cache
files. Registered adapters re-read only these native presentation settings when
the picker requests its list; invalid or unreadable changes retain the last
valid presentation. Older adapters need normal idle adoption or reconnection
to load this reader. Loaded chats keep their own model and account.

The example lists the four models available during the October 23 check. It
does not automatically select a newer release or invent a missing family. Update
the IDs after checking that account's current catalog.

Verify the picker against the signed native SDK without copying authentication
or sending inference:

```sh
node scripts/e2e-native-picker.mjs --code /absolute/package \
  --catalog "$HOME/.codex/models_cache.json" --root /tmp/fresh-picker-check
```

The fixture uses an isolated home, verifies the four selected rows plus a gateway
row and hidden discovery, and checks that the public catalog remains unchanged.

## Codex subscription counters

The gateway records Codex counters only when the Codex subscription backend itself sends
them: the default numeric headers `x-codex-primary-*` and `x-codex-secondary-*`
(`used-percent`, `window-minutes`, `reset-at`), read on successful and failed (for example
429) replies, and `codex.rate_limits` stream events for the default `codex` family. Events
that name another limit are ignored so they are never mislabelled. A window is kept only
when all three of its values are valid (`used-percent` finite from 0 to 100,
`window-minutes` a positive integer, `reset-at` an epoch second in a sensible range);
nothing is inferred, filled in or coerced from `null`, booleans, or text. Other Responses
API providers never produce Codex rows. A failure of the observer cannot fail or retry
the request.

**No percentages are available when the backend omits them.** At the time of writing the
live backend answers a request with HTTP 200 and `response.completed` but sends no numeric
quota headers or rate events, so a live gateway currently shows no Codex row. This
feature does not add a backend endpoint and does not claim parity with the native Codex
quota; it only shows counters the backend has reported.

A counter belongs to the credential file the request ran with. Each request records the
file's identity (device, inode, size, modification and change times, mode, and that it is
readable; never its content or a token) before and after its token is read, and the write
checks it again. A different path, a replaced or rewritten file, a permissions change, or a
file the gateway cannot read leaves no counters, including after a restart. A credential
refresh during a request also drops that request's counters; the next request records them.

When the desktop reads `account/rateLimits/read`, the adapter adds known rejected
Claude windows to `rateLimitsByLimitId` with separate `gateway:` IDs. A rejected
window establishes 100% usage. Allowed events do not establish a percentage and
are not rendered as invented zero usage. A Codex row is added as
`gateway:<providerId>:codex`, labelled `Codex · <providerId>`, with `primary` and
`secondary` exactly as observed. A window that has already reset is shown as `null`, and
a row with no live window is omitted. Observations older than 24 hours or more than five
minutes in the future are omitted until new provider data arrives. Native `rateLimits`,
account identity, usage permission, credits, upsell fields, and native map entries retain
their values. A gateway outage leaves the native response usable. The installed app's
rendering of additional usage rows still requires a desktop check. Usage updates
never modify the model catalog or create another executor generation.

```sh
gateway codex-shim --config /absolute/path/gateway.local.json \
  --codex /absolute/path/original-codex -- app-server --listen stdio://
```

Stdout carries JSON-RPC only. The adapter forwards notifications, maps server
request IDs for approvals, bounds frames to 16 MiB, and stops its child on exit.
Non-server commands, including `--version`, pass through unchanged. The adapter
accepts `stdio://` and private `unix://` listeners. A Unix listener serves the
WebSocket protocol used by desktop SSH connections. A listener started with
`--ssh`, which gives it a gateway control home, retires itself once a newer
release is installed and it holds no session; the next connection then starts
it on the installed release. A listener started with a custom
`--listen unix://PATH`, which has no control home, keeps its previous
behavior: it does not exit on its own after an install. The adapter gives each
connection its own native connection. Gateway executors are shared when the
unified service has shared execution enabled; legacy installations keep
per-connection executors.
It refuses occupied sockets, requires a
user-owned directory without group/world write access, and sets the socket to
mode 0600. Network WebSocket listeners are rejected.

For the desktop SSH path, install the managed command on the remote Mac:

```sh
gateway ssh register --codex /opt/homebrew/bin/codex
gateway ssh status
```

Use the absolute path returned by `command -v codex` before registration. The
managed `~/.local/bin/codex` command decorates app-server operations and delegates
other commands to that original CLI. Registration refuses an unrelated existing
command. `gateway ssh unregister` moves only its own command to Trash. Native
configuration and authentication files are unchanged.

The app prepends `~/.local/bin` to the remote command search path and starts a
Unix listener. The managed command uses a gateway-owned control home under
`~/.local/state/gw-ssh`, scoped to the gateway configuration and native home.
It redirects only the original `app-server proxy` child's control home to that
socket. Inference and account discovery retain the original native home. Codex's
own daemon socket is not replaced. A live gateway listener is reused; a crashed
socket is recovered only when its private ownership record matches. A bootstrap
that finds a swap cut off halfway by a crash (the record names a new listener that
never took over the address) restores the previous record and continues, so a
crash never leaves SSH refused. Under the same lock it removes dead private
`.gw-*` sockets and links and stale lease temp files, only in the managed
`gw-ssh` folder or during a replacement, never for a custom `--listen` path.
Add the host under Settings, Connections, SSH, then select its workspace.
The built-in Control other devices connection reaches the native engine directly
and bypasses a desktop or SSH wrapper. The separate
[native transport adapter](native-remote.md) reuses the machine's original
registration and routes that connection through the same gateway router. Its
rendered checks are still in progress on the test Mac.


## Chat naming and active-step model switching

The client owns chat naming. The adapter forwards native `thread/name/set`,
saved-title reads, and live name notifications; it adds no title tool or naming
instructions. Caller-supplied dynamic tools remain unchanged. Read-only saved-chat
metadata needs neither gateway inference nor model discovery.

Choose a gateway model in a **new chat**. A loaded chat cannot switch between
native and gateway providers in this Codex version. The adapter rejects that
change before inference. Switching Claude and Codex 2 inside a gateway chat works
because they share the gateway provider and its account-scoped replay handling.
Native return from gateway history is not supported: a real probe failed on
foreign item IDs. The adapter does not rewrite stored native history to bypass it.

Gateway executors enable Codex's active-step model switching. The adapter forwards
`thread/settings/update`, `turn/settings/update`, `turn/steer`, and goal operations
with their original turn IDs and authorization fields. A thread-level model
selection remains the default after a saved chat resumes. An active-turn model
update applies at the next inference step, unless the destination differs in
node_repl or review settings: the SDK then rejects it, as natively, and the adapter
forwards the error ([which rows](node-repl.md#switching-models-during-a-running-turn)).
A captured tool step keeps its approval requirements; changing thread access updates
subsequent turns.

These controls passed live tests with Claude Sonnet 5.5 and Codex 2 GPT-6.1-Sol,
which were then in one node_repl group; only adapter tests cover a rejected switch.
Goal creation, reads, updates, notifications, and clearing were tested.
`scripts/e2e-goal-switch.mjs` checks automatic goal continuation with real inference in an
isolated native home: an active goal whose chat switches gateway model mid-goal with
`thread/settings/update`, as the picker does, must start its next turn by itself and send
that turn's requests on the new model. Every rendered control remains a separate desktop check.

## Mid-turn model changes from the picker

The desktop picker changes a model only with `thread/settings/update`, so the running
turn finishes on its old model. With `"midTurnModelSwitch": true` in the gateway
configuration (off when absent), the adapter also offers an applied picker change to a
running gateway turn on another model. It sends one `turn/settings/update` with only
the model and that turn's ID, after the thread update succeeded:

1. The thread update is always forwarded first, so the next turn, a resume and a fork
   use the new model whatever happens to the offer.
2. The [tokenizer recount](app-server-compaction.md#switching-to-another-tokenizer)
   runs for every active-turn model change, including ones a CLI or script sends. A
   history the new model cannot hold is refused before anything reaches the SDK.
3. The SDK's own active-step check decides the review groups
   ([which rows](node-repl.md#switching-models-during-a-running-turn)); the adapter
   keeps no copy of them.

An applied offer takes effect at the next inference step and is recorded as
`model_switch_promoted`. A refusal from either check, an unapplied answer or any
error is recorded as `model_switch_deferred` with `reason` (`context`,
`review_group`, `not_applied` or `error`). It is never reported to the desktop: the
picker change already succeeded and applies from the next turn, as without the
setting. Nothing is offered to an idle chat, a turn already on that model, a
throwaway fork, a native chat or a turn this connection did not start. A switch to or
from Claude starts a new Claude CLI session, which costs one cache write. The
desktop may show the new model while the running turn's earlier steps used the old
one. Only adapter tests cover the offer so far; a rendered desktop check is still
required before this becomes the default. Changing the setting needs a fresh adapter
connection.

## Native chats keep their model

The adapter never changes a native chat's model or provider. When "Authenticated
workspace changed" restarts the desktop's local engine, ChatGPT 26.1007.71326
resumes each open chat with `model: null` and `modelProvider: null`. The signed SDK
then restores the model, provider and reasoning effort saved with the chat. It skips
that restore when the request names a model or a provider, or carries a
`config.model` or `config.model_reasoning_effort` key, and then runs the configured
default model. The adapter therefore forwards such a resume unchanged. A native
fork never takes its parent's model: it runs the model it names or the configured
default, so a fork that names no model, such as a side chat, is forwarded unchanged
as well.

The adapter adds nothing to a native chat's request. `thread/resume`, `thread/fork`,
`turn/start` and the settings updates reach the SDK exactly as the desktop sent them:
the adapter never adds or changes `model`, `modelProvider`, `config.model` or
`config.model_reasoning_effort`. A fork that names the chat's model without an effort
therefore gets the SDK's own effort, as it does natively. Gateway chats are different:
the SDK cannot restore a gateway alias, so the adapter still restores a gateway chat's
reasoning ([compaction](app-server-compaction.md)), and only gateway chats are written to that
reasoning store. Releases 0.3.9 and 0.4.0 added the
saved effort to the desktop's resume, whose null model is no override, so after every
engine restart a chat on GPT-6.1-Sol came back on the configured default model with
its saved effort. Release 0.4.1 first limited that to requests naming the chat's model
and now removes it, so the `reasoning_restored` event no longer reports `provider: native`.

The signed SDK (0.162.0-alpha.17.2) with a localhost mock upstream confirmed both
rules: the desktop's resume kept GPT-6.1-Sol, and the same resume with an added
effort returned the configured default. A fork that named no model ran the
configured default whether or not it carried an effort. `scripts/e2e-native-model.mjs`
requires the adapter to give every desktop shape the same model and effort as the SDK
gives it directly.

### Gateway sub-agents on native rows

A gateway executor can spawn a Codex 2 or Claude sub-agent whose saved model is a
native catalog slug such as `gpt-6.1-sol`. That child remains a gateway chat: its
saved provider stays `gatefox` (`subscription_gateway` if saved before 1.8.0) or, on an opted-in Mac, `openai`, and
the adapter routes reads, history, interrupts, turns and resumes to the executor
that owns it. A resume with no model or reasoning override lets the SDK restore
its saved state. The child's web search settings are forwarded as the caller saved them,
as on gateway aliases: the adapter no longer forces `web_search` off, because the Codex
route forwards the hosted tool and every other route drops it.
If an explicit model/provider or a `config.model` or
`config.model_reasoning_effort` key opens the SDK's restore gate without selecting a
different child, the adapter repeats the child's saved native model and provider.
It recovers an unspecified effort only from the child's saved reasoning record,
rollout, or thread metadata; it never invents a launch default or replaces a
caller-supplied effort. A conflicting model or provider is refused.

This is deliberately not a general native-to-gateway model switch. The adapter
allows it only when the backend's saved child metadata records a parent, returns the
requested thread id, classifies as a gateway child in this adapter, and its actual
current model equals the requested native slug. The frozen executor applies this same
check to `config.model`. Another native model, an unknown alias, a mismatched rollout
record, or a parent-shaped native child is still refused.

## Codex 2 rows and the native catalog

Codex 2 rows serve the same models as native Codex, so the desktop adapter gives
them the harness half of the native row. Each Codex 2 row in the public catalog
names its upstream model in `upstream_slug`. The adapter looks that slug up in the
local native catalog it loaded at startup and copies these fields:

- `model_messages`: the base prompt (`instructions_template`) and Codex's other
  model messages, together with `include_skills_usage_instructions`,
  `include_plugin_usage_instructions` and `include_apps_usage_instructions`. Native
  GPT-6.1-Sol turns all three off because its template already holds that
  guidance. With the gateway's own `true` values Codex repeated it: with skills
  alone, 2,554 characters (about 550 input tokens) on every request. Without a
  native template the gateway values stay;
- `tool_mode`, `apply_patch_tool_type` and `shell_type`;
- the `default_reasoning_level`, `default_verbosity` and `default_reasoning_summary`
  defaults, and `support_verbosity`. A default effort the route does not offer is
  not copied;
- `effective_context_window_percent` and `truncation_policy`;
- `context_window`, but only when the native value is at or below the upstream's
  `max_context_window`. Otherwise, or when the upstream reports no maximum, the
  upstream window stays;
- `node_repl_disabled`, `node_repl_auto_review_required`, `guardian`,
  `auto_review_model_override`, `requires_sandboxed_review` (data only: no SDK reads
  it) and `model_specialty` ([node_repl](#node_repl-browser-chrome-and-computer-use)).

Everything else keeps the upstream value: service tiers, multi-agent fields, the
window maximum, the auto-compaction limit, input modalities and reasoning levels.
`comp_hash` is never copied. `supports_search_tool` is on for a Codex 2 row only when
its provider bridges tool search (`"toolSearch": "bridge"`) and the native row has it on.
Otherwise it stays off: the ChatGPT backend refuses a `tool_search` tool that the gateway
forwards, so without the bridge the gateway drops it on that route
([details](responses.md#tool-search-on-the-codex-subscription-route)). The hosted
`web_search` tool is a separate setting and is on there: the adapter copies the native row's
`web_search_tool_type`, so a Codex 2 chat sends that tool exactly as native Codex does and the
Codex route forwards it. A slug without a native row, and every Claude, Copilot or other row,
loses the field -- those routes cannot run hosted search and the gateway drops the tool
([details](responses.md#hosted-web-search)). Every row otherwise stays as the
gateway published it (tool search off unless bridged), apart from the strictest native node_repl policy and the
native confirmation and classifier texts ([node_repl](#node_repl-browser-chrome-and-computer-use)).
The rows the adapter builds drop `upstream_slug`. At each launch the native-catalog
preflight first writes `desktop-models.json` with the plain gateway rows, marker
included; the adapter replaces that file with the copied rows on its first
successful cache restore or host refresh, and every
gateway chat start refreshes first. Codex 0.160.0 and the gateway SDK both
ignore the marker, as they do in the plain catalog that CLI and remote clients
read. Those clients have no native catalog, so they keep the gateway rows
unchanged.

The inference host still never supplies instructions. The offline cache stores
only the host's public rows; the adapter rebuilds the copy from the native catalog
on every start, and a changed native row changes the catalog revision, which starts
a new executor generation for new chats.

Code mode runs in a separate `codex-code-mode-host` process that Codex starts from
beside its own executable. The gateway SDK package ships that companion and records
its digest in the build receipt as `codeModeHostSha256`; the execution host enables
Code Mode only after that verified receipt. A host file the receipt does not name,
or one whose bytes differ from it, fails the whole SDK's verification, as any other
changed component does. When the installed package has a gateway SDK whose
receipt names no host (a package built before the companion shipped), the adapter
keeps the gateway's `direct` tool mode and still
copies the other fields. Without a gateway SDK, executors run the desktop's own
Codex and take the native code mode. The same rule covers the native rows that the
executor catalog carries for sub-agents naming a model directly (a role's model,
`default_subagent_model` or Ultra delegation): without the host those rows get
`direct` tools in executors, so their commands run instead of failing with "failed
to spawn code-mode host". Those carried rows have the search flag off, as the Codex 2
rows do: a bare model name resolves to the Codex subscription route, which drops
`tool_search` because the ChatGPT backend refuses it. No provider can take that name first, because a gateway
model alias spelled exactly like a native slug is refused whenever the adapter loads the
gateway catalog, at launch and at each refresh, against the native slugs it read at launch;
a native model that appears later is checked at the next launch. (Before 0.4.4 every such sub-agent request failed with
`unsupported_tool`.) The native engine keeps its own catalog unchanged.

The executable selected for each new executor generation decides whether Code Mode
is available; the adapter does not reuse that decision from the package that opened
the desktop connection. A recovered SDK without the companion host gives every
gateway and carried native row an explicit `tool_mode: "direct"`, including rows
whose native metadata omitted or named an unknown mode. Direct mode overrides Code
Mode feature flags. It preserves node_repl, permissions, review and instructions,
and never changes the native engine's catalog.

Every gateway row publishes `max_context_window`: the provider's own maximum when it
reports one, otherwise the row's window. Without it a row inherited Codex's global
cap of 872K, which cut Claude's 1M window.

Gateway executor homes link the native `AGENTS.md`, `agents`, `skills`, `plugins`,
`hooks.json` and `prompts`, so client hooks (for example memory hooks) and saved
prompts work in gateway chats as in native ones. Authentication and `config.toml`
are never linked.

The executor home's `config.toml` snapshot writes bare keys (`notify = …`) wherever
TOML allows them, and quotes only keys that need it. Tools that edit `config.toml`
line by line, such as the Computer Use installer, look for a bare `notify =` and
append their own when they miss a quoted `"notify" =`. That left two root `notify`
keys and the engine failed with `duplicate key` on resume (30 Oct 2026). A shared
generation keeps its snapshot across restarts, so on reuse the gateway also drops
the earlier of two single-line root assignments to the same key; the later line is
the newer intent. Tables and multi-line values are left alone.

On 13 Oct 2026 a low-effort GPT-6.1-Sol turn through a development gateway sent
the native 21,769-character base prompt as a developer message (Responses lite has
no top-level `instructions`). With Codex 0.160.0 the model called the code-mode
`exec` tool; with the gateway SDK and the copied `direct` mode it called
`exec_command`. Both turns completed, and the second request of each turn read
97-98% of its input from the cache. Native and upstream both reported GPT-6.1-Sol
at 500K that day, so its window did not change.

A resumed chat keeps the base instructions saved with it, as natively; chats
started before this change keep their empty base prompt. When it starts a new
gateway chat without a saved preference, the adapter still selects medium effort
and auto summaries, so the native default shows in the model list but does not
yet start the chat. Those defaults never replace an existing chat's settings on
resume; the chat's own reasoning is restored instead, as described above.

### node_repl (browser, Chrome and computer use)

Gateway rows get the native node_repl policy, and rows with no native counterpart
always require review. The gateway serves the reviewer `codex-auto-review` through the
Codex subscription for every Auto-review approval in a gateway executor, not only
node_repl; 0.3.9 declined them, and their context now leaves the chat's own provider.
The rules, evidence and fail-closed cases are only in [node_repl on gateway rows](node-repl.md).
