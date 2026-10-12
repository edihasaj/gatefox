---
summary: 'Verified subscription operations and remaining desktop checks.'
read_when:
  - Testing subscriptions or remote clients
  - Assessing desktop readiness
---

# Verification

The installed v0.2.8 adapter has passed backend settings and subscription checks.
MacBook Pro 2's original Control other devices connection is active through its
native relay. Full desktop parity through that connection remains unverified.
SSH, Unix proxy, and local engine results do not prove the cloud connection.

## Current release evidence

The audited catalog contains 36 models: 11 native models and 25 added routes.
The added routes comprise 12 Claude models, eight Codex 2 models, four Copilot
models, and one local Qwen model. Qwen advertises text input only. Discovery and
catalog presence do not establish inference access for every model.
The four Copilot routes are GPT-6.1-Sol, GPT-5.6-Terra, Sonnet 5, and Opus 5.5.

MacBook Pro 2 runs the installed v0.2.8 native relay under one supervised gateway
service. It retains the machine's original environment and installation IDs.
Studio and the primary Mac still need native relay activation and checks through
their original connections. Do not remove a working SSH connection before its
native replacement passes those checks.

The primary Mac's native `config.toml` still matches the digest recorded before
activation. Gateway preferences are stored separately. Native Codex and user
actions can change settings on the other Macs, including project trust; their
current files do not establish byte-for-byte identity with earlier snapshots.
The isolated backend tests below check that the adapter leaves their native
configuration unchanged during each run.

The remaining desktop checks are:

| Check | Evidence | Gap |
| --- | --- | --- |
| Model selection and refresh | The native connection returns the combined catalog. Backend config and catalog defaults agree. | Confirm Refresh preserves the selected gateway model and effort in the primary Mac's UI. |
| Claude files and images | User-driven Claude checks wrote the release-check seed and `CLAUDE_NATIVE_OK` on MacBook Pro 2 and read a code supplied only in an attached image. | Repeat follow-up and saved-chat recovery through the original connection. |
| Codex 2 follow-up | Backend and Unix proxy checks passed file edits and retained image history. | The native release-check proof has no Codex 2 completion marker. |
| Stop and recovery | Backend checks passed interruption and recovery. The native relay logged interruption requests. | Establish which provider handled each interrupted cloud turn and verify its recovery. |
| Qwen | The real backend tool loop passed and the model appears in the combined catalog. | Verify text, file tools, follow-up, and interruption through the original connection. |
| Reasoning controls | v0.2.8 persists all six display efforts. MacBook Pro 2's local rendered Claude menu showed Max. The user also confirmed that all levels now appear on the primary Mac. | Capture the primary Mac's menu and verify refresh persistence when using the connected computer. |

Shared execution ownership is being developed for v0.2.9. The signed SDK checks
below prove gateway ownership across several adapter clients in an isolated
development fixture. v0.2.9 has not been released or deployed. Native executors
still have separate ownership in each adapter, and the installed release's cloud
connections have not passed the corresponding checks.

## Development and desktop settings checks

Run the development gate:

```sh
npm run build && npm run check && npm test
```

The current v0.2.9 development gate passed 160 tests. The installed v0.2.8 release's
earlier gate passed 109 tests. Neither count proves the remaining desktop checks.

### Shared gateway execution in v0.2.9 development

The real signed Codex SDK, `0.162.0-alpha.17.2`, passed the shared gateway
execution checks in `scripts/e2e-shared-execution.mjs`. Two adapters reached the
same loaded chat in one engine process. A replacement adapter resumed that chat
after the first disconnected. A third connected adapter also reached the original
owner after the catalog changed. The loaded engine's PID stayed unchanged.
Separate unit tests verified that different native settings key orders reuse
the same generation rather than create another writer.
The mode without inference verifies metadata and live ownership, but does not
claim saved-chat resume. The SDK writes durable history after a real first turn;
the inference mode supplied that turn before its resume checks.

The fixture filled its four-generation limit and refused a fifth generation
without replacing the original loaded owner. After a chat unsubscribed, the
gateway waited for the SDK to unload it naturally. The SDK retained it for about
60 seconds. Only then did the gateway retire that unused generation and accept
its replacement. This check did not force an unload or rewrite saved history.

Claude Sonnet 5.5 and Codex 2 GPT-6.1-Sol passed real inference through these shared
clients. Repository `AGENTS.md` supplied a hidden marker absent from the user
prompt; each provider read a seed file and wrote the required proof. A fresh
adapter resumed the chat and edited the proof while retaining its contents.
One adapter then interrupted a stream started by another, and a recovery turn
completed with the proof intact. Both providers read a code supplied only in an
image and recalled that code after another adapter reconnect.

