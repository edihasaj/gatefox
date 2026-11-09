---
summary: 'Experimental Codex desktop adapter: additive model catalog, per-chat routing, and the index of the guides that hold its detail.'
read_when:
  - Connecting the gateway to the Codex desktop app
  - Changing app-server routing, model selection, or configuration writes
  - Looking for which app-server guide holds one section
---

# Codex app-server adapter

The experimental adapter keeps the original Codex executable and native login.
By default it adds configured gateway models after the native models; native picker
placement is configurable in [the model catalog guide](app-server-guide-model-catalog.md#native-picker-selection). It routes every chat by its kind, not by its
provider id. The adapter classifies a chat with the first rule that
answers, in this order: the gateway's own provider id (`gatefox`, or `subscription_gateway` on a chat saved before 1.8.0); the registry of
gateway chats; a gateway ancestor of a sub-agent, read from its saved record when this
connection has not seen it; and a model alias that is not a native model slug. Any other chat is native and keeps its provider. The registry is the file
`<state directory>/gateway-chats/<scope>.json`, where `<scope>` identifies the native
Codex home. The adapter writes a gateway chat's start or fork to the registry before it
returns the reply, a sub-agent that a gateway engine announces before it forwards
the announcement, and a chat that only its ancestors or alias identified when it routes
it to an executor. New gateway chats are recorded as `gatefox` by default (`subscription_gateway` before 1.8.0); a
Mac whose native relay is verified can opt in to `"chatIdentity": "openai"` (0.4.7), so a
stock engine lists them too. Existing chats keep the id they were saved with. A chat list
that asks only for the native default provider also gets the `gatefox` and `subscription_gateway`
chats, which is how the phone sees them through the relay. See
[harness identity](harness-identity.md) for when to opt in, the executor contract, the
phone and rollback. A gateway model
alias that equals a native model slug is refused when the catalog loads, because the
native slug would otherwise take over the alias's chats.

Provider usage observations are available at the authenticated
`GET /v1/provider-usage` endpoint. Its `data` array holds two kinds of row. Claude rows
contain only provider route IDs, recognized window/status enums, reset seconds, and
observation seconds. Codex rows (`kind: "codex"`) contain the provider route ID, the
observation seconds, and a `primary` and/or `secondary` window, each with the exact
`usedPercent`, `windowMinutes` and `resetsAt` the provider reported. Private error prose,
credentials, and account identities are excluded. The daemon saves these observations
privately across restart. A changed authentication-directory route (Claude), a removed
provider, or a changed credential (Codex) does not inherit an old row. Clients that only
know Claude rows ignore the Codex rows.
The detail lives in four guides, split out of this page. Each heading below keeps
its original title and anchor, and links to the page that now holds the full text.

| Guide | Answers |
| --- | --- |
| [Native relay, remote control and native sharing](app-server-guide-native-relay.md) | Whether a machine needs the relay, shared native engines and private leases, feature trimming, refused configuration writes, the desktop wrapper and a fresh launch |
| [Desktop login environment](app-server-guide-login-environment.md) | ChatGPT starting without `CODEX_CLI_PATH` at login, the managed login agent, its rollback, and what `gateway desktop status` reports |
| [Model catalog, picker and usage counters](app-server-guide-model-catalog.md) | The native model picker, Codex subscription counters, model changes inside a loaded chat, Codex 2 rows and the native node_repl policy |
| [Chat and executor lifecycle](app-server-guide-chat-lifecycle.md) | Sub-agent hydration, shared acquires, re-attach after an executor goes away, chat notification order, queued messages |

[Compaction and model changes](app-server-compaction.md),
[Processes and prediction forks on connected machines](app-server-forks.md) and
[Speed controls](speed-controls.md) already live on their own pages.

## Opening an unloaded subagent

A Multi-Agent V2 child resumes through its loaded immediate parent's SDK, on the
parent's existing executor generation: starting a current-generation executor instead
can return `-32600` and fail hydration. `thread/read` and `thread/turns/list` still
inspect saved history.
Full text: [Opening an unloaded subagent](app-server-guide-chat-lifecycle.md#opening-an-unloaded-subagent).

## Native picker selection

`nativeModelPicker` lists the exact native model IDs the desktop picker offers, and
`nativeModelPickerPlacement` (`first`, `last`, `hidden`) says where those rows appear.
The preference belongs to the local execution host, changes no allowlist, and never
rebinds a model. The page also covers the isolated native-SDK picker check.
Full text: [Native picker selection](app-server-guide-model-catalog.md#native-picker-selection).

## Codex subscription counters

Codex rows appear only when the Codex backend itself sends the `x-codex-primary-*` and
`x-codex-secondary-*` headers or `codex.rate_limits` events, and a window is kept only
when all three of its values are valid; a counter belongs to the credential file the
request ran with. The page also covers the `gateway codex-shim` command, its socket
rules, and `gateway ssh register` for the desktop SSH path.
Full text: [Codex subscription counters](app-server-guide-model-catalog.md#codex-subscription-counters).

## The native relay is optional

Nothing in the gateway depends on the native relay: an adapter or SSH listener asks once
at start whether a relay is usable, and one that cannot run is left `paused` with its
reason rather than restarted forever. This guide also holds the combined model-catalog
discovery, the retired feature-key normalization and feature trimming, the refused
native configuration writes, the private `desktop-preferences.json`, the
`CODEX_CLI_PATH` wrapper, shared native ownership and the desktop launcher.
Full text: [The native relay is optional](app-server-guide-native-relay.md#the-native-relay-is-optional).

### The login environment agent

ChatGPT is a login item and can start before the gateway sets `CODEX_CLI_PATH`. The
unified service closes that race at its first step; standalone registration writes a
managed LaunchAgent. The page covers both, the guards, rollback, API mode and what
`gateway desktop status` reports.
Full text: [The login environment agent](app-server-guide-login-environment.md#the-login-environment-agent).

## Mid-turn model changes from the picker

With `"midTurnModelSwitch": true` the adapter also offers an applied picker change to a
running gateway turn, after the thread update, gated by the tokenizer recount and the
SDK's own active-step check. Before it, the guide covers chat naming and Codex's
active-step model switching for gateway executors.
Full text: [Mid-turn model changes from the picker](app-server-guide-model-catalog.md#mid-turn-model-changes-from-the-picker).

## Many requests for unloaded chats at once

A reconnecting app sends one request per sidebar chat. Since 1.6.5 requests for the same
generation on one host connection share a single `execution/acquire`, and the adapter
caches its "which gateway SDK" answer while the SDK's bytes are unchanged.
Full text: [Many requests for unloaded chats at once](app-server-guide-chat-lifecycle.md#many-requests-for-unloaded-chats-at-once).

## Re-attaching a gateway chat

Since 0.4.7 a gateway chat whose executor went away is loaded again on a live one before
its next request, carrying only what the SDK cannot restore from the chat's own history.
The page covers the once-per-chat flight, the fail-fast window, the release-skew
messages and the immediate re-attach when only a shared executor socket closed.
Full text: [Re-attaching a gateway chat](app-server-guide-chat-lifecycle.md#re-attaching-a-gateway-chat).

### A listener that outlives its release

An adapter whose original `package` directory was pruned can continue saved chats on the
managed installation's `current` release, but only when the marker, link, version, SDK
receipt and component hashes all verify.
Full text: [A listener that outlives its release](app-server-guide-chat-lifecycle.md#a-listener-that-outlives-its-release).

## Native chats keep their model

The adapter never adds or changes `model`, `modelProvider`, `config.model` or
`config.model_reasoning_effort` on a native chat's `thread/resume`, `thread/fork`,
`turn/start` or settings update, so the signed SDK restores what the chat saved.
Full text: [Native chats keep their model](app-server-guide-model-catalog.md#native-chats-keep-their-model).

### Gateway sub-agents on native rows

A gateway sub-agent whose saved model is a native slug such as `gpt-6.1-sol` stays a
gateway chat and stays on the executor that owns it; the adapter repeats its saved
native model and provider only under a narrow saved-metadata check.
Full text: [Gateway sub-agents on native rows](app-server-guide-model-catalog.md#gateway-sub-agents-on-native-rows).

## Compaction and model changes

Moved to [Compaction and model changes](app-server-compaction.md).

## Codex 2 rows and the native catalog

Codex 2 rows borrow the harness half of the matching native row (model messages, tool
mode, defaults, context-window fields and the node_repl policy) looked up by
`upstream_slug`; everything else keeps the upstream value. The page also covers Code
Mode, the recovered-SDK `direct` tool mode, `max_context_window`, executor home links
and the `config.toml` snapshot.
Full text: [Codex 2 rows and the native catalog](app-server-guide-model-catalog.md#codex-2-rows-and-the-native-catalog).

### node_repl (browser, Chrome and computer use)

Gateway rows get the native node_repl policy, and rows with no native counterpart always
require review; the `codex-auto-review` reviewer is served through the Codex
subscription for every Auto-review approval in a gateway executor.
Full text: [node_repl (browser, Chrome and computer use)](app-server-guide-model-catalog.md#node_repl-browser-chrome-and-computer-use).

## Empty chats and message order

The SDK answers a `thread/start` or `thread/fork` before it announces the thread, and the
desktop depends on that order, so the adapter holds a new gateway thread's notifications
until the reply is written and then releases them in SDK order.
Full text: [Empty chats and message order](app-server-guide-chat-lifecycle.md#empty-chats-and-message-order).

## Queued messages (Cmd+Enter)

`thread/queue/*` goes to the chat's own engine and the SDK owns the queue; with
`gateway-executor-v3` a failed gateway turn also pauses automatic dispatch, and the
adapter copies local queued attachments where the service can read them.
Full text: [Queued messages (Cmd+Enter)](app-server-guide-chat-lifecycle.md#queued-messages-cmdenter).

## Processes and prediction forks on connected machines

Moved to [Processes and prediction forks on connected machines](app-server-forks.md).

## Speed controls

Moved to [Speed controls](speed-controls.md).
