---
summary: 'Opt-in Claude Desktop model aliases, isolated account catalogs, setup, and tested limits.'
read_when:
  - Adding Claude Desktop as a gateway client.
  - Showing multiple GPT accounts or local models in Claude's model picker.
  - Installing or updating the Claude-only adapter without changing Codex.
---

# Claude Desktop

Claude Desktop rejects model IDs that name GPT or Qwen. The optional Claude
adapter exposes stable opaque route IDs while retaining the actual provider and
model in the picker label. Native Claude IDs still select the primary Claude
account. A model is never redirected to another account after a failure.

```text
Claude Desktop: truthful model labels
    → Claude-only loopback adapter
    → gateway Messages endpoint
        ├── Claude: primary subscription
        ├── Codex: first registered GPT account
        ├── Codex 2: second registered GPT account
        └── Local: configured Qwen server
```

This is an opt-in third-party inference profile. It does not add models to the
first-party Claude subscription connection or modify the signed Claude app.
The app keeps its third-party history under `Claude-3p`.

## Account ownership and isolation

Give every GPT account its own gateway provider ID, model aliases, and scoped
Sign in with ChatGPT registration. Register the intended email with
`gateway login PROVIDER --account-email EMAIL --config PATH`. Native Codex
authentication is not a gateway credential source. Copying a native login does
not grant the gateway's required scopes.

When the existing Codex gateway must remain unchanged, create a separate
gateway configuration, state directory, fixed loopback port, and service label
for Claude. The existing provider modules can serve this instance. Run it with
`gateway serve --config PATH` under its own service. Do not use
`gateway service install` for a second instance: that command owns the shared
gateway service label.

An existing scoped registration on the same inference host can be referenced
through its existing absolute credential path. Do not create independent copies
of rotating refresh credentials. For several Macs, one inference host and
authenticated loopback SSH forwards avoid distributing provider credentials.
Only the gateway client token and non-secret model ownership metadata belong on
the other clients.

Qwen remains the configured local or tailnet API provider. Use the existing
endpoint and credential; selecting it does not turn it into a Claude model.

## Prepare the desktop profile

The configuration library must already contain one selected profile named
`Harness Gateway`. Its credential helper and unrelated settings are preserved
unless the configure command explicitly supplies the selected gateway helper.

```sh
gateway claude-desktop configure --gateway-config /absolute/claude-gateway.json
```

By default, this prepares candidate files under
`~/Library/Application Support/Claude-3p/alias-trial/candidate/`. Review the
profile and adapter configuration before applying. The source configuration is
read-only; it may contain the gateway's provider configuration or only its model
ownership metadata. Its authenticated live model catalog must agree with that
metadata.

The default adapter port is 3467, the primary Claude provider ID is `claude`,
and the default model is `claude-fable-5-1`. The command's help describes the
overrides for other installations. It refuses collisions, missing primary
routes, invalid catalogs, and an upstream endpoint that loops back to itself.

Native IDs map explicitly to the primary provider's public aliases. Secondary
routes use `claude-hg-route-<decimal hash>` identifiers derived from their public
aliases, with real `labelOverride` values. Secondary routes never claim a Claude
family or an unverified 1M context capability. Future accounts such as
`Claude 2` remain separate routes.

## Apply and run

Finish Claude work and quit its GUI before applying:

```sh
gateway claude-desktop configure --gateway-config /absolute/claude-gateway.json --apply
gateway claude-desktop install --config /absolute/Claude-3p/desktop-adapter/config.json
gateway claude-desktop status --config /absolute/Claude-3p/desktop-adapter/config.json
```

The configure step stages the two files, creates private backups, and restores
their exact previous bytes if replacement fails. It validates selected profile
identity and path confinement before writing. The macOS installer owns only the
Claude adapter's LaunchAgent and refuses an already loaded service or occupied
port. It does not stop the shared gateway or register a Codex client.

For foreground diagnostics:

```sh
gateway claude-desktop serve --config /absolute/adapter-config.json
```

