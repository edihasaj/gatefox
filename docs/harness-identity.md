---
summary: 'How gateway chats identify themselves to each harness: Codex records them as openai, Claude Code stores no provider, and the checklist for adding another harness.'
read_when:
  - Changing which provider id gateway chats are saved with, or the chatIdentity setting
  - Changing the gateway SDK patch, the executor marker, or the executor launch settings
  - Investigating why a gateway chat is missing from the phone or the native chat list
  - Adding a harness, or a client that lists or resumes gateway chats
---

# Harness identity

A gateway chat is a chat in some harness (Codex, Claude Code) whose inference the
gateway serves. Each harness stores something about who served a chat. That stored
identity decides which clients list the chat and which engine resumes it. This page
is the contract for each harness, and the checklist for a new one.

## Codex: new gateway chats are recorded as `openai`

Release 0.4.6 records new gateway chats with the provider id `openai`, the native
engine's own id. Before 0.4.6 every gateway chat was recorded as
`subscription_gateway`.

The reason is the phone. The ChatGPT app's Codex list, and a stock Codex engine's
`thread/list` without a provider filter, show only chats saved with the engine's own
provider, `openai`. Chats saved as `subscription_gateway` stay hidden there.

| Where | Legacy chat (`subscription_gateway`) | New chat (`openai`) |
|---|---|---|
| Rollout `session_meta.model_provider` and `state_5.sqlite` `threads.model_provider` | `subscription_gateway` | `openai` |
| Model field | the gateway alias, such as `codex/gpt-6.1-sol` | the same alias |
| Sub-agent of the chat | the parent's id, model often a native slug | `openai`, model often a native slug |
| How the adapter recognizes it | the provider id | the registry, then the parent link, then the alias |
| Listed by a stock engine with no filter | no | yes |
| Listed through the adapter with no filter, or with only the native default | yes (0.4.6 adds it to the list) | yes |

Existing chats are never rewritten. A resume names the provider id the chat was saved
with, because the SDK replaces a chat's SQLite provider when a resume names another one.
A fork is a new chat and gets the identity of the connection that makes it.

### How an executor serves `openai`

A gateway executor is the pinned gateway SDK (`gateway-sdk/gateway-codex`) started by the
adapter or by the shared execution host. It is not the built-in OpenAI provider.

1. The adapter starts every executor with `HARNESS_GATEWAY_EXECUTOR=1` in its environment.
   Native engines never get it; an adapter that inherited it removes it before starting one.
2. The executor's launch settings register the gateway's own provider as
   `model_providers.subscription_gateway` (loopback base URL, the `gateway token` command,
   `supports_websockets = false`, `request_max_retries = 2`,
   `stream_idle_timeout_ms = 90000`), and set `model_provider` to the identity for new chats.
3. The gateway SDK patch (`scripts/patches/gateway-executor.patch`, capability
   `gateway-executor-v2`) makes `openai` a second name for that provider, but only when the
   marker is `1` and the provider's base URL is plain HTTP on loopback. Inference,
   authentication, retries and timeouts are therefore exactly the legacy provider's. The
   SDK keeps no ChatGPT or API-key credential, so nothing it sends elsewhere carries the
   gateway token.
4. Because the alias is not named `OpenAI`, the SDK compacts locally (it never sends
   `compaction_trigger` items, which the gateway refuses), and does not send WebSocket
   requests or internal metadata. The patch also keeps context-limit compaction on the
   selected model inside the user's turn for both ids.
5. Every executor sets `analytics.enabled=false` and `openai_base_url` to the gateway. If an
   executor ever runs without the patch, `openai` still reaches only the loopback gateway,
   which refuses the request; it never reaches OpenAI.

The adapter uses `openai` for new chats only when the package's gateway SDK declares
`gateway-executor-v2`. A checkout without the artifact runs a stock Codex as its executor
and keeps `subscription_gateway`.

### Turning it off on one Mac

Add `"chatIdentity": "legacy"` to the gateway configuration and reconnect the desktop.
New chats are then recorded as `subscription_gateway` again. Chats already recorded as
`openai` keep working: every patched executor serves both ids, whatever the setting.
Releases before 0.4.6 ignore the key.

