# Changelog

## Unreleased

Harness Gateway now has a native macOS app with the fox icon, a setup wizard,
connection and model management, and a signed background launcher. The app keeps
the existing gateway running when its window closes and preserves its settings.
The signed runtime keeps the app identity stable across installed CLI updates.

Thank you to Edi Hasaj for the native macOS app.

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
