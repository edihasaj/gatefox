---
summary: 'Verified subscription operations and remaining desktop checks.'
read_when:
  - Testing subscriptions or remote clients
  - Assessing desktop readiness
---

# Verification

Run the development gate:

```sh
npm run build && npm run check && npm test
```

Tests cover authentication, account isolation, Responses parsing and replay,
stream termination, cancellation, live route guards, private model preferences,
public catalog validation, approval correlation, and executor lifecycle.
Catalog-generation tests use a controlled app-server fixture. They do not prove
the rendered desktop picker or provider entitlement.

The idle-restart regression covers active inference, partial request uploads,
and catalog reads that have not created an inference controller. The real
LaunchAgent check passed on MacBook Pro 2: both busy restarts were refused,
the idle restart changed its PID, and recovery completed with the same token
and exactly two upstream calls.
On an unused macOS test host, run the real LaunchAgent lifecycle check:

```sh
node scripts/e2e-service.mjs --install-test-service
```

It refuses an existing gateway service or plist. It installs a temporary service,
checks both busy restart refusals, restarts while idle, then verifies inference,
the unchanged client token, and two upstream calls. The upstream is a local
Responses fixture; this check does not prove provider authentication. Cleanup
uninstalls the service. Only the temporary plist receives a dummy fixture key;
no provider credentials or global launchd environment values are changed.

## Real subscription checks

MacBook Pro 2 passed a real Claude Sonnet 5.5 and Codex 2 GPT-6.1-Sol loop over an
authenticated SSH forward. It streamed text and reasoning, read a random file
proof, applied a dedicated patch, retained follow-up history, switched providers,
acknowledged cancellation, released its worker, and completed a recovery turn.
Only the gateway client token crossed SSH. Provider credentials stayed on the
inference host.

Copilot CLI 1.0.95 passed the real bundled Codex loop on MacBook Pro 2 through
SDK protocol 3: incremental text, file proof, custom patch and verification,
follow-up replay, provider-exposed reasoning, interruption, worker cleanup, and
recovery. Interruption was acknowledged in 3 ms. Discovery returned 13 explicitly
selectable models after removing Auto. This proves one model's full loop, not
every discovered model's inference access. Copilot's 13 routes are now loaded in
the deployed host catalog. Rendered Copilot selection remains unverified.

A real text sweep passed all 20 loaded Claude/Codex 2 routes. It found and verified
a fix for the unsupported upstream `summary: "none"` value. Copilot passed 12 of
13 selectable routes. Its Opus 5 request returned Opus 4.8, so the gateway rejected
the substitution. That route is not verified as usable. The Copilot Sol 6.1
catalog also advertised `none`, which its endpoint rejected; discovery now omits
that unsupported effort. These sweeps do not prove images or every model's tool
loop. Run `node scripts/e2e-models.mjs --config PATH --output PATH` to repeat them.

All 20 Claude/Codex 2 routes passed a real PNG check whose random eight-digit code
appeared only in pixels. Sonnet 5.5 and Codex 2 Sol also passed JPEG, WebP, and GIF
checks with follow-ups and image tool-result replay. Copilot Sonnet 5.5 and Luna
passed PNG input, follow-up, and tool-result checks.

The bundled Codex engine on MacBook Pro 2 passed four operations for each of the
20 Claude/Codex 2 models: local image attachment, turn interruption, saved-chat
resume after restarting the engine, and real `view_image` execution. Each model
read the correct picture code. This verifies the engine and transport, not the
rendered attachment UI. Codex's tested pause behavior interrupts a turn and starts
a new turn from saved history; it does not suspend and continue the same token stream.

`scripts/e2e-images.mjs` runs direct image checks. Its fixture directory contains
`fixture.png` and any selected `fixture.jpg`, `fixture.gif`, or `fixture.webp`, plus
`expected.json` with `code`, `colors`, and `shapes`. `scripts/e2e-agent-images.mjs`
runs attachment, stop/resume, and viewer checks through the real bundled engine.
`scripts/e2e-all-tools.mjs` repeats the file-read/edit, follow-up, reasoning,
cancellation, and recovery loop for every configured alias. Models without a
reasoning capability report that case unsupported rather than inventing reasoning.

The complete file/tool sweep passed all 20 Claude/Codex 2 aliases: streamed text,
random file proof, native patch and verification, follow-up replay, supported
reasoning, interruption, worker cleanup, and recovery. Daybreak added a final
period to the recovery marker; the checker now accepts terminal punctuation and
its full loop passed again. Copilot CLI 1.0.91 repeated its entire model catalog.
Discovery removes identical repetitions and rejects conflicting metadata for the
same ID. The account is not switched and its CLI is not updated automatically.
That CLI also omits the optional assistant `providerId`. The adapter accepts its
response only after subscription usage reports `isByok: false` and the returned
model matches the request. Explicit provider changes and BYOK still fail closed.

Earlier bundled-engine checks on the inference host verified the primary account
and the combined 28-model catalog. A separate Haiku 4.5 request verified its
no-reasoning route. Listing a model does not prove inference access or inclusion
without usage credits. Native inference has not been tested for every native
account model.

## Desktop and configuration limits

