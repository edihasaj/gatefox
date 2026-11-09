---
summary: 'Responses ingress overview and index: what the gateway translates, plus the anchors and links into the three Responses guide pages.'
read_when:
  - Changing Responses request parsing, tools, replay, or SSE output
  - Looking for which Responses guide page covers a behavior
---

# Responses support

Grok/xAI and official OpenRouter API connections use a function-only tool bridge for caller custom and
namespaced tools, with original identities restored on the client side and
encrypted reasoning preserved. See [API providers](api-providers.md) for this
compatibility route and named connection presets.

This document describes the OpenAI Responses ingress. The same provider catalog
also serves [native Anthropic Messages clients](messages.md), including Claude
Code. Selecting an inbound protocol does not select an upstream provider.

The gateway translates the caller's instructions and tool catalog. It does not
assign agent roles, choose workers, add task instructions, or provide agent-only
tools. Its catalog rows carry an empty instruction template, and the desktop
adapter blanks any template an inference host or old cache supplies. On the
desktop, Codex 2 rows take the base prompt and model messages from the client's
own native catalog row for the same upstream model, so Codex sends what it sends
that native model ([details](app-server.md#codex-2-rows-and-the-native-catalog)).
Claude, Copilot and other rows, and clients without a native catalog, get no
model-specific base prompt. Explicit and resumed client instructions remain
authoritative.

Client tools must be registered before the gateway can transport them. The gateway
SDK falls back to direct exposure for declared-deferred dynamic tools when the
selected model lacks tool search; it does not invent scheduling or app tools.
See [client tool reachability](client-tool-reachability.md) for discovery behavior,
the desktop scheduling boundary, and the isolated executable checks.

## Where the detail lives

The reference is split into three focused pages, each readable on its own. This page stays the current protocol overview and keeps every section anchor that other documents link to, so existing references keep resolving here.

| Page | Read it when you are changing |
| --- | --- |
| [Responses protocol, streaming, and failures](responses-guide-protocol.md) | the fields the gateway adds or preserves, item replay, stream terminals and heartbeats, failure classes and retry budgets, capacity admission, and the upgrade and internal-field hardening |
| [Responses tools across routes](responses-guide-tools.md) | tool declarations and identities, Chat Completions tool-call shapes, repeated declarations, the tool search bridge, and hosted web search |
| [Responses provider adapters and images](responses-guide-providers.md) | the Claude CLI adapter and its prompt cache, Codex subscription login refresh, Copilot live sessions, the ordinary Anthropic API route, and image inputs |

## Repeated tool declarations

A long chat can declare the same tool more than once, in Responses lite `additional_tools` input items or again in the current top-level `tools` list, and the gateway merges those declarations into its own catalog instead of refusing the request. Identity, precedence, scope and the `tool_declarations_merged` counts are on the tools page.

Full detail: [Repeated tool declarations](responses-guide-tools.md#repeated-tool-declarations).

## Tool search on the Codex subscription route

Native Codex rows can send a `tool_search` tool that the shared-subscription backend refuses, so search is off by default and a `codex-subscription` provider can opt in to a function bridge with `gateway tool-search on`. What each route drops, bridges, publishes and logs is on the tools page.

Full detail: [Tool search on the Codex subscription route](responses-guide-tools.md#tool-search-on-the-codex-subscription-route).

## Hosted web search

`web_search` is the one hosted tool the ChatGPT backend accepts through a shared subscription, so the Codex subscription route forwards it unchanged while every other route drops it. Probe results, catalog behavior and ownership are on the tools page.

Full detail: [Hosted web search](responses-guide-tools.md#hosted-web-search).

## WebSocket refusals, internal fields, and control items

`/v1/responses` is served over plain HTTP only: an upgrade attempt with a valid bearer gets 426 with no body, and recent Codex internal transport fields and executor control items are removed once in the request handler before any provider sees them. `/health` publishes the behaviors this release guarantees.

Full detail: [WebSocket refusals, internal fields, and control items](responses-guide-protocol.md#websocket-refusals-internal-fields-and-control-items).

## Ordinary Anthropic API

Configured reasoning effort maps to `output_config.effort`, outbound requests carry up to four ephemeral prompt-cache breakpoints, and only `end_turn`, `stop_sequence` and valid caller `tool_use` turns complete.

Full detail: [Ordinary Anthropic API](responses-guide-providers.md#ordinary-anthropic-api).

## Images

User messages and caller tool results accept `input_image` with an inline base64 `image_url`, verified by signature and encoding, limited to 8 MiB each inside a 64 MiB request. Remote URLs and uploaded file IDs are rejected. Per-route handling, the Claude item-block cache format and `inputModalities` are on the providers page.

Full detail: [Images](responses-guide-providers.md#images).