Qwen's first file/tool check in the combined run failed because its existing
managed SSH tunnel had been unloaded. Restoring that LaunchAgent restored the
transport. A focused Qwen run then passed hidden `AGENTS.md` instructions, file
reads and edits, history across adapter reconnects, cross-adapter interruption,
and recovery. Its final checks confirmed unchanged isolated native configuration
and no copied native authentication, with 11 inference calls. The investigation
recorded transport status and check results, without inference bodies.
The earlier combined run ended before its final invariants; the focused Qwen
result supplies that evidence for its own run.

The macOS sandbox check in `scripts/e2e-execution-sandbox.mjs` passed against the
signed SDK. The control socket was reachable outside the sandbox. Inside it,
both the socket alias and its physical path were denied, even with an explicit
Unix socket grant for `/`. This check sent no inference requests.

These results cover the gateway's shared engine and private Unix control socket.
They do not prove shared native executor ownership or the built-in cloud
transport. The primary Mac's reasoning display is user-confirmed, without a
matching menu capture. The original connected-machine checks in the table above
remain pending.

### Installed v0.2.8 desktop settings

The installed v0.2.8 preflight passed the real signed Codex app-server's desktop
settings protocol on MacBook Pro 2. Six display efforts, including Max and Ultra,
were saved before choosing any model. They survived a fresh adapter connection.
Concurrent theme and font edits merged, and a batch mixing a display change with
native sandbox configuration was rejected without partial writes. Native desktop
defaults and the isolated native configuration digest stayed unchanged. These
checks prove persistence through the backend. The rendered Claude picker on
MacBook Pro 2 later showed Max; the corresponding client-side refresh check
remains separate.

Run `scripts/e2e-desktop-settings.mjs` against an installed command with a fresh
client-only fixture, isolated native home, workspace, and gateway state. The
fixture must contain public native model metadata and an unrelated native desktop
setting. The script refuses copied account authentication and existing private
preferences, and sends no inference requests.

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
recovery. Interruption was acknowledged in 3 ms. Earlier discovery returned 13
explicitly selectable models after removing Auto. The current catalog exposes
only the four requested Copilot models. This test proves one model's full loop,
not every discovered model's inference access. Rendered Copilot selection remains
unverified.

A real text sweep passed all 20 loaded Claude/Codex 2 routes. It found and verified
a fix for the unsupported upstream `summary: "none"` value. Copilot passed 12 of
13 routes in that earlier catalog. Its Opus 5 request returned Opus 4.8, so the
gateway rejected the substitution. That route is not verified as usable. The Copilot Sol 6.1
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
and the then-current 28-model catalog. A separate Haiku 4.5 request verified its
no-reasoning route. Listing a model does not prove inference access or inclusion
without usage credits. Native inference has not been tested for every native
account model.

## Desktop and configuration limits

Live checks through the permanent SSH forward passed attachment reading,
interruption, saved-image history after engine restart, and native `view_image` for Claude,
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
provider switch. The primary Mac has since relaunched with the installed v0.2.8
desktop adapter. Its rendered refresh behavior still needs verification.

On 11 October 2026, the updated adapter launched on MacBook Pro 2. The rendered
Claude Opus 5.5 chat accepted a PNG attachment and correctly described its red
circle, green square, and blue triangle. The picture code was also supplied as
text, so this desktop check does not prove image-only code reading. The separate
bundled-engine tests above provide that proof. At that point, the desktop label
still showed Extra High. The later v0.2.8 local picker check showed Max; it does
not prove effort persistence in a remote chat on the primary Mac.

That investigation reproduced a separate preference bug: two adapter connections
cached their own defaults, so one could return High after the other saved Max.
The fix rereads preferences and locks updates across processes. Regression checks
cover stale reads, new-chat effort, concurrent edits from separate processes,
abandoned locks, and cleanup after a failed update. v0.2.8 also fixes display-only
settings that were lost before a model preference existed. The current release
evidence above separates these backend checks from the remaining rendered checks.

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

The installed v0.2.7 adapter also passed ordinary first turns and follow-ups with
Claude Sonnet 5.5 and Codex 2 Sol without calling the title helper. Titles set
through the app-server naming API stayed unchanged until an explicit agent rename
request. Title reads, name notifications, and saved-chat resume still passed.
The test used separate native and gateway state directories.