The adapter binds only `127.0.0.1`, authenticates every endpoint, preserves query
strings and tool content, and forwards status and streaming failures. It serves
the model catalog and individual model detail required by the native picker.
An optional private audit records only configured route identity and status,
never prompts, tool arguments, headers, or credentials.

## Tools and subagents

The Claude harness executes tools and manages agents. The gateway continues to
serve inference only. The adapter does not generate roles, choose worker models,
change permissions, or silently substitute a model.

The Responses-backed GPT route can require optional tool properties to have a
value. For opted-in `codex-subscription` and `responses-api` routes, the adapter
represents optional non-nullable plain properties as nullable on the wire and
removes only those introduced nulls from returned tool arguments. Required
values, existing nullability, and explicit non-null choices are preserved.
Reference and composition subtrees remain unchanged. This conversion is scoped
to the Claude client and does not alter the existing Codex request path.

## Native Auto review

Auto mode uses a second model to review proposed actions before the client
executes them. The initial trial's review failed before inference: its disabled
thinking and stop-sequence controls were unsupported by the subscription
Messages translation. That failure was not a safety verdict.

An opt-in private inference entry point can serve native auxiliary reviews
through a restricted, one-turn Claude CLI process:

```sh
gateway claude-desktop inference \
  --gateway-config /absolute/claude-gateway.json \
  --native-config /absolute/claude-native.json
```

Example native configuration:

```json
{
  "command": "/absolute/path/to/claude",
  "models": {
    "claude/claude-sonnet-5": "claude-sonnet-5"
  },
  "timeoutMs": 60000,
  "maxConcurrent": 2,
  "maxRequestBytes": 262144,
  "contextProviders": ["qwen"]
}
```

Every native alias must belong to the same `claude-subscription` provider and
native model in the gateway configuration. An optional `authDirectory` must
match that provider. Use the existing signed-in CLI executable; `--bare` cannot
use its OAuth or keychain login.

The listener keeps the private gateway's configured loopback port and serves
ordinary requests through the original gateway on an ephemeral loopback port.
Only explicitly configured, tool-free, nonstreaming Claude requests matching
the observed native classifier control profiles use this transport. The native
client normally omits request-class hints behind a custom endpoint; an absent
hint is accepted, while an explicit conflicting hint stays on the ordinary
backend. Original system, messages, and generation controls are preserved, and
the native classifier protocol metadata is supplied to the Claude endpoint.
No tool executes inside this process, and no permission verdict is invented.
A response is returned only
after a consistent completed native stream and successful terminal result.
Refusals, truncation, cancellation, unsupported requests, and native failures
remain failures.

The native request and child environment are bounded. Current Auto review
requests can exceed 140 KiB even for a short task. The macOS bound accommodates
these requests; a platform's smaller environment limit can still refuse one
before spawning. The adapter never truncates a review transcript to make it fit.

This entry point belongs only to the separate Claude inference service. It
does not install or restart the shared gateway or register a Codex client.
Client cancellation also remains effective while asynchronous classifier
selection is pending: a closed request cannot start fresh backend work when
selection finishes. Ordinary streaming cancellation closes the owned upstream
connection and releases the private request counters.

## Context recovery for compatibility models

An unknown model ID makes Claude assume a 200K context window. This assumption
can trigger early compaction as well as affect the meter. The current Desktop
profile supports a 1M capability flag, not arbitrary numeric windows for each
model. Advertising 1M for a smaller model is not a correction.

Claude Code documents `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`
for unknown aliases. Scoped to a Claude Desktop environment, it permits the
provider to report its actual overflow and retains reactive and manual
compaction. It does not correct the meter or provide an exact proactive
threshold for every model. Do not set `DISABLE_COMPACT` as a substitute.
The deployed backup clients retain conservative 200K enforcement; this override
has not been enabled in their live Desktop environments.

