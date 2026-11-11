---
summary: 'Opt-in Claude Desktop model aliases, isolated account catalogs, setup, and tested limits.'
read_when:
  - Adding Claude Desktop as a gateway client.
  - Showing multiple GPT accounts or local models in Claude's model picker.
  - Installing or updating the Claude-only adapter without changing Codex.
---

# Claude Desktop

The gateway can now serve Claude Desktop itself, with no adapter process and
no second gateway: see [Claude Desktop, served directly](claude-desktop-direct.md).
Prefer that for a new setup. This page describes the adapter profile, which
stays supported, and the behavior both share.
Code sessions on another machine over SSH need a direct profile on a Tailscale
address: see [SSH environments](claude-desktop-direct.md#ssh-environments).

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

When the existing Codex gateway must remain unchanged, keep Claude's separate
gateway configuration, state directory and fixed loopback port. Configuration
isolation does not require a separate macOS startup job: its adapter, private
inference and SSH forwards belong to the existing signed app-owned service tree.
Never install another LaunchAgent for them or reuse Codex's provider settings.

An existing scoped registration on the same inference host can be referenced
through its existing absolute credential path. Do not create independent copies
of rotating refresh credentials. For several Macs, one inference host and
authenticated loopback SSH forwards avoid distributing provider credentials.
Only the gateway client token and non-secret model ownership metadata belong on
the other clients.

### Repairing a Claude sign-in failure

Check the adapter's configured `upstream` and the inference host's private
gateway configuration before reconnecting. A successful request to the shared
gateway does not verify Claude Desktop's separate backend. Likewise,
`claude auth status` over SSH can report no login when the macOS service can
read it; verify an inference request through the app's actual adapter.

Native Desktop model IDs use the configured primary provider, which older
deployments call `claude`. If that provider is intended to use a named Claude
account, give it the same explicit `authDirectory` as that account. Renewing
`claude-primary` cannot repair a legacy `claude` route that still reads the
default login store. Verify the existing account identities before correcting
the path, and preserve every model alias. The native review configuration's
`authDirectory` must also select the intended review account.

Reconnect on the inference host, using its private configuration and the
provider ID that owns the failing route:

```sh
gateway login PROVIDER --config /absolute/claude-gateway.json
```

The private inference process loads its configuration at startup. After a path
correction, restart its owned component only when idle, within the existing
app-owned service. Verify both a streamed Messages reply through the client's
adapter and a native client tool round trip. Changing the client's token or
recreating its profile does not renew the upstream subscription login.

Qwen remains the configured local or tailnet API provider. Use the existing
endpoint and credential; selecting it does not turn it into a Claude model.

## Prepare the desktop profile

The configuration library must already contain one selected profile named
`GateFox`. Its credential helper and unrelated settings are preserved
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
routes are derived from their public aliases, with real `labelOverride` values:
`claude-hg-route-<decimal hash>` for a route without reasoning levels, and
`claude-opus-5[hg-route-<decimal hash>]` for one with them, because the app only
shows its native effort slider for a model ID it recognizes. Both forms retain
the configured provider and account; neither adds a Claude family-tier field.
The second borrows the `claude-opus-5` ID shape for the control, which also makes
the CLI assume a 1M context window; see the compaction limitation below. The
label still names the real provider and model. Future accounts such as
`Claude 2` remain separate routes.

## Apply and run

Finish Claude work and quit its GUI before applying:

```sh
gateway claude-desktop configure --gateway-config /absolute/claude-gateway.json --apply
gateway claude-desktop status --config /absolute/Claude-3p/desktop-adapter/config.json
```

The configure step stages the two files, creates private backups, and restores
their exact previous bytes if replacement fails. It validates selected profile
identity and path confinement before writing. The old standalone `claude-desktop install`
command refuses to create another LaunchAgent. It does not unload an existing
adapter or modify any profile.

For an existing standalone deployment, preview and stage consolidation through
the main gateway configuration, not the Claude inference configuration:

```sh
gateway service claude-desktop --config /absolute/main-gateway.json
gateway service claude-desktop --on-restart --config /absolute/main-gateway.json
```

Staging leaves the live plan, jobs and listeners alone. The next primary service
start revalidates the saved ownership receipts and adopts the Claude components
only when every exact legacy registration is unloaded. A loaded adapter,
inference process, or tunnel remains pending even when its sockets look idle:
the pinned private runtime has no atomic drain. Changed or foreign jobs also
remain pending. The signed app's Node runs the existing
private runtime with its original arguments, working directory and configuration.
Inference isolation, account ownership, models, permissions and client endpoints
remain unchanged. Installation or staging is not proof of activation; check the
live service tree and both authenticated loopback endpoints afterward.

During an approved maintenance window, an operator may stage one explicit
interruption authorization:

```sh
gateway service claude-desktop --on-restart --force --config /absolute/main-gateway.json
```

`--force` is accepted only with this command. It is stored in that one pending
receipt, still rechecks the exact signed app, plist hashes, argv and process
identity, and can retire the owned loaded jobs despite active connections. The
cutover may interrupt Claude work. Restaging without `--force` creates a normal
safe receipt again; it is not a permanent service preference.

New component logs live under the main gateway state's `services/` directory
with private permissions. Existing launchd logs are retained unchanged rather
than reused or chmodded. Recovery journals and original registrations stay in
private `service-backups` storage.

For foreground diagnostics:

```sh
gateway claude-desktop serve --config /absolute/adapter-config.json
```

The adapter binds only `127.0.0.1`, authenticates every endpoint, preserves query
strings and tool content, and forwards status and streaming failures. It serves
the model catalog and individual model detail required by the native picker.
An optional private audit records only configured route identity and status,
never prompts, tool arguments, headers, or credentials.

## One row per model, native thinking controls

Recent clients can opt into [native model metadata](claude-desktop-native-metadata.md)
for their effort controls. The existing model-ID mapping remains the default.

An isolated, version-pinned [native-picker experiment](claude-native-trial.md)
is available for developer testing. It is not part of the normal adapter or a
deployment, and its native control transport still requires GUI verification.

Claude Desktop obtains its native effort controls from Anthropic's signed model
catalog. The profile lists exactly one picker row per model and never lists
effort or speed variants as separate rows. Recognized Claude IDs show the app's
native effort control; the profile writes an accurate `maxEffort` for them (the
model's highest supported effort, bounded by any cap already in the profile, so
a user's lower cap is kept).

A secondary route that advertises reasoning levels is exposed as
`claude-opus-5[hg-route-<decimal>]` so Claude Desktop shows its native slider for
it: the app recognizes the ID before the bracket, and the app rejects any ID that
names GPT or Qwen, so the suffix stays opaque. The row's `labelOverride` still
names the real provider and model, the row adds no Claude family-tier field, and
the slider is capped at the route's top supported effort. Only a cap already
recorded under that bridge name counts as a user choice; the automatic
`maxEffort: "high"` written on the old opaque row does not suppress the higher
levels the route newly advertises. The adapter clamps a level the route does not
support — to the highest supported level below it, or the lowest supported one —
in the request and in the system-message history a tool continuation carries, and
never adds an effort the client did not send or change `thinking` for these rows.
The ID a saved chat used, `claude-hg-route-<decimal>`, stays in the adapter
configuration as a hidden compatibility alias for the same route. A route with no
reasoning levels is unchanged: it keeps the opaque `claude-hg-route-<decimal>`
row, where the app offers no effort control.

These rows do not add Codex's Ultra agent orchestration to Claude Desktop, and
Ultracode is not offered on the slider because the unmodified app never adds that
stop to a third-party profile. Claude's CLI also treats a row with this ID shape
as a 1M-token context. For a smaller upstream window, the client's normal
proactive compaction threshold is too high. The gateway forwards a
`prompt is too long` error that Claude can use for reactive recovery (see
[context overflow](messages.md#context-overflow)); the ID mapping alone does not
prove that a long real conversation can compact successfully.

The adapter still accepts the deterministic explicit effort and speed aliases
that earlier profiles listed, so chats saved against them keep working. They are
backend-only: never written to the profile and never shown in the picker. Each
carries an explicit effort and, where the transport honors it, a service tier
(`default` for Standard). The generated count is bounded at 1000. Configuration
fails with the required count when a catalog would exceed it and never evicts an
alias, because a dropped alias would break a saved chat. Remove models or service
tiers to get back under the bound.

Re-run `claude-desktop configure` to prepare the updated profile, then apply it
after finishing Claude work and quitting its GUI. Existing base route IDs remain
available for saved chats. An explicit alias's effort is authoritative for that
alias, including tool continuations.
An explicit effort variant enables adaptive thinking when the app sends its
unknown-model disabled default. Existing adaptive display preferences are kept;
fixed token budgets remain unsupported.
Native auxiliary Auto reviews keep their original generation controls.
The visible profile rows must fit Claude Desktop's 200-entry limit. Hidden
aliases do not count. Configuration reports the required count and fails when
the models alone would exceed the limit; it never silently drops a model.

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
  "contextProviders": ["qwen"],
  "emptyCompletionRecoveryProviders": ["qwen"]
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

Claude Code through the ordinary gateway reaches the same runner; see
[auto mode](messages.md#auto-mode). This Desktop entry point stays separately
configured, its backend does not use that general path, and it belongs only to the isolated Claude inference component inside
the existing app-owned service. It does not share Codex's inference configuration
or register a Codex client.
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

## Empty completion recovery

The private inference configuration can opt selected Chat Completions providers
into `emptyCompletionRecoveryProviders`. The entire list must name configured
Chat Completions providers. The shared gateway factory and Responses ingress
retain their existing behavior.

For an opted-in Messages request, a clean upstream completion with no answer
text or tool fragments can trigger one additional request. Reasoning alone
does not count as an answer. Recovery requires the exact configured upstream
model, a normal stop, one completion marker, and clean stream closure within
five seconds. Whitespace counts as visible text. Refusals, filtering, unknown
semantic output, malformed streams, partial output, output limits, required or
named tools, and nonempty stop-sequence lists are not eligible.

The retry preserves the same provider, account, model, serialized request,
credentials, and generation controls. It has a separate 90-second deadline;
the first request retains its existing caller timeout. A second empty
completion returns an explicit incomplete-response error. This bounds recovery
per gateway inference; Claude can independently retry a failed inference.
The gateway never substitutes reasoning text for an answer.

The usage ledger retains spend from both attempts, including usage received
before failure or cancellation. The Messages reply reports the final successful
attempt's usage so repeated input is not mistaken for a doubled current context.
Recovery telemetry contains route identity, outcome, timing, and numeric usage,
without prompts or completion text.

## Preserving Qwen output without tools

The private service can also opt Qwen into
`noToolsOutputRecoveryProviders`, mapping its provider ID to an absolute
`tokenizer.json` path:

```json
{
  "contextProviders": ["qwen"],
  "emptyCompletionRecoveryProviders": ["qwen"],
  "noToolsOutputRecoveryProviders": {
    "qwen": "/absolute/Claude-3p/inference/tokenizers/qwen3.8-tokenizer.json"
  }
}
```

This addresses a vLLM no-tools parsing failure. Qwen can generate tool-shaped
text after reasoning even when the request offers no tools. The configured
upstream tool parser consumes that text, then removes the calls because tool
use is disabled, leaving an empty successful reply.

For eligible requests, the private proxy requests raw token IDs as diagnostic
metadata. It retains the same instructions, model, credentials, reasoning
effort, and sampling controls. If the upstream supplies no visible text, a
complete validated token sequence can recover the actual generated text after
reasoning. That text remains ordinary text, including any unsolicited XML;
it never becomes an executable tool call or an invented answer. Normal visible
replies and requests offering tools retain their existing handling.

Recovery requires the final assistant prompt boundary, complete output ending
in the configured EOS token, an unambiguous reasoning boundary, valid UTF-8,
matching provider token counts, a normal stop, and clean stream closure.
Invalid or incomplete evidence retains the existing empty-response retry and
explicit failure. Added token metadata is removed before the normal provider
and client see the response. Reasoning activity and usage continue streaming;
only the final stop waits for validation. Buffering and closure waits are
bounded.

The tokenizer is public data from
[`nvidia/Qwen3.8-Flash-Next-NVFP4`](https://huggingface.co/nvidia/Qwen3.8-Flash-Next-NVFP4/tree/fc694b54fb0174e0913e6adf86691ef85a4ead47),
revision `fc694b54fb0174e0913e6adf86691ef85a4ead47`. Its exact SHA-256 is
`0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3`.
The service validates the asset before allocating listeners. It is stored in
Claude's private configuration area and is not bundled with the gateway.
The model card identifies the NVIDIA Open Model License and Qwen Community
License 1.0 as governing terms. No tokenizer runtime dependency or model weights
are added.

This policy preserves generated output; it does not guarantee that Qwen follows
every instruction. It changes neither the shared Qwen workers nor the native
Codex configuration or routing.

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
- Routes without reasoning levels keep opaque aliases and Claude's generic
  200K context estimate. Mapped reasoning routes expose the native effort
  control but inherit a 1M client estimate. Neither estimate establishes the
  provider's true limit; see the compaction limitation above.
- Native Claude mobile Remote Control excludes custom gateways and proxies.
  Desktop aliases do not remove that restriction.
- Provider capabilities still apply. A text-only Qwen route does not accept
  images, and switching providers replays the conversation.
- Short connectivity proofs do not qualify long-session compaction or every
  possible MCP JSON schema.

## October 26 model mapping verification

Claude Desktop 3.6556.2 on the MacBook displayed its own Effort submenu on a
mapped `Codex · GPT-6.1-Sol` row: Low, Medium, High, Extra, and Max. This build
uses a submenu rather than the slider seen in the older trial. The
[cropped capture](evidence/claude-model-mapping-2026-10-26/native-effort.png)
shows that native control and the truthful GPT label together. The deployment
preserved the existing 25 visible rows; 21 received mapped reasoning controls.
The adapter kept its old IDs for saved chats. This deployment updated the
profile and the private adapter under the existing gateway service.

A separate native CLI 2.1.299 process used a private home, a local synthetic
backend, and the exact deployed adapter code. Its bracketed model ID survived
the CLI and mapped to the expected backend ID; the completed turn carried
`xhigh`. Explicit native control requests also reported applied Ultracode
active and available. The [sanitized CLI receipt](evidence/claude-model-mapping-2026-10-26/cli-verification.json)
records those flags and the backend effort, without prompts or credentials.
That protocol check does not add an Ultracode item to the Desktop menu or
verify real-provider workflow fan-out.

Claude.app retained the same archive SHA-256 and passed strict deep signature
verification after installation. No app patch or re-signing was performed.
The MacBook's gateway rollout and direct-tool canary reported `ready`; health
reported `ok`. A real provider turn selected through the GUI and long-session
compaction remain unverified.

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