On 11 October 2026, MacBook Pro 2's original connection was migrated to the
installed v0.2.7 relay. Its native and desktop login jobs run under one
supervisor. The original environment and installation IDs were retained, and
the fresh connection returned 36 models. User-driven Claude checks read the
image-only code and wrote the exact release-check seed plus `CLAUDE_NATIVE_OK` on the remote
machine. That connection has since upgraded to v0.2.8. The Codex 2 follow-up,
saved-chat recovery, and model-list refresh selection still need verification.
The user reported that refresh could select native GPT; backend defaults now
agree, but that change has not yet passed the matching client UI check.

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

The initial host migration exposed a launchd KeepAlive race and safely refused
the upgrade. Disabling the job prevented the short-lived fixture race, but a
long-running loaded job could still restart. v0.2.2 asks the owning daemon to
unload its own job only after the idle guard accepts the stop. The client then
replaces the plist and reenables the job. Failure restores the earlier plist.
The real MacBook Pro 2 check waits beyond launchd's throttle interval and passed
active-inference and partial-upload protection, idle restart, idle upgrade with
the new config, recovery, and the unchanged client token. On 11 October 2026,
the installed v0.2.2 runtime also passed abrupt daemon termination: launchd
started a replacement process and a new inference request completed without
changing the client token. The extended fixture made exactly four
calls to the local fixture and removed its temporary service. The working host's
previous long-running service also migrated successfully through this protocol.

The daemon and SSH tunnels are per-user LaunchAgents with RunAtLoad and KeepAlive.
They start at login and restart after process exit. Remote clients still require
the inference host to be awake and reachable; this setup does not provide failover
to another inference host.

## Desktop SSH transport

On 11 October 2026, the v0.2.3 preflight installer passed the desktop's original
`app-server proxy` transport on MacBook Pro 2. The private Unix socket returned
42 model rows. Claude Opus 5.5 at Max and Codex 2 GPT-6.1-Sol at Ultra passed
incremental output, real file reads and patches, automatic repository AGENTS.md
loading, image-only code reading, follow-ups, agent titles, interruption, and
saved-chat resume through a new proxy connection. Cancellation acknowledgements
took 17 ms and 13 ms respectively. Switching the resumed Claude chat to Codex 2
preserved file and image history. The isolated native config digest was unchanged.
The test client explicitly resumes saved chats before starting turns after a
connection change, as the native engine requires.

The installed v0.2.3 package also passed this full loop on Studio through its
permanent SSH inference forward. Claude Opus 5.5 at Max and Codex 2 GPT-6.1-Sol
at Ultra passed all 15 checks in an isolated workspace and native home.
Interruption acknowledgements took 10 ms and 17 ms. The isolated configuration
digest was unchanged during that test. A direct SSH connection to Studio's
production adapter returned all 42 catalog entries, including local Qwen. These checks
prove the native proxy and backend; the rendered Studio SSH picker remains
unverified until the connection is enabled in the client app.

Earlier Studio Control other devices checks reached the native engine directly.
The SSH adapter's combined catalog did not establish model availability through
that connection. MacBook Pro 2's original connection now uses the installed
native relay. Studio still needs that activation and the matching desktop checks.
Keep the proven SSH path available until its native replacement passes.

Run `scripts/e2e-unix.mjs` with the installed gateway and package paths, an isolated
native home with public model metadata, a client-only gateway configuration, and
a dedicated workspace/image fixture. It starts a temporary Unix listener, runs
the native proxy checks, records only results, and stops its owned processes.

A reconnect regression reproduced Node deleting a replacement Unix socket when
an older listener closed. The adapter now binds a private socket and exposes an
inode-checked hard link. A replaced listener keeps its connected clients until
they disconnect, then retires. Tests prove that old clients continue working and
closing the old listener leaves the new socket and client usable.

SSH listener startup and proxy lookup use a separate gateway-owned control home.
Regressions cover repeated startup, live-listener reuse, recovery after abrupt
termination, refusal of an unrecorded path, and preservation of native IPC and
configuration. Only the proxy child's home changes; inference keeps the native
account home and does not copy its authentication file.

An intermittent CI failure exposed the socket before its ownership record was
written. Publication and stale recovery now share a private lock. The adapter
writes the record before publishing the socket alias, and simultaneous SSH
bootstraps reuse the winning listener. Regressions hold publication at the lock
to verify readiness and start two bootstrap processes together.