The deployed daemon exposes 33 extra routes, all with image metadata. Live checks
through the permanent SSH forward passed attachment reading, interruption,
saved-image history after engine restart, and native `view_image` for Claude,
Codex 2, and Copilot Luna. The main native configuration digest and client token
were unchanged during activation. Temporary verification listeners and their
extra SSH forward were stopped afterward.

The ordinary Anthropic API adapter has a real local HTTP/SSE wire test for
credential selection, effort, hidden summaries, custom calls, image tool replay,
stop reasons, invalid/duplicate tools, truncated streams, disconnect, and recovery.
This fixture proves the gateway contract, not access to a paid Anthropic account.

The signed desktop app is installed on MacBook Pro 2 and onboarding is complete.
The separate-executor version passed the full bundled-engine Claude/Codex 2 loop
there, including the unchanged isolated native-config check. Native inference was
explicitly omitted because that test home has no native subscription login.

The direct launcher has been verified on the test Mac. Process inspection
confirmed the override environment and wrapper children. The rendered desktop
then completed real Claude Opus 5.5 and Codex 2 GPT-6-Luna conversations and a
provider switch. The working Mac's app has not been relaunched.

On 11 October 2026, the updated adapter launched on MacBook Pro 2. The rendered
Claude Opus 5.5 chat accepted a PNG attachment and correctly described its red
circle, green square, and blue triangle. The picture code was also supplied as
text, so this desktop check does not prove image-only code reading. The separate
bundled-engine tests above provide that proof. The desktop label still showed
Extra High; visible Max and Ultra selections remain unverified.

That investigation reproduced a separate preference bug: two adapter connections
cached their own defaults, so one could return High after the other saved Max.
The fix rereads preferences and locks updates across processes. Regression checks
cover stale reads, new-chat effort, concurrent edits from separate processes,
abandoned locks, and cleanup after a failed update. The rendered reasoning picker
still needs to be checked after activating this fix.

A separate staging daemon passed a live catalog addition while an older gateway
chat ran a command. The new chat used the new context-window metadata. The
original native and gateway executor PIDs remained alive. Cancellation completed
in 109 ms. Shared thread discovery, saved-history resume, and public Codex reasoning
also passed. The test alias pointed to an existing Sonnet model, not a newly
entitled model. It was removed after verification.

Instruction-only checks proved that global and repository AGENTS.md rules reached
Claude Sonnet 5.5 at `max` and Codex 2 GPT-6.1-Sol at `ultra`. Each rule contained
a random value absent from the user prompt; each response returned it without
calling a tool. Changed global and repository rules reached subsequent Claude
chats through the same connection. The isolated native config remained unchanged.

The gateway advertises the provider's reasoning levels. Desktop display has a
separate filter under Model features, Available reasoning efforts. Max is omitted
from the installed default list; Ultra display also depends on the app's feature
availability. The API tests prove the requested effort values reached successful
turns, not that every level is visible in the rendered picker.

The installed desktop model query has a five-minute cache and refetches on focus.
The adapter cannot promise immediate visible updates. Its initial launch hook is
an implementation detail, not an established public desktop extension API.

Native Codex may add project-trust settings when executing tools in a new Git
workspace. Use an isolated native home on the test Mac. If a native-home check is
necessary elsewhere, use an already-trusted workspace and `--workspace PATH`.
Do not create new test Git projects in the working machine's native configuration.

## Installer and local Qwen

The v0.2.0 preflight installer passed repeat installation, a prefix containing
spaces and quotes, checksum verification, and protection of an unrelated command.
The bundled runtime has no Homebrew library dependencies. The installed command
on MacBook Pro 2 registered the added provider at runtime while preserving the
native provider default.

Claude Sonnet 5.5, Codex 2 Sol, and local Qwen 3.8 Flash Next passed native agent
title reads, renames, live name notifications, and saved-chat resume after a new
adapter connection. The isolated native configuration digest was unchanged.
This proves the native engine and adapter, not newly rendered sidebar labels.

Qwen runs on the existing DGX Spark vLLM server. Its managed SSH tunnel uses the
existing NVIDIA Sync identity without copying the private key. The real Codex
loop passed incremental text, random file proof, custom patch and verification,
follow-up history, reasoning, interruption (4 ms acknowledgement), worker cleanup,
and recovery. The model uses a 500,000-token server context and currently advertises
text input only. Native API inference on the isolated test home's primary account
was explicitly skipped because that home has no primary login.

The live checks found two translation/startup bugs. Qwen requires system
instructions at the beginning, so the chat adapter combines system/developer
instructions there while retaining user/tool history order. Credential-free
clients could read a saved gateway chat before discovery and create an empty
executor. Saved metadata now reads through the native shared store; inference
requires an available catalog. Both cases have regressions.

The initial v0.2.0 host migration exposed a launchd KeepAlive race and safely
refused the upgrade. v0.2.1 disables only the managed job's next launch while its
existing process exits through the idle guard, then replaces the plist and
reenables the job. Failure restores the earlier plist. The real MacBook Pro 2
check passed active-inference and partial-upload protection, idle restart, idle
upgrade with the new config, recovery, and the unchanged client token. It made
exactly three calls to the local upstream fixture and removed its temporary service.
