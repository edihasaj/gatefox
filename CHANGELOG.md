# Changelog

## Unreleased

Three search fixes from an independent review. With the tool search bridge on, a
caller's own function named `tool_search` in the default `functions` namespace is
no longer mistaken for the client's search: the bridge name avoids those names, and
calls are intercepted only when the request declares search. On a generic Responses
route, a tool declared in an `additional_tools` item, including one inside the default
`functions` namespace, now wins over an older copy that an earlier search loaded. A `tool_choice` naming `web_search` is accepted on the Codex
route when the request declares the tool, and becomes `auto` on routes that cannot run
hosted search. The bridge, hosted web search and a Claude-to-Codex goal switch also
passed live checks on 22 October 2026.
Thanks to @edihasaj for asking for the live checks and review.

Shared gateway executor connections now rejoin a known active chat after a
client-socket drop. The adapter restores only SDK-recorded state and never
replays prompts, steering requests, tool results or approval decisions. A genuine
pending approval remains available for an explicit answer.
Thanks to @edihasaj for reporting chats that required manual reconnection.

The service now starts the native relay from the installed release even when its plan names an older release folder. A plan written by an older installer could pin `releases/0.5.0/package/native/gateway-native-relay`, so every update and every service restart kept starting that 0.5.0 relay and health kept reporting it as lagging. The supervisor now uses `current/package/native/gateway-native-relay` whenever that relay is installed, and it leaves the plan file unchanged so staged native-sharing receipts still match it.

`gateway tool-search on`, `off` and `status` turn the tool search bridge on or off for every
Codex subscription provider without editing `gateway.json` by hand. The command validates the
file before saving it, changes no other setting, and the running service picks the change up
without a restart. The bridge stays off by default. It now gives the `additional_tools` item it
inserts after a search result the role the backend requires; without it, a Responses lite
request that loaded tools would have failed with HTTP 400. `scripts/probe-tool-search-bridge.mjs`
checks both search rounds offline with `--dry-run`, or against the real backend, where every
bridged request shape passed the backend's request validation.
Thanks to @edihasaj for asking for a dry run and an easy switch.

Codex tool search can work through the gateway as an opt-in. With `"toolSearch": "bridge"`
on a `codex-subscription` provider, the gateway sends Codex's `tool_search` as an ordinary
function, which the shared-subscription backend accepts, and returns the model's search to
Codex, which still runs it. Loaded tools are declared again where the search returned them,
so a Responses lite chat keeps its prompt prefix. The default stays off, and every other
route now drops search items instead of refusing the request, keeping the tools a search
loaded, so a chat can switch away from Codex 2. The Claude session ledger also no longer
counts search and hosted web search items as conversation messages. The bridge has not yet
been checked against the real backend, because the account's sharing usage limit was reached.
Thanks to @edihasaj for asking to keep tool search available even before it is needed.

The rollout readiness probe accepts gateway SDKs that ship the Code Mode host.
Its direct-tools canary previously required a hostless SDK, so every package
carrying the new host failed readiness before it could be installed. The canary
now gives a hosted SDK explicit direct native rows and still proves that child
chats edit files and make commits through direct tools.

Codex 2 chats can use OpenAI's hosted web search. A Codex 2 row now copies the
native model's `web_search_tool_type`, and the Codex subscription route forwards the
`web_search` tool and its replayed `web_search_call` items exactly as native Codex
sends them; the ChatGPT backend accepts this one hosted tool (`tool_search` stays
off, and its refusal names web search as allowed). Claude, Copilot and every API
route drop the tool and its items instead of failing the request, so a chat can
switch models mid-work, and each drop is counted in a `web_search_dropped`
telemetry event. The gateway no longer forces `web_search` off when it starts or
resumes a chat, and the Codex config it generates leaves the setting at Codex's
own default.
Thanks to @edihasaj for asking to make gateway Codex match native web search.

