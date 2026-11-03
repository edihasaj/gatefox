---
summary: 'Provider session reuse, cache affinity, final replay refusals, and explicit unsupported paths.'
read_when:
  - Auditing cache efficiency or unexpected subscription consumption across clients
  - Adding or changing a provider transport, CLI fallback, or conversation identity
  - Investigating a session_continuity_unavailable refusal
---

# Conversation reuse

Gateway preserves the caller's chat, instructions, selected model and account,
permissions, and tool execution. It reuses native provider sessions where that
transport supports them, and stable cache routing where the API requires full
history. Sending history over HTTP is not evidence that the model processed the
whole prefix again. Provider-reported cache reads establish reuse; missing counts
remain unknown.

| Transport | Reuse and boundaries |
| --- | --- |
| Codex subscription | Direct Responses HTTP, not one CLI per request. Caller cache keys, account-scoped encrypted reasoning and turn-state headers remain intact. When a client supplies a conversation ID but omits a cache key, Gateway derives a stable account/conversation key. Anonymous calls are not grouped. The subscription endpoint does not support `previous_response_id`. |
| Claude subscription | Live sessions are the default. Matching histories append new items; complete tool results plus caller updates use acknowledged queued input. Explicit replay mode remains an opt-in compatibility choice. Warmup and explicit compaction/prewarm/memory requests can run standalone. |
| Copilot subscription | Live sessions are the default. Complete pending results followed by caller messages use acknowledged `session.send` immediate admission before result delivery. A warm session is not evicted for a newcomer. |
| Chat Completions, including Qwen | HTTP requests carry history. Opted-in local-router session affinity keeps a conversation on its worker. Equivalent catalogs and schema object keys are canonicalized to avoid accidental prefix changes. Actual KV/prefix reuse belongs to the inference server. |
| Anthropic API | HTTP history with ephemeral cache breakpoints. Equivalent catalogs and schema objects use stable translated tool positions. |
| OpenRouter and OpenCode | Existing explicit caller cache/session keys and documented provider affinity headers are preserved. Provider cache accounting remains authoritative. |
| Grok subscription | Live sessions are the default: one `grok agent stdio` (ACP) process per conversation behind a mandatory tool-less agent profile, with caller tools as held calls on a loopback MCP endpoint. Matching histories (the pending tool outputs, or new user messages after a finished turn) continue it; every other history, and any request for a conversation whose session already ended (including the original request again, also after a gateway restart: the ended record is persisted), is a final 400 `session_continuity_unavailable`, never a replay. Requests without a conversation id, and compaction/prewarm/memory, run standalone (`grok -p`), which still refuses historical turns. No automatic model switch is made. See [Grok sessions](grok-sessions.md). |

## Final refusals instead of hidden replay

An ordinary live request that cannot attach because of capacity, concurrent work,
startup failure or an unavailable adapter ends with HTTP 400
`session_continuity_unavailable`. A failed live CLI, queued-input admission or
tool-result delivery also ends without an automatic one-shot retry. This applies
after partial output or usage as well: Responses receives a final stream code so
the client does not reconnect and silently reseed the failed request.
Deterministic tool, confinement and malformed-stream failures retain their original
diagnostic class and charged usage, but use final client errors across Responses,
Messages and nonstreaming HTTP. Transient availability/throttle recovery keeps its
existing behavior.

Claude and Copilot keep usable sessions when a history or pending-tool mismatch
cannot safely continue. Corrected history can use the same session. Copilot closes
an uncertain effort switch instead of inferring with an unconfirmed setting or
replaying it. Claude forced-tool mismatches are final; Gateway does not retry with
a smaller catalog. A known pre-inference authentication rejection retains its
separate bounded recovery behavior.

Both live CLI routes preserve public reasoning as typed summaries. The live
ledger skips those summaries while retaining their rendered positions; converting
them into ordinary assistant messages would falsely refuse a valid continuation
after tools. A previously preserved Copilot session can accept corrected typed
history without a restart, a reseed or another full-history replay.

Live CLI conversations require a stable caller identity. Anonymous first questions
remain standalone, while anonymous historical conversations are refused. Gateway
never merges chats by prompt similarity or arbitrary user identity. Native Claude
Code's validated session metadata and the supported session/thread headers provide
that identity across clients.

Genuine model, system/tool catalog and compaction-window changes, completed client
compaction, expired/dead sessions and full inference-process restarts can require a
new seed. They are not free, and cache reuse is never guaranteed by session presence.
The [cache safety guard](cache-safety.md) remains a bounded backstop, not an
account-wide spending ceiling.

## Evidence and operations

The app's Diagnostics screen reports cache samples and reads/writes by model on
the inference Mac. `gateway diagnostics --since 1` also reports Claude and Copilot
session decisions. Blocked and preserved session decisions appear among diagnostic
issues. Prompts and tool arguments are not added to logs.

The final ingress audit also covers Claude Desktop's separate auxiliary native
classifier. These are independent tool-free classification calls, rather than
continued agent chats. They retain their native request controls and use a
separate bounded cache budget, including usage reported before a later failure.

Native Copilot 1.0.97 and 1.0.98 were qualified against a loopback synthetic API:
three acknowledged immediate messages while a tool waited made no additional
inference; delivering its result produced one continuation containing all three
messages and the result. Two model calls served the whole loop. This proves
protocol ordering, not real subscription pricing parity.

The November 1 audit found prefix caching explicitly disabled on both Qwen workers
after an earlier exact tool-input corruption. That is a server correctness limit,
not evidence that Gateway discarded a session. An isolated aligned-checkpoint
trial has its own dual-router drain, immutable image checks, memory floor and
independent recovery. Its outcome must be recorded before enabling that candidate;
neither a successful HTTP reply nor stable routing establishes cache correctness.

See [Claude sessions](claude-sessions.md), [Copilot sessions](copilot-sessions.md),
[Grok limits](grok-sessions.md), and [diagnostics](diagnostics.md).
