---
summary: 'Per-provider Responses behavior: Claude failures and CLI prompt cache, Codex subscription login refresh, Copilot live sessions, the Anthropic API route, and image inputs.'
read_when:
  - Changing the Claude CLI adapter, its prompt cache, or its failure classes
  - Investigating a Codex login refresh, a Copilot cancellation, or an Anthropic API request
  - Changing image inputs, model modalities, or per-route image handling
---

# Responses provider adapters and images

Part of [Responses support](responses.md). Selecting an inbound protocol does not select an upstream provider; these are the behaviors that belong to one inference route. The shared request contract is on [Responses protocol, streaming, and failures](responses-guide-protocol.md) and the tool rules on [Responses tools across routes](responses-guide-tools.md).

## Service tiers and flex per provider

Flex depends on the provider. The Codex subscription path passes `flex` through to
the upstream, and the model's declared tier list does not apply to it, as in native
Codex; the ordinary Responses API provider forwards it the same way. Claude and
Copilot run `flex` as Standard (see their sections below). The Anthropic API and
Chat Completions providers ignore every service tier.

Claude subscription requests map `priority` (or `fast`) to the CLI's fast mode
setting (`--settings {"fastMode":true}`) when the model's catalog row offers Fast;
`flex` has no Claude equivalent, so it runs the turn as Standard with no fast mode
setting; any other tier the model does not offer (`scale`, an unknown name) is
rejected before the CLI starts. The CLI reports its fast mode
state. When fast mode stays on, the completion reports `priority`. When Claude
refuses it (for example, no usage credits) and falls back to standard speed, the
turn still completes and reports `default`.

## Claude adapter failures and rate limits

Native Claude `assistant.error` discriminants identify subscription rate limits,
authentication, billing, and server failures before an opaque result is handled.
Billing refusals report: "Claude billing or extra-usage credits are unavailable.
Check your Claude billing settings and payment method, then retry." The gateway
also recognizes bounded, known credit-refusal messages inside native failure
results when the CLI omits its billing discriminant. These failures are final
`insufficient_quota` errors, so Codex does not repeatedly retry a charge that needs
account action. The gateway never returns the provider's private refusal text or
guesses whether a card was declined for insufficient funds. Ordinary successful
assistant text and an unexplained disconnection do not establish a billing failure.
In particular, `is_error: true` with `subtype: success` is not successful inference.
The CLI reports every 429 as `rate_limit`, including a transient subscriber
capacity throttle ("not your usage limit"). Only a `rate_limit_event` with status
`rejected` earlier in the same request proves a subscription limit; that becomes
a clear, final usage-limit failure. Any other Claude rate limit is a retryable
`rate_limit_exceeded`, so Codex retries it as it did before usage limits became
final. Neither is routed to another account automatically. Unknown result
subtypes remain bounded diagnostic metadata; private error text is never returned
or logged.
The native `rate_limit_event` supplies the affected five-hour or weekly window
and reset timestamp. A rate-limit failure includes that provider-reported time
in the inference host's local timezone and UTC. Missing metadata remains unknown;
the gateway does not guess a reset or retry across a subscription limit.
Claude replays public reasoning summaries as explicitly identified historical
summary items, separate from ordinary assistant messages. Their readable text
is preserved; the gateway does not invent thinking blocks or native signatures.
Encrypted reasoning transport state is not exposed to the Claude model. Hosted tools are outside
the current Claude adapter's scope. Unsupported item and tool types return a
client error instead of an internal crash.

## Codex subscription login refresh

A Codex subscription request whose token refresh fails on the network, with an
unreadable or malformed reply, or with any HTTP error status other than 400, 401 or 403 (for example
a 429 or a 5xx, often right after the Mac wakes) returns a retryable
`upstream_unavailable`, so Codex reconnects instead of ending the chat. Only a
missing login, a stored login without a refresh token, an unreadable credential file, a stored
login or refresh reply without the plan scopes, or a refresh rejected with HTTP 400, 401 or 403
reports "ChatGPT provider requires login". When the token endpoint names a reason, the message adds its OAuth error code. A rejected login reads
"ChatGPT provider requires login (refresh rejected: refresh_token_reused)" and a temporary failure
reads "ChatGPT login refresh failed temporarily (temporarily_unavailable); retry shortly". A code
outside the fixed list shows as `other`, and a reply without a code adds nothing. `request_failed`
telemetry records the same code (see `docs/diagnostics.md`); only the code is kept, and the reply's
description, body and tokens are never recorded or shown. A failed refresh is not retried inside the request, because a second token request
could spend the single-use refresh token again; Codex reconnects on the retryable 503 instead.