Gateway executors now get native Code Mode. The packaged gateway SDK ships
Codex's `codex-code-mode-host` beside `gateway-codex`, and its build receipt pins the
companion as `codeModeHostSha256`, so an executor only runs Code Mode after the
verifier has matched that file byte for byte. A package whose receipt names no host,
including every release before this one, keeps the explicit `tool_mode: "direct"`
catalog it has today. A host file that the receipt does not name fails the SDK's
verification instead of enabling Code Mode. App signing gives the companion its own identifier and the two JIT
entitlements V8 requires, and the host statically links V8 through Codex's code-mode
runtime, whose license is listed with the other Cargo packages in the SDK's
`dependencies.json`. The SDK build fetches that V8 library from OpenAI's own
`rusty-v8` release, the same way Codex's CI does, and checks it against a checksum
pinned in the verified Codex source. `scripts/e2e-code-mode-host.mjs` runs a Code Mode
cell through the built SDK and a mock provider, and confirms that the same SDK without
the host fails.
Thanks to @edihasaj for asking to make gateway Codex match native Code Mode.

The bundled runtime and release checks use Node 24.22.1, including the security
fixes released on 21 October 2026. Existing signed macOS apps receive the runtime
through the normal signed app update.

Grok models can run on a Grok subscription through the official Grok Build CLI
in a private, gateway-owned Grok home. Grok's own tools, xAI-side tools and
personal MCP servers are switched off; caller tool calls return to the client,
which executes them. Requests that would let Grok act on its own fail closed.
Thanks to @edihasaj for asking to use the Grok allowance from the model picker.

Turn telemetry now records the engine and model of chats that an engine starts
on its own, such as sub-agents and reviews. These turns were previously logged as
`provider: "unknown"` with no model, which hid about three quarters of all turns.
A new real-inference check, `scripts/e2e-goal-switch.mjs`, switches an active
goal's chat from Claude to Codex 2 and requires the next automatic turn to run on
the new model.
Thanks to @edihasaj for asking whether silent model switches really took effect.

A ChatGPT account that has used its shared-subscription allowance now stops
the turn with a usage-limit message. Previously the gateway did not recognize
`subscription_sharing_usage_limit_exceeded`, so Codex retried five times and
reported a stream disconnect.
Thanks to @edihasaj for reporting the misleading message after Codex 2 ran out.

Claude requests can recover one explicit upstream authentication rejection before
any output or tool dispatch. Expired, revoked, missing and unclassified logins
remain final, and a repeated rejection stops with its original error. Diagnostics
record a fixed failure reason without retaining provider text or credentials.
Thanks to @edihasaj for reporting chats that resumed without signing in again.

Native executor sharing can be staged for the service's next natural start,
without quitting applications or changing the active service plan. Adoption
preserves existing gateway sharing and components, rechecks the signed SDK and
old writers, and remains pending while ownership is uncertain. Managed private
native engines reserve the matching native home before starting, preventing a
shared host from racing them. Rollout readiness also requires staged adoption
to finish and the native home to be owned when native sharing is enabled.
The signed native 0.163 engine passed detached completion, single-execution
command recovery, and approval replay checks over stdio and Unix.
Thanks to @edihasaj for reporting interrupted work during travel and disconnects.

Release readiness now requires evidence from loaded processes and the serving
execution host, including an isolated SDK tool canary. Older adapters cannot
create a gateway catalog that requires an unavailable Code Mode host. The live
upgrade regression keeps a chat connection open while replacing its host and
checks that tools and child-agent commits continue without replaying prior work.
Thanks to @edihasaj for reporting the incomplete executor adoption after updates.

Gateway updates preserve the release files that open desktop and SSH connections
still use. A connection whose older release was already removed can recover its
gateway SDK from the installed release after validating it against the loaded
code's compatibility and integrity checks. Saved chat identities stay unchanged.
Executors without the optional Code Mode host keep direct tools available,
including for sub-agents, so file edits and Git commands do not depend on a
missing helper.
Thanks to @edihasaj for reporting the failed chat resume after an update.

Claude billing and extra-usage credit refusals now explain how to check billing
settings and payment methods. These failures stop automatic stream retries and
keep private provider diagnostics out of responses and telemetry.
Thanks to @edihasaj for reporting the unclear billing error.

The service publishes the release it actually loaded, independently of the
installed `current` link and signed app runtime. The watchdog checks that report
against the live service process, so an older JavaScript service cannot appear
updated merely because installation changed the link.

