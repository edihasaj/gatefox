# Changelog

## Unreleased

Gateway generation cleanup runs in the background after release or disconnect
and periodically, so an older engine that stops answering cannot block a new
catalog. Loaded chats and live client leases preserve their writers. The
watchdog also fails a service that remains on any older release for more than
one hour after installation, including patch updates.

Claude billing and extra-usage credit refusals now explain how to check billing
settings and payment methods. These failures stop automatic stream retries and
keep private provider diagnostics out of responses and telemetry.
Thanks to @edihasaj for reporting the unclear billing error.

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
