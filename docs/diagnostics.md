---
summary: 'Local telemetry, gateway diagnostics, and scrubbed exception reports to GlitchTip.'
read_when:
  - Investigating stopped turns, failures, restarts or cache behavior
  - Changing what the gateway logs or reports
---

# Diagnostics

The gateway keeps a private event log on every Mac and sends only exceptions to
the private GlitchTip project. Neither runs on a request path.

Choose [provider failures](diagnostics-guide-provider-failures.md), [runtime events](diagnostics-guide-runtime-events.md), or [usage and loaded releases](diagnostics-guide-usage-and-versions.md). No diagnostic page authorizes replaying user work or changing an account.

## Claude output between requests

Read [claude output between requests](diagnostics-guide-provider-failures.md#claude-output-between-requests).

## Responses tool identity failures

Read [responses tool identity failures](diagnostics-guide-provider-failures.md#responses-tool-identity-failures).

When a model answers with a declared tool's alias or a differently cased wire name
instead of the exact wire name, the call is restored and the gateway keeps an
in-process count under one of the fixed labels `alias`, `namespaced_alias`,
`functions_prefix` or `wire_case` (`toolIdentityFallbackCounts()` in
`src/providers/tool-identity.ts`). The counts hold no tool names, namespaces or
arguments, and reset when the service restarts. A name that selects more than one tool
by any of these spellings (an alias of one tool that is also a case variant of another
tool's wire name) is refused. To keep memory bounded, a call is counted once per request
only while its id is at most 1,024 characters and fewer than 1,024 calls have been
counted; later calls still run but are not counted.

## Chat Completions malformed tool calls

Read [chat completions malformed tool calls](diagnostics-guide-provider-failures.md#chat-completions-malformed-tool-calls).

## Cache and failure screen

Read [cache and failure screen](diagnostics-guide-provider-failures.md#cache-and-failure-screen).

## Local telemetry

Read [local telemetry](diagnostics-guide-runtime-events.md#local-telemetry).

## Executor outcomes without a window

Read [executor outcomes without a window](diagnostics-guide-runtime-events.md#executor-outcomes-without-a-window).

## Subagent startup checks

Read [subagent startup checks](diagnostics-guide-runtime-events.md#subagent-startup-checks).

## Gateway-rule refusals and dropped control items

Read [gateway-rule refusals and dropped control items](diagnostics-guide-provider-failures.md#gateway-rule-refusals-and-dropped-control-items).

## When the relay is set aside

Read [when the relay is set aside](diagnostics-guide-runtime-events.md#when-the-relay-is-set-aside).

## Service self-heal

Read [service self-heal](diagnostics-guide-runtime-events.md#service-self-heal).

## Provider connection diagnostics

Read [provider connection diagnostics](diagnostics-guide-provider-failures.md#provider-connection-diagnostics).

## Claude credential failures

Read [claude credential failures](diagnostics-guide-provider-failures.md#claude-credential-failures).

## Claude request rejections

Read [claude request rejections](diagnostics-guide-provider-failures.md#claude-request-rejections).

## Grok CLI records

Read [grok cli records](diagnostics-guide-provider-failures.md#grok-cli-records).

## Native relay records

Read [native relay records](diagnostics-guide-runtime-events.md#native-relay-records).

## Usage ledger

Read [usage ledger](diagnostics-guide-usage-and-versions.md#usage-ledger).

## Running component releases

Read [running component releases](diagnostics-guide-usage-and-versions.md#running-component-releases).

## Exception reports

Read [exception reports](diagnostics-guide-usage-and-versions.md#exception-reports).