### Routing follows the chat

The adapter decides a chat's engine from the chat, never from the provider id. The
classifier (`src/gateway-chat-classifier.ts`) answers with the first rule that matches:

1. `legacy_provider`: the chat is saved as `subscription_gateway`.
2. `registry`: the chat is in `<state>/gateway-chats/<scope>.json`.
3. `parent`: a sub-agent whose parent (up to 8 levels) is a gateway chat.
4. `alias`: the chat's model is a gateway alias and not a native slug.
5. `native`: anything else.

The registry is written before a new chat's reply, before a sub-agent's announcement is
passed on, and, since 0.4.6, when a chat that only its parent or alias identified is
routed to an executor. That last case covers a sub-agent spawned while no desktop was
connected. Throwaway chats (composer predictions) are never written. A failed write is
reported once as `gateway_registry_write_failed`; such a chat is still recognized by its
alias, but a sub-agent on a native slug then depends on its parent's entry.

### Chat lists

When a `thread/list` asks only for the native engine's default provider, by naming it
alone or by naming none (and no parent or ancestor filter), the adapter asks the engine
for that provider and `subscription_gateway`. So a client that lists the native identity
through the adapter, such as the phone through the relay, also sees the legacy chats. An
empty list (every provider), several providers, another provider, or a parent filter is
sent unchanged. The native default is read from the engine's configuration.

### What the phone does

| | Without the relay | With the relay |
|---|---|---|
| List | The app's own engine answers: new `openai` gateway chats are listed, legacy ones are not | The adapter answers: both are listed |
| Open | History is shown | History is shown |
| Continue an `openai` gateway chat | The app's engine runs it on OpenAI's provider and sends the alias, which OpenAI refuses | Routed to the gateway executor |
| Continue a legacy chat | Not reachable from the list | Routed to the gateway executor |

### Rollback

| Back to | New `openai` gateway chats | Legacy chats |
|---|---|---|
| 0.4.4 or 0.4.5 | Listed and continued: the registry routes them to the gateway. Those releases resume a gateway chat with `subscription_gateway`, so each one resumed there is saved as `subscription_gateway` in SQLite (the rollout keeps `openai`) and drops off the phone's list | Unchanged |
| 0.4.3 or older | Listed, but they cannot be continued: those releases classify by provider id and send the alias to OpenAI | Unchanged |

## Claude Code: no provider id

Claude Code sessions store the model name, never a provider. There is nothing to
rename, and no list filters by provider. A gateway session is one whose model is a
gateway alias (see [Messages](messages.md)). Remote Control needs `api.anthropic.com`
and a claude.ai sign-in, so no naming change makes a gateway session reachable from the
Claude app.

## Copilot

Copilot models reach Codex as gateway aliases, so a Copilot chat in Codex follows the
Codex contract above. The Copilot CLI's own sessions are the gateway's private state
([live Copilot sessions](copilot-sessions.md)) and are not listed by any harness.

## Checklist for a new harness

1. Find what the harness stores per chat that names who served it (provider id, base URL,
   account, model), and which clients filter their lists by it.
2. Prefer the harness's own native identity for new chats, so its stock clients list them.
   Never rewrite chats that already exist; a resume must name what the chat was saved with.
3. Keep routing independent of that identity: record each new chat, and its sub-agents,
   before the client sees it, and classify by chat, not by the stored id.
4. Make sure the native identity cannot send a gateway chat to the vendor: mark the
   gateway's executors, check that the endpoint is loopback, and fail closed without them.
5. Turn off the harness's analytics and any account-backed calls in executors, and check
   that no request outside the gateway carries the gateway token.
6. Keep the harness's compaction and retry behavior the same as under the gateway's own
   provider, and test it with the real harness binary against a mock upstream.
7. Put the switch behind a per-Mac setting, and write down what an older release does with
   the new chats before shipping.

The end-to-end check for Codex is `scripts/e2e-identity.mjs`.