The optional `contextProviders` list wraps only named Chat Completions providers
inside this private service. It preserves the original endpoint, credential,
and tailnet checks. A bounded, structured vLLM input-overflow error becomes the
canonical context-overflow code before the unchanged provider adapter reads it.
An excessive output-token request and unrelated HTTP 400 errors remain their
original failures.

## Verified coverage and limits

The initial macOS trial verified the rendered picker, real GPT and Qwen replies,
switching models in one chat, exact file reads/writes, mixed-model native
subagents, skills, MCP, background agents, resume, and GPT image input. Model
identity was checked in child transcripts and route records rather than relying
on the assistant's claim.

The October 19 private rollout passed real Auto-mode tasks through all three
Macs' installed Desktop engines. Each GPT parent delegated a Qwen file reader
and a second-account GPT writer, with exact output and four successful native
Sonnet reviews. One earlier Qwen attempt skipped its assigned read and failed
the validator; the successful retry does not qualify model reliability for
every task. These checks used the native engine.

A separate rendered Desktop task on macbook-server also passed in Auto mode:
the default Fable parent delegated only to the assigned Qwen reader and
second-account GPT writer. Retained child transcripts confirm their models,
tools, and file paths, and the output matches the source byte for byte.
No session permission override was added. This GUI task used the native-review
runtime before the subsequent cancellation-only fix; the fixed package passed
its own complete native cancellation chain and a live Fable request.

- Keep **Manual** permissions on another installation until its native review
  transport passes a real Auto-mode task. Manual remains a fallback, and the
  deployed GUI's saved permission choice remains unchanged.
- Opaque aliases use Claude's generic 200K client context estimate and do not
  expose the native effort picker. The estimate is not the provider's true limit.
- Native Claude mobile Remote Control excludes custom gateways and proxies.
  Desktop aliases do not remove that restriction.
- Provider capabilities still apply. A text-only Qwen route does not accept
  images, and switching providers replays the conversation.
- Short connectivity proofs do not qualify long-session compaction or every
  possible MCP JSON schema.

Offline native-engine fixtures exercise overflow, reactive compaction, and a
smaller retry through the actual GPT and Qwen provider adapters. A live Qwen
overflow also produces the recognized context error through the private
frontend. These checks do not establish a larger Desktop context meter or
qualify long-running live compaction.

A bounded live Qwen manual-compaction task also passed: the native engine emitted
a real compact boundary and retained a seeded fact before and after a separate
resume process. The manual phase took about 63 seconds. Its initial seed replies
contained no assistant text and were not treated as substantive completions.
This qualifies that bounded manual workflow, not automatic compaction at a large
live context window.

Separate live checks on both registered GPT accounts processed about 193K
provider input tokens with conservative 200K client enforcement. The native
engine compacted automatically and retained a seeded fact after compaction and
after a separate resume process. The later prompts did not reinsert the fact.
These bounded synthetic-text checks do not qualify multi-hour workloads.

A fresh Qwen automatic-compaction check stopped before its large-input phase:
two HTTP 200/end-turn responses contained no assistant content, followed by an
empty native success result. Retain that failed sample; it establishes a blank
reply, not an automatic-compaction failure. An unchanged repeat then passed at
193,210 provider input tokens, including native automatic compaction and fact
recall before and after restart, after trimming surrounding whitespace. The repeat does not qualify
first-attempt reliability. An isolated content-path probe also confirmed that
all visible upstream answer text reached the native client unchanged; its
strict comparison failed only because the correct marker had surrounding whitespace.

An isolated native-engine cancellation proof uses the deployed adapter,
inference frontend, gateway, provider, and context proxy with a controlled HTTP
upstream. Interrupting before headers and after a content delta closes the
upstream socket before fixture cleanup, returns all owned components to idle,
and permits a subsequent native request. This does not inspect remote providers'
internal generation jobs.

Run `npm run build`, `npm run check`, and `npm test`. The adapter's loopback
fixtures also run separately with `npm run test:claude-desktop`. Packaging
includes all three Claude runtime modules; no Python runtime is required.