Gateway generation cleanup runs in the background after release or disconnect
and periodically, so an older engine that stops answering cannot block a new
catalog. Loaded chats and live client leases preserve their writers. The
watchdog also fails a service that remains on any older release for more than
one hour after installation, including patch updates.

Gateway chats can load more than four catalog generations without closing older
chats. Loaded chats and client leases keep their original executors, and unused
executors are reclaimed before another generation starts. This fixes the
"Four gateway generations have loaded chats" resume failure.

Claude's private Qwen route can preserve generated no-tools text that the
upstream tool parser silently discarded. A pinned tokenizer decodes complete
raw output, and unsolicited XML remains text rather than an executable call.
The policy requires explicit private opt-in and preserves the existing
tool-enabled path. Thanks to @edihasaj for requesting the root-cause fix.

Claude's private inference service can recover a clean, empty Qwen completion
with one identical request to the same model. A second empty reply becomes an
explicit failure. Retry spend remains in the ledger while Claude receives the
final attempt's context usage. The policy requires explicit private opt-in.
Thanks to @edihasaj for reporting the blank replies.

Both registered GPT accounts passed native automatic compaction at about 193K
input tokens, including exact fact recall after a separate resume. A fresh Qwen
check stopped on empty initial replies before reaching its large-input phase;
an unchanged repeat passed at 193,210 tokens. The failed sample remains a
first-attempt reliability limit.
Thanks to @edihasaj for requesting the additional verification.

Claude Desktop's private inference service can run genuine native Claude Auto
reviews with their original generation controls and protocol metadata. A
Claude-only context proxy also preserves recognized Qwen input-overflow errors,
so scoped reactive compaction can recover beyond the unknown-model estimate.
The private rollout passed native Auto review and mixed-model subagent tasks
on three Macs. Thanks to @edihasaj for the acceptance testing.

Claude's private frontend now refuses to start backend work when a client
disconnects during asynchronous classifier selection. A regression reproduces
the abandoned request before the fix and verifies the listener stays available
after cancellation. Native cancellation and bounded live Qwen manual compaction
also passed their dedicated checks. A rendered Desktop Auto task passed with
the default Fable parent, Qwen reader, and second-account GPT writer.

## 0.5.4 — 2026-10-19

Claude Desktop can use an opt-in model catalog with real account labels for
Claude, multiple GPT registrations, and local API models. The separate adapter
preserves native tool and subagent execution, handles optional GPT tool
arguments, and includes explicit configure, serve, install, and status commands.
The existing Codex client and its routing are unchanged.

Thank you to Edi Hasaj for testing the Claude Desktop integration across three Macs.

Harness Gateway now has a native macOS app with the fox icon, a setup wizard,
connection and model management, and a signed background launcher. The app keeps
the existing gateway running when its window closes and preserves its settings.
The signed runtime keeps the app identity stable across installed CLI updates.

Production releases can update the app and gateway together through the existing
background service. Updates verify the signed app and canonical gateway archive
before installation, preserve the previous app for recovery, and wait for the
settings window to close.

GitHub builds require an explicit production-branch dispatch and build opt-in.
Ordinary pushes, pull requests, and default dispatches do not allocate runners.

Thank you to Edi Hasaj for the native macOS app.

## 0.5.3 — 2026-10-18

Codex subscription providers now receive plaintext collaboration message schemas.
This prevents the upstream from encrypting delegated tasks that gateway providers
cannot replay, completing the task-delivery fix for Codex 2.

## 0.5.2 — 2026-10-18

Delegated tasks and follow-up messages now reach Codex sub-agents as plaintext.
The gateway preserves the protocol marker that prevents Codex from treating
these messages as encrypted payloads and dropping their contents.

## 0.5.1 — 2026-10-18

Codex can open sub-agents spawned from gateway chats when the child uses a native
model name. Resuming a child preserves its saved provider and reasoning settings.

## 0.5.0 — 2026-10-18

Connected clients now receive real runtime status from private gateway engines.
Thank you to Edi Hasaj for [#2](https://github.com/edihasaj/harness-gateway/pull/2).

## 0.4.9 — 2026-10-18

Connected clients now preserve live native and gateway chat status without
resuming chats or starting inference.
Thank you to Edi Hasaj for [#1](https://github.com/edihasaj/harness-gateway/pull/1).