The refresh token is single-use, so only a real request or an explicit
`gateway discover` ever spends it. The six-hour model-metadata refresh never refreshes
the Codex login: whenever serving the Codex access token would need a refresh (it has expired, or
it is within two minutes of expiring unless the issuer's `earliest_refresh_at` has not passed yet),
that provider is skipped for the round (`model_metadata_skipped`) without any network
call, and the next real request refreshes it. This keeps a refresh from being started
while the Mac is asleep, where the reply can be lost after the token was spent. Claude and
Copilot discovery in the same refresh still run their own CLI or SDK, which may refresh its
own login; guarding them is left to a later release. When a refresh reply arrives, any
replacement refresh token is written to the credential file (atomically, mode 0600) in the
same save that records the outcome, so a reply that fails a check never loses the rotated
token. How the reply is handled:

- A valid reply that omits `scope` (or sends `null`) keeps the scope granted earlier (RFC 6749 sections 5.1
  and 6) and is used normally; a `scope` that is present but not a string counts as malformed.
- A reply whose `scope` lacks the plan scopes can only be fixed by signing in again (`gateway login ID`
  with plan usage enabled). The gateway keeps the old access token and only the scopes that
  reply granted, so that request and every later one report "ChatGPT provider requires
  login" without another token request, in this process or another one waiting on the
  refresh lock.
- A malformed reply (no bearer access token or no positive lifetime) is temporary, whatever its
  scope says, and is checked before the plan scopes. The
  request returns the retryable `upstream_unavailable`, the stored access token, scopes and
  expiry stay as they were, and the next real request refreshes again with the saved
  replacement token, or with the stored one when the reply carried none.
- A valid reply without a replacement refresh token is used. The new access token is saved
  and the stored refresh token stays, because a server may keep a refresh token instead of
  rotating it (RFC 6749 section 6).

## Copilot sessions and cancellation

Copilot uses the same normalized text and replay contract. It registers native
SDK custom tools and returns their real calls before any execution. SDK reasoning
summaries stream separately; `auto` requests a concise summary. The adapter rejects
BYOK usage, unexpected model/provider changes, host permission requests, foreign
tools, inconsistent final text, unsupported SDK versions, and incomplete turns.
By default the thread keeps one live CLI session, and a request sends only the
items that are new; see [live Copilot sessions](copilot-sessions.md). Cancelling a
live request aborts its session and kills its CLI process (about 2 seconds: the abort is bounded to
2 seconds, then the CLI is killed and its folder removed); the
request hands over the usage the CLI reports meanwhile and then ends. The next request
starts a new session and sends the caller-supplied history once. Cancelling a one-shot request stops
its CLI process and waits for it to exit; a process outside the CLI's group that keeps its output open
delays that by half a second of silence on the CLI's output, or by at most about 5 seconds (100 ticks) when output keeps arriving, after which the gateway closes its pipes. Either way, usage the CLI reported before the
cancellation, or reports while it is being aborted, still reaches the usage ledger and telemetry.
Anonymous first questions, explicit compaction/prewarm/memory requests and explicitly
selected one-shot mode use standalone sessions. Capacity, concurrent work, startup,
delivery and live-stream failures return a final refusal instead of automatic replay.
Historical anonymous conversations require a caller conversation ID. The
[full list](copilot-sessions.md#how-a-request-is-served) names each case.
The current Copilot CLI exposes no selected-model priority tier. Direct
`priority` or `fast` requests return `invalid_request` before opening a session.
`flex` also runs as Standard: the request is accepted and no tier is sent to the CLI.
Normal requests retain the selected model, reasoning, and subscription route.

## Ordinary Anthropic API

Configured reasoning effort maps to `output_config.effort`; unsupported model
levels fail before inference. `summary: "none"` hides thinking deltas. Tool calls
must have distinct IDs, valid object input, and names allowed by the current
catalog and tool selection. Required tool selection cannot finish without a call.
Outbound requests carry up to four ephemeral prompt-cache breakpoints
(`cache_control: { "type": "ephemeral" }`): the last tool, the last system block,
and the tails of the last two messages, regardless of their role. A block already
marked is never marked twice, nested tool-result content never receives a marker
of its own, and markers never reorder or merge caller blocks.

Only `end_turn`, `stop_sequence`, and valid caller `tool_use` turns complete.
Paused, truncated, refused, and unknown stop reasons fail, including
`model_context_window_exceeded`. These rules follow Anthropic's
[effort](https://platform.claude.com/docs/en/build-with-claude/effort) and
[stop reason](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
contracts. The gateway does not retry or choose another billing route.

## Images

User messages and caller tool results accept `input_image` with an inline base64
`image_url`. PNG, JPEG, GIF, and WebP signatures and encoding are validated before
inference. An image is limited to 8 MiB encoded. The whole request is limited to
64 MiB, above what upstreams accept, so a long chat with many screenshots reaches
the provider as it would natively and the provider's own limit applies. (Before
0.3.8 the cap was 10 MiB, which refused such chats with a 413.) Remote URLs and
uploaded file IDs are rejected. The gateway does not
fetch image URLs or borrow the primary account's file access.

### Claude CLI prompt cache and item blocks

Each Claude inference starts the official CLI with one user message. The adapter
sends each conversation item as its own content block, oldest first, and puts
per-request instructions last. Earlier blocks stay byte-identical as a tool loop
grows, so Claude reuses its prompt cache. In a measured three-round loop, the
second and third rounds were about 98% cached; the former single-string prompt
was 0% cached after the first change. Claude cache reads are reported as
`input_tokens_details.cached_tokens`.

Each item block is plain text: a header line such as `<<item 3 user>>`,
`<<item 4 tool_call NAME ID>>` or `<<item 5 tool_result ID>>`, the raw text, and a
closing line `<</item>>`. A body line that starts with `<<item ` or is `<</item>>` is
escaped with a backslash, so item boundaries cannot be forged. The closing line
matters for spend: Claude never reuses a cached prefix whose last block ends in
whitespace once more blocks follow, and tool output usually ends in a newline.
Without it (0.3.2 to 0.3.5), each one-shot request reused only the system and tool
prefix and rewrote the whole conversation; measured on Haiku, the cached prefix
stayed at 921 tokens for five rounds, and grows every round with it. This replaces the earlier JSON-escaped items, which
cost 3–13% more characters. The first block is fixed text and no longer lists tool
names, so a catalog change no longer rewrites it. `claudeSessions.replayFormat:
"json"` on the Claude provider restores the JSON encoding. The format change means
each active Claude chat pays one full cache write on its first request after the
update.

The CLI runs with `--allowedTools` limited to the gateway's MCP tools, so it cannot
answer a caller call itself. When Claude asks for several tools at once, every
complete call reaches the caller in one response; the CLI is stopped when the API
message ends, before it can act on the calls. A message cut short by `max_tokens`
returns only the calls it completed. Output tokens come from the final
`message_delta`, so tool turns report what was actually generated. Cancelling a
request stops the CLI at once instead of waiting 1.5 seconds. A forced
`tool_choice` keeps the full catalog, so it does not break the prompt cache; a final
block names the required tool. A mismatched call ends the request without
changing the catalog or automatically retrying inference.

With `claudeSessions.mode: "live"`, the gateway instead keeps one CLI session per
Codex thread, so history, thinking and the prompt cache stay native; see
[live Claude sessions](claude-sessions.md). Live mode is the default. A mismatched call
fails with a code Codex treats as final; Gateway does not retry with another catalog.

The caller's instructions and the system and developer messages before the first
other message become the CLI's system prompt, after the gateway's fixed backend
text, which is where Claude Code keeps its own instructions. The prompt is written
to a private file and passed with `--system-prompt-file`, so caller text never
appears in the process list. The rest of the history renders as item blocks,
numbered from its first message. A later developer message stays an item in the
history, and a history that holds only system and developer messages keeps them
all as items. With Codex, its three leading developer messages (about 24,500
characters) moved from the user message into the system prompt.

Each Claude row's default effort is the CLI's own default for that model. Model
discovery reads it without inference: after `initialize`, it sets the
session-scoped model with `apply_flag_settings` and reads the applied effort from
`get_settings`, because the `initialize` model list carries no default. CLI
2.1.293 reported medium for Opus 5.5, Sonnet 5.5 and Haiku 5.5; high for Fable
5.1, Fable 5, Opus 5, Sonnet 5, Opus 4.8, Opus 4.6 and Sonnet 4.6; and xhigh for
Opus 4.7. The value is stored as `defaultReasoningEffort` in the model metadata. A
model for which the CLI reports no level, or a level the row does not offer, keeps
medium. Each discovery replaces the stored value, so a refresh in which the CLI
reports no level, or `get_settings` fails, returns the row to medium.

One-shot and live CLIs both run with `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` and
`ENABLE_TOOL_SEARCH=false`, so the CLI declares only the gateway's tools (one-shot
CLIs used to add two of their own). Neither inherits the host's `CLAUDECODE`,
`CLAUDE_CODE_*` or `CLAUDE_AGENT_SDK_*` variables. A desktop entrypoint inherited
from a Claude Code shell made each one-shot CLI send an extra post-turn summary
request and print its result about 2 seconds after the turn ended. The gateway
sets `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` to the longest caller tool
description, and never below the CLI's default of 2,048 characters, so every
description reaches the model whole. Before, the CLI cut longer ones at 2,048
characters.

A one-shot text turn ends at the `message_delta` whose stop reason is `end_turn`.
The request completes with that message's usage, without waiting for the CLI's
result. The gateway then reads the CLI's output for at most 100 ms, to keep the
rate limit the CLI prints right after the turn and the context window a prompt
result reports, and stops the CLI. Any other stop reason still waits for the
result and keeps its error classification. Measured with CLI 2.1.293 on Haiku 5.5
and Sonnet 5.5, the time from `message_delta` to `done` fell from 1.6–2.8 seconds
to under 2 ms for a gateway started from a Claude Code shell, and from 4–8 ms to
under 2 ms in the installed service's environment. Live sessions already received
their result within 7 ms and still end there. A Fast turn also waits for the
result, because only the result reports the tier served: when Claude refuses or
throttles a fast request, the CLI retries at standard speed without printing a
line, so the `on` state from its first line can be stale.

The system prompt, the item numbering, the smaller tool list and the uncut tool
descriptions all change Claude's cached prefix. They ship in one release, so each
active Claude chat pays one full cache write on its first request after the
update. Live sessions reseed once after an inference restart anyway, so they pay
that same single write.

### Images on each provider route

Claude receives native image blocks through the official CLI's streamed input.
Copilot receives a history item's images as file attachments on the message that owns
them: the gateway writes each image (mode 0600) into the CLI's private folder, which is
removed with the session, because one RPC message to the CLI is limited to 16 MiB.
Tool-output images travel inline as binary results of the waiting tool call while the
result stays within 12 MiB; a larger one starts the thread's session over, which sends
those images as files too.
Their text conversation contains labels for image ownership and order, never the
image bytes. Each native harness controls its own image preprocessing. Codex and
ordinary Responses upstreams retain the original image parts and detail setting.
Anthropic API requests retain ordered native image blocks, including tool results.
Chat Completions providers (local Qwen through vLLM) receive images only for a model
whose `modelMetadata` lists `"inputModalities": ["text", "image"]`. A user message
keeps its text and images in order as `image_url` data URLs. A tool result keeps its
text in the tool message, because Chat Completions tool messages carry text only; its
images follow in one user message after the run of tool results, so the results stay
contiguous after the assistant's calls. A model whose metadata lists only `text`
still refuses images with `unsupported_input` ("This chat model does not accept
images"). The vision check in `scripts/e2e-chat-compaction.mjs` verifies both paths
against the real model.

Model metadata carries `inputModalities`. The desktop adapter preserves those
capabilities rather than declaring every added model text-only. Updating an older
adapter executable requires a fresh launch; later catalog capability changes use
the normal live refresh path.