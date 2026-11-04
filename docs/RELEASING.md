---
summary: 'Build, verify, publish, install, and recover the Apple Silicon CLI release.'
read_when:
  - Cutting a gateway release
  - Changing installation, desktop registration, or managed services
---

# Release

Provider source pins can advance through the local stable-update gate before
cutting a release. See [provider maintenance](provider-updates.md) for the daily
schedule, generated inputs and blocked-update behavior. It never publishes or
activates a release on its own.

The native macOS control panel has a separate local bundle command,
`npm run app:build`. See [macOS app packaging](macos-app.md) for its verified
backend input, local installation, native tests, and distribution signing
requirements. The CLI archive workflow below does not publish the app.
Use the [background identity and signing workflow](macos-background-item.md) when
shipping a Developer ID signed app and its startup launcher.

## macOS app distribution

Build the matching canonical CLI archive with `--with-native --with-gateway-sdk`
first. The app distributor refuses an archive missing either bundled component;
a minimal CLI archive is not a complete desktop release. From a clean, committed local
`production` checkout whose `package.json` and lockfile have the exact release
version. After the source, backend archive, and local gates are reviewed, run
the one-pass distribution command:

```sh
node scripts/release-macos-app.mjs \
  --backend-archive /absolute/harness-gateway-VERSION-macos-arm64.tar.gz \
  --backend-sha256 LOWERCASE_SHA256 \
  --identity DEVELOPER_ID_SHA1 \
  --keychain /absolute/signing.keychain-db \
  --profile asc-notary \
  --publish
```

It verifies the canonical backend archive and production source, builds, signs,
notarizes, assesses Gatekeeper, extracts the final signed ZIP for the runtime
check, validates the signed updater flow against the existing app and CLI release,
then writes immutable release assets under `.state/app-release/VERSION`.
The signed runtime fixture declares its own JavaScript module type so unrelated
files in the temporary directory cannot change the synthetic CLI semantics.

Publishing requires `origin/production` to resolve exactly to the current HEAD, creates
`app-vVERSION` as a draft, uploads the ZIP, backend archive, `app-update.json`,
and `SHA256SUMS`, verifies every GitHub-reported digest and size, then publishes
the draft. An existing release or any failed draft verification is left
untouched. This command never enables or dispatches GitHub Actions; follow the
[CI cost policy](ci-cost-policy.md) for the separate paid native workflow.
See [macOS app updates](macos-updates.md) for daily client activation and
rollback behavior.

For an explicitly selected-machine rollout, add `--prerelease` to `--publish`.
The release is created as a prerelease before upload and stays a prerelease
when its draft is published. The publisher verifies that state alongside asset
digests and never marks it latest. Automatic app updaters ignore prereleases;
deploy the verified assets only to the approved machines. Publish the CLI tag
as a prerelease too. Do not expose a stable app release for a restricted rollout.

Omit `--publish` only to exercise the local build, signing, and archive gates.
It leaves the versioned stage in place and deliberately cannot resume it as a
later publication. For an actual distribution, rerun only after moving that
failed or inspection-only stage to Trash, then use the one-pass command above.
`--publish` uses `~/Applications/Harness Gateway.app` and
`~/.local/share/subscription-gateway/current` by default for the updater fixture;
pass absolute `--previous-app` and `--installed-release` paths to select the
intended existing signed app and CLI release.

The installer contains the compiled package and official Node 24.22.1 runtime.
The runtime archive is pinned to its published SHA-256 digest. Node's license
travels with it. No provider credentials, test output, or local configuration
belongs in the release archive.
When a signed native app registered the installation's `app-runtime`, the command
wrapper uses that app-owned Node while continuing to load the selected installed
JavaScript. Installing a CLI update preserves the registration. See
[Node and tool permissions](macos-background-item.md#node-and-tool-permissions).

1. Choose the next version with `npm run version:next`. Minor and patch top out at 9:
   after `x.y.9` increment the minor, and after `x.9.9` increment the major. Thus
   `0.9.9` becomes `1.0.0` and `1.9.9` becomes `2.0.0`, never `x.10.x`.
   A legacy patch above 9 such as `0.2.36` moves to `0.3.0`. Set that
   value in `package.json`, confirm it with `npm run version:next -- --check` (it prints
   `ok`, or the problem and a non-zero exit when the version is invalid), then update the
   lockfile. Run the development gate.
2. Download the official macOS ARM64 runtime into `.state/release-runtime` and
   verify it against Node's published checksums. Extract it in that directory.
3. Run `node scripts/build-release.mjs --allow-dirty` only for preflight testing.
   Test the extracted installer on an isolated prefix, including a repeated
   install, paths containing spaces/quotes, and a conflicting command.
4. Run real model tool loops against the installed command on the test Mac. Use
   isolated native and gateway state directories. Record configuration digests,
   provider registration, client-requested chat names, and resume results.
   For SSH proxy changes, run `scripts/e2e-ssh-proxy.mjs --package INSTALLED_PACKAGE
   --codex SIGNED_NATIVE_CLI --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`. It uses the
   real native byte proxy, a real WebSocket upgrade, and an isolated Unix listener
   to verify that device identification precedes the initialize request only
   inside the upgraded session. No account or provider inference is used.
   For gateway sub-agent routing, run `scripts/e2e-subagent-sidebar.mjs --package
   INSTALLED_PACKAGE --code CHECKOUT --root FRESH_EVIDENCE_DIRECTORY`.
   Repeat with `--private`, `--openai`, `--cold --mixed-identity`, and
   `--cold --config-override`. The real SDK spawns a child against a local mock
   provider, opens it using the desktop's resume shapes, and continues it while
   checking its saved identity and reasoning. These checks use private homes and
   no paid inference. `--baseline` reproduces the pre-fix alias rejection.
   Add `--v2` to verify that the delegated task and a follow-up reach the child,
   that it executes a real command, and that its history includes that command
   and the resulting answer. `--v2 --expect-payload-loss` reproduces the
   missing-task failure in 0.5.1.
   Before shipping collaboration transport changes, also run
   `scripts/e2e-subagent-live.mjs --package INSTALLED_PACKAGE --code CHECKOUT
   --config PRIVATE_GATEWAY_CONFIG --model CONFIGURED_CODEX_ALIAS --root
   FRESH_EVIDENCE_DIRECTORY`. This opt-in check uses real subscription inference
   and isolated chat homes. It requires an actual child command and an answer
   containing a proof available only in the child's read-only fixture file.
   For chat-list status changes, run `scripts/e2e-chat-state.mjs --package
   INSTALLED_PACKAGE --root FRESH_EVIDENCE_DIRECTORY`, then repeat with `--native`
   and a second evidence directory. Repeat with `--private` for per-connection
   gateway executors. Two clients of the real SDK must expose an
   already-running chat and receive its actual idle event without resuming it or
   starting another inference. The fixture uses a local mock provider and private
   state. By default it checks the checkout's compiled adapter with the package's
   verified SDK; pass `--code INSTALLED_PACKAGE` to check the packaged adapter too.
   These checks do not prove the phone's unread rendering.
   For Gateway-owned execution reporting, also run the fixture with `--activity`.
   Require the same running turn, a saved completion and a provider failure after
   both application clients disconnect, with no repeated inference or native
   configuration changes. Verify the Gateway Activity screen separately; neither
   this fixture nor this screen establishes Codex unread-dot behavior.
   For shared execution changes, run `scripts/e2e-shared-execution.mjs` with the
   installed command, isolated native home, and isolated client configuration.
   Start without `--inference`, then enable real provider turns and image history.
   The zero-inference run proves process ownership rather than durable chat resume.
   Every host it starts, including the restart phase's replacement, is stopped at the
   end, and a detached reaper (`scripts/e2e-reaper.mjs`) cleans up after a SIGKILL of
   the check: its process groups, the SDK sockets its links name that nothing serves
   (with their `.lock` files) and its private home. It kills only groups it saw
   alive: a group that emptied or answers no probe is never signalled again, so a
   reused process ID cannot be hit.
   The check starts its host from the `dist` of an installed package: pass
   `--package INSTALLED_PACKAGE`, or leave it out and the script uses the package
   that `--gateway`'s launcher runs (its `current/package`). Only when neither has
   `dist/execution-host.js` and `dist/config.js` does it fall back to the checkout's
   `../dist`, and a package that ships `gateway-sdk` then refuses with "requires a
   matching installed gateway SDK". The first JSON line printed names the `dist`
   used, so confirm it is the installed package. Give the isolated native home a fixture
   `models.json` named by `model_catalog_json`, as the other end-to-end scripts do,
   and start the SDK once on it before the check, so the two adapters do not run
   the first catalog preflight at the same moment.
   For speed controls, run `scripts/e2e-fast-mode.mjs --gateway INSTALLED_COMMAND
   --package INSTALLED_PACKAGE --root PRIVATE_EVIDENCE_DIRECTORY`. It uses the
   real signed SDK with a mock upstream through stdio and a private Unix socket.
   It proves requested and returned tiers, settings changes, saved-history resume,
   and native isolation; it sends no subscription inference and does not prove
   rendered desktop controls or the built-in cloud transport.
   For named Qwen role context changes, run `scripts/e2e-subagent-sidebar.mjs
   --package INSTALLED_PACKAGE --code CHECKOUT --root TASK_DIRECTORY --v2
   --role-fork --named-worker --cold`. Repeat in a fresh directory with
   `--worker-stale-catalog --worker-compact`. Require the actual named Qwen child
   to report its bounded context, retain its model and effort, execute tools,
   resume after the cold host restart and compact exactly once in the second
   run. These checks use synthetic inference and do not spend provider credit.
   For Chat Completions translation changes (local Qwen or another
   `chat-completions-api` provider), run `scripts/e2e-chat-compaction.mjs --package
   INSTALLED_PACKAGE --config PRIVATE_GATEWAY_CONFIG [--provider qwen]`. It sends the
   compaction shape (no tools, `tool_choice`, an undeclared historical tool), a turn
   with declared tools and an undeclared historical tool, and an oversized prompt to
   the real provider, and requires an answer, an answer, and `context_length_exceeded`.
   1.2.2 fails all three. It prints only PASS/FAIL lines and fixed error codes. When
   the model's metadata lists image input, or with `--vision`, it also sends a user
   image and a tool-result image and requires the model to name their colors.
   For chat identity changes, run `scripts/e2e-identity.mjs --package
   INSTALLED_PACKAGE --root PRIVATE_EVIDENCE_DIRECTORY`. With the package's own
   gateway SDK and a mock upstream it proves that new chats stay
   `subscription_gateway` by default, and that with the `openai` opt-in a new gateway
   chat is recorded as `openai` (thread, rollout and SQLite), is in the registry when its start returns,
   compacts locally on the selected model, routes to the gateway when a new connection
   resumes it, sends nothing with the gateway token to the ChatGPT backend, and is
   listed by a default `thread/list`; and that a legacy chat stays
   `subscription_gateway` and is listed through the router but not by a stock engine.
   For compaction changes, run `scripts/e2e-compaction-switch.mjs --gateway
   INSTALLED_COMMAND --package INSTALLED_PACKAGE --root PRIVATE_EVIDENCE_DIRECTORY
   --expect selected-turn --shared`. This is the release step. A package that
   ships `gateway-sdk` (0.4.3 and later) compacts inside the user turn, so the
   run verifies the package's own gateway SDK receipt and selected-model recovery,
   Stop, failures, and reconnect through stdio and Unix with a mock upstream and
   the signed SDK. The script detects `gateway-sdk` in the package (through its
   `dist/gateway-sdk-runtime.js`, else the same file layout). When the package
   has it, `selected-turn` is the default and `automatic` and `baseline` are
   refused; when it does not, `selected-turn` is refused. `--expect automatic`
   and `--expect baseline` are for legacy packages without `gateway-sdk` only
   (baseline reproduces the previous-model failure of the stock SDK). `--codex`
   does not change the SDK of the gateway executor, which always runs the
   package's own `gateway-sdk`; it only replaces the SDK the script itself
   starts and checks. The script uses `gateway-sdk/gateway-codex` in the package
   and says so if it is missing.
   Every child runs under a private HOME inside the run folder, so no execution
   host home or receipt reaches `~/.local/state`. Only the pinned SDK's fixed
   socket folder, `/tmp/codex-daemon-UID`, stays outside, because the SDK
   hard-codes it; the script removes its own stale sockets there. A passing run
   removes its `/tmp/gw-compact-switch-*` run folder; a failing run keeps it, and
   `--keep-fixture` keeps it on request. With `--shared`, the
   `selected-turn` run also checks the shared execution host over stdio; a legacy
   `automatic` run only checks the safe refusal of automatic compaction, not
   seamless recovery.
   For managed worker context changes, also run `scripts/e2e-managed-routing.mjs
   --package INSTALLED_PACKAGE --code CHECKOUT --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`.
   It uses the verified bundled SDK with a mock provider to prove compaction
   exceeds the ordinary byte budget within its bounded recovery allowance,
   preserves a proof from the original history, and resumes an ordinary turn
   below the original limit. It uses private state and no paid inference.
   For Responses continuation changes, run
   `scripts/e2e-responses-continuation.mjs --package INSTALLED_PACKAGE --codex
   SIGNED_CODEX_MACH_O --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`. It verifies actual
   continuation flags, message phases, nested text, and one dispatched tool with
   the pinned signed SDK and a mock upstream. Pass the signed Mach-O under
   `CodexCLI.app/Contents/MacOS/codex`, not its unsigned `bin/codex` shell launcher.
   The fixture requires fresh isolated state, rejects native homes, and uses no
   copied authentication or paid inference.
   For interrupted Responses terminals and missing-terminal recovery, run
   `scripts/e2e-responses-terminals.mjs --package INSTALLED_PACKAGE --codex
   SIGNED_CODEX_MACH_O --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`. It verifies the
   original acknowledged SDK turn, actual incomplete terminals, minimal
   completed terminals, once-only tool execution, safe pre-output EOF retries,
   and partial-output failure. It uses localhost mocks and isolated state, with
   no native authentication or paid inference.
   For reasoning levels, run `scripts/e2e-reasoning-levels.mjs` with the same
   `--gateway`, `--config`, `--codex` and `--catalog` options plus a fresh
   `--fixture` and `--output`. Pass the native model cache
   (`~/.codex/models_cache.json`) as `--catalog`, never the gateway catalog, or
   gateway aliases are routed as native models. It checks Max and Ultra on Claude
   Opus and Codex Sol: the effort Codex sends, Ultra's `collaboration` tools, and,
   for Claude, the CLI's actual `--effort` and `--thinking-display` flags.
   For goal durability, run `scripts/e2e-goal-outage.mjs` with the same options.
   It starts an active goal on a gateway model, SIGKILLs the adapter and every
   SDK child mid-turn like a power cut, then resumes and requires the goal to
   survive and finish. Both use real inference in an isolated native home.
   For model switches during a goal, run `scripts/e2e-goal-switch.mjs` with the
   same options. It starts an active goal on `--from`, switches the chat to `--to`
   with `thread/settings/update` as the picker does, and requires the next turn to
   start by itself and send its requests on the new model. It also uses real
   inference in an isolated native home.
   A first real turn is required before the SDK can resume an empty chat.
   Run `scripts/e2e-execution-sandbox.mjs` to confirm the live control socket is
   unreachable inside the actual macOS sandbox, including through its alias.
   For native resume, fork or reasoning changes, run `scripts/e2e-native-model.mjs
   --gateway INSTALLED_COMMAND --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`. It sends the
   desktop's own resume and fork shapes after an engine restart to the signed SDK
   directly and through the adapter, and requires the adapter to give each the same
   model and effort. It uses isolated homes and a localhost mock upstream, with no
   authentication or paid inference.
5. Commit and push the final source. Wait for green CI.
6. Run `node scripts/build-release.mjs` from the clean release commit. It always
   compiles before packing, refuses generated source drift or missing package
   entry points, and verifies the complete backend manifest before archiving. Its final
   JSON line gives absolute `asset` and `checksum` paths; inspect the archive's
   file list and verify `SHA256SUMS`.
7. Before publishing anything, run the forward check against the release the fleet runs
   now, so every Mac picks up the new release without a restart:
   `node scripts/check-forward-compat.mjs --deployed ~/.local/share/subscription-gateway/current/package --candidate ARCHIVE`.
   It runs the deployed release's own forwarding code against the candidate package in a
   private `/tmp` layout and exits non-zero (`deployed_release_refuses_candidate`,
   `code_mode_differs`, ...) when that release would refuse chats of the new one. Do not
   publish a release that fails it. `same_gateway_sdk` and `forwards` pass. The app
   publisher (`scripts/release-macos-app.mjs --publish`) runs the same check against
   `--installed-release` before its updater fixture and refuses to publish on failure.
8. Publish the versioned archive and checksums to the private GitHub release.
   Install exactly that asset on each device, then run `gateway versions --check`
   there and require a zero exit before the device is treated as updated. Run
   `gateway rollout` after each install and require `ready` before declaring the
   machine shipped. It ties immutable loaded process releases, the service's
   PID-frozen release, the inference response header, execution-host identity,
   and a current tool canary together; a moved `current` link or an HTTP 200
   alone cannot pass it. Use `gateway rollout --verify` for a new isolated
   no-provider canary when a cached proof is pending. See [rollout readiness](rollout.md).
   After every install, also run `gateway health` on every Mac; its verdict must
   be `ok` or `warn` (see [the watchdog](health.md)). A `fail` means this Mac is
   broken or half-moved, and the alert push is not configured until
   `<state>/alert-push-url` exists with mode 0600. Run it as `gateway health
   --smoke` on the machine that took the new release first: that is the one pass
   that proves the app's own engine still chats, and its answer is remembered
   against the app build, so the ten-minute check is paid once per update.

## Updating without quitting the app

Installing a release only switches the `current` link; nothing is stopped. Each
long-running process checks once a minute whether `current` points to a different
release and moves to it at an idle moment:

| Process | Moves when | How |
| --- | --- | --- |
| Stdio adapter (one process per app connection) | no active turn, no pending request, 30 seconds quiet | exits; the app starts a new adapter on the new release within seconds |
| SSH listener (remote Mac) | a bootstrap on the installed release finds it running another release, or a newer release is installed and two idle checks in a row (about 1–2 minutes) pass with no active session; since 1.6.3, also when a connected app's proxy finds it on another release and it is idle (no request, turn or approval in flight, 30 s quiet), checked a minute after the connection opens and every 2 minutes after | on bootstrap replacement the old listener keeps serving its open sessions and the new one binds a fresh alias; on self-retire, or when the proxy asks it to retire (SIGUSR2, the same request `gateway native install` sends), the listener exits and the app's reconnect starts the new one |
| Inference server | at its next check, busy or not | the installed release's handler takes over the same socket in the same process: new requests use the new code at once, running requests finish on the old code; no connection is refused. A release whose serve runtime is incompatible falls back to an idle restart |
| Supervisor, execution host, relay | fully idle: no app connected and no chat loaded; after 15 minutes (awake time) of waiting, quiet is enough: no turn running, no background terminal and no turn ended in the last 5 minutes, with apps still connected ([services](services.md#moving-to-a-new-release)) | idle or quiet restart; launchd starts it on the new release, and connected apps resume their chats on it |

Every server response carries `X-Gateway-Release` with the release that served it.
Unix sessions never use the stdio adapter's per-session upgrade exit. Reconnecting
to the same old listener would otherwise repeat the disconnect without loading
new code. The listener, not an individual session, owns its upgrade lifecycle.
Until the supervisor is idle or quiet it keeps the previous release, so adapters and the
host must stay protocol-compatible across one release. Each move is logged as
`self_upgrade`, except an SSH listener replaced by a bootstrap, which is logged
as `ssh_listener_replaced`. In that event `from` is `unknown` when the old
listener recorded no release, which means it started from a checkout or from a
release before 0.4.4, so the first 0.4.4 rollout logs `from: "unknown"` for
every listener it replaces. Processes started from a checkout never move
themselves, except that an SSH listener started from a checkout is replaced
when a bootstrap on the installed release connects. Releases before
0.2.32 do not have this; moving from them needs one service restart. In-place
server takeover starts with 0.2.35; a 0.2.32 to 0.2.34 server needs one restart of
its inference process to reach it.

Run `gateway versions --check` on every Mac after an install. A process is
lagging when it loaded an older release than the installed `current` target,
which the command reads from mapped files with a launch-path fallback. For an
app-owned Node whose JavaScript is not mapped, also check `gateway health`: a
service that publishes `runningRelease` is compared against its live PID instead
of the movable `current` link. Older services need one normal restart to publish
that field. The `X-Gateway-Release` header alone is not proof of that:
it names whichever release served one inference response, and says nothing
about the other processes on the machine. Components that move only when
idle, such as the service supervisor, the shared execution host and the
engines it starts, the SSH listeners, the desktop adapters and the native
relay, can stay on the previous release until they go idle. That is expected,
so recheck after they have been idle rather than force-killing them; a kill
skips the idle guard and cuts off whatever that process was holding. See
[diagnostics](diagnostics.md#running-component-releases) for what the command
prints.

The installer keeps the current release, the previous one and the newest other
release. Older releases are deleted after the checks below pass: each is first renamed to
`releases/.retired-NAME-PID` and then removed, so an interrupted deletion never leaves a
half-deleted release under its own name, and the next install finishes it. Published
releases can always be downloaded again, so nothing goes to the Trash. Each managed
CLI opens its immutable `package/dist/cli.js` and release marker read-only at
startup; each loaded server runtime shares one marker descriptor until that
runtime's own in-flight requests finish. This keeps an app-owned Node that was
launched through the movable `current` link visible to `lsof` after later
installs. Before pruning, the installer checks same-user `lsof`, `ps`, and
managed LaunchAgent references. If any inspection fails, or an older process
has no immutable bootstrap proof, pruning is skipped for that install. A later
install cleans up once the holder exits.

The build refuses dirty source unless the preflight flag is explicit. It does not
download credentials or publish automatically.

For a release containing the native connected-machine adapter, build and test
the matching relay first, then use `node scripts/build-release.mjs --with-native`.
The relay's source digest, package version, pinned SDK revision, archive checksum,
linked Codex version and release profile must match the archive. The relay pins its
own SDK (rust-v0.163.0-alpha.10.2 from 0.4.7) and the gateway SDK keeps its own, so
reusing components checks each against its own pins. Run
`node scripts/e2e-native-relay.mjs --root /tmp/gwrl-$(date +%s)` with the built relay
before publishing. Verify the original machine registration and
model picker before publishing. See [native transport checks](native-remote.md).

Gateway executors can use a separately compiled SDK with selected-model compaction.
Build and test it from the checksum-pinned upstream archive:

```sh
node scripts/build-gateway-sdk.mjs --test
node scripts/build-gateway-sdk.mjs
node scripts/build-release.mjs --with-native --with-gateway-sdk
```

## Disk space

Release scripts check free space before their heavy work. Gateway SDK tests require
40 GiB and SDK-only builds require 25 GiB; the native relay requires 40 GiB; the
release archive requires 4 GiB; the macOS app release and its updater-fixture
check each require 10 GiB; and the updater fixture requires 6 GiB on its
`--root` volume before inspecting the candidate. Set
`GATEWAY_RELEASE_MIN_FREE_GIB` to a positive number to replace the applicable
default when a deliberately tighter host has been reviewed.

`build-release.mjs` stages packages under a per-checkout namespace in the operating
system temporary directory, then retains only the newest successful archive and
`SHA256SUMS` there. It removes its staging directory after success or ordinary
failure. Signal cleanup is best effort between synchronous archive commands; a
force-killed build can leave its exact `build.lock`, which must be removed manually
only after checking that its recorded owner has stopped. Concurrent release builds
for the same checkout refuse. Copy or upload the reported absolute paths before
macOS clears temporary storage. To intentionally retain build outputs, pass
`--output-dir /absolute/release-assets`; that directory is never broadly pruned,
so its archives remain the operator's responsibility.

After a release is published and installed, run `npm run release:clean` to reclaim
the cached Cargo targets while preserving release artifacts and source archives.
Use `npm run release:clean -- --dry-run` to review the planned Cargo cleanup.
It retains updater-fixture directories and prints their sizes with the exact
manual Trash command. A failed updater fixture reports `errorClass` and, when
space is exhausted or critically low, `disk: "low"` without exposing its error
message.

For a development-profile test run, the SDK's large test futures need a larger
thread stack: `RUST_MIN_STACK=33554432 node scripts/build-gateway-sdk.mjs --test --dev`.

The gateway SDK has its own executable, licenses, dependency inventory, and build
receipt, and it now also carries `codex-code-mode-host`, the Code Mode companion
built from the same pinned source; app signing gives that file its own identifier and
the two JIT entitlements V8 needs, and the companion statically links V8 through
Codex's code-mode runtime, whose license is listed with the Cargo packages in
`dependencies.json`. The SDK build downloads V8's pointer-compression sandbox library
from OpenAI's `rusty-v8-v<version>` release, as Codex's `setup-rusty-v8` action does.
It accepts the library only after its checksum manifest matches the digest pinned in the
verified source (`third_party/v8/rusty_v8_<version>_release_manifests.sha256`), and
records the version and archive digest as `rustyV8` in `build.json`. After a build, run
`node scripts/e2e-code-mode-host.mjs --artifact .state/gateway-sdk-build/artifact
--catalog ~/.codex/models_cache.json` to prove a Code Mode cell runs. The release builder verifies its version, SDK revision, archive and patch
digests, source digest, binary checksum, and capability. It refuses modified cached
SDK source or unexpected artifact files. The native signed Codex executable and
desktop bundle remain unchanged. Only a verified gateway executable can enable
the selected-model compaction capability; older installations retain their existing
fallback behavior. Run the real SDK mock cases and gateway continuation checks
before publishing a release with this capability.
The upstream release archive declares workspace version `0.162.0-alpha.17.2`
while its lockfile retains `0.0.0`. A guarded helper repairs exactly those 161
source-less workspace versions. All external package versions, sources, checksums,
and dependency blocks remain byte-identical. The repaired lockfile and helper are
hashed in the receipt; Cargo tests and builds still use `--locked`.
The test gate runs three executor-identity unit tests in `codex-model-provider-info`
and six compaction cases: the four for `subscription_gateway` and native chats, and
two for `openai` inside a marked gateway executor. It also runs two queue integration
tests covering both gateway identities, writes during a pause, cold resume,
explicit continuation, explicit queue start, and the native failure behavior.
Three cache-recovery accounting tests cover cumulative usage below, at and above
the context window, absent usage and unchanged unmarked behavior. Also run
`scripts/e2e-cache-recovery.mjs` against the built SDK and current Gateway code
before publishing. It must prove that a third cold call and unchanged retry
stop without a fake context-overflow signal or automatic compaction. Only a
separate explicit client compaction may produce a smaller continuation in the
same chat and model. See [cache safety](cache-safety.md#recovery-verification).
The compaction cases use the
upstream compact suite with its original test aliases and constructor. The runner
temporarily narrows the suite aggregator to that module, avoiding unrelated upstream
test compilation errors, then restores the exact original bytes. Its digest joins the
receipt; the verified SDK source tree must match again before building the executable.
The cases set the executor marker in the process environment, so the gate runs every
case on one thread. Capability `gateway-executor-v3` combines the executor identity
patch with `scripts/patches/gateway-queue.patch`, which preserves queued messages
after failed gateway turns. `scripts/patches/gateway-dynamic-tools.patch` also keeps
declared-deferred client tools reachable when the selected model lacks search;
Seven additional Rust cases preserve search, schemas, policy and namespace rules;
the existing deferred-filtering regression also runs explicitly in the gate.
The managed role context patch also carries paired context and compaction limits
through the SDK's typed role projection, only inside marked Gateway executors
for explicitly selected managed aliases and the named Qwen worker alias.
Three Rust cases check its bounds, marker and alias isolation, and
preservation of other runtime settings. All four patches contribute to the patch
and source digests. A changed patch
requires a new SDK build even when the capability name stays the same; it cannot
reuse an SDK component with older source hashes. See
[client tool reachability](client-tool-reachability.md) for the mock E2E gate and
the separate desktop scheduling boundary.

A JavaScript-only fix can explicitly reuse unchanged native components from a
previous published installer instead of rebuilding Rust. Download the exact
published asset and use its independently verified archive checksum:

```sh
node scripts/build-release.mjs --with-native --with-gateway-sdk \
  --reuse-components-from /absolute/path/to/previous-published-release.tar.gz \
  --components-sha256 VERIFIED_ARCHIVE_SHA256
```

Reuse verifies the whole archive checksum, safe tar entries, every payload file
against its complete manifest, and the selected components' current source hashes,
upstream pins, release profile, and capabilities before writing a release stage.
Archive links and path overrides are refused. Validated macOS provenance metadata
is ignored; only the six allowed files for each selected component are copied.
Any changed component source requires a fresh build. Without both explicit reuse
arguments, the usual matching-release artifact checks remain in force.

A gateway SDK fix can reuse the unchanged relay from its original published
archive. Build the SDK for this version first, then use `--with-native
--with-gateway-sdk --reuse-native-from ORIGINAL_ARCHIVE --native-sha256 DIGEST`.
The relay retains its verified original receipt; the fresh SDK must match the
current source, patch digests and release version.

A native relay fix can ship a freshly built relay while still reusing the gateway
SDK from that bundle. Build the relay for this version first
(`node scripts/build-native-relay.mjs --test --dev`, then
`node scripts/build-native-relay.mjs`), then add `--fresh-native`:

```sh
node scripts/build-release.mjs --with-native --with-gateway-sdk \
  --reuse-components-from /absolute/path/to/previous-published-release.tar.gz \
  --components-sha256 VERIFIED_ARCHIVE_SHA256 --fresh-native
```

The flag requires both component flags and both reuse arguments. Only the gateway
SDK is verified and copied from the bundle, so `release.json` lists only that
component. The relay goes through the normal artifact checks: package version,
release profile, pinned SDK revision, and the current native source digest. The
bundle must be the one that built the gateway SDK; a bundle that itself reused
the component is refused.
Reuse requires a fresh release stage; move any earlier stage for that version to
Trash before rebuilding it.

Reused build receipts keep their original version and bytes. The new
`package/release.json` binds that earlier bundle's version and archive checksum to
each reused file's size and checksum; runtime verification checks this binding.
The CLI's package version and release commit still identify the new release.
Run the installed SDK checks for the changed JavaScript path before publishing.

# Upgrade and recovery

The installer verifies file checksums before changing the current release link.
It saves the previous release target, and only when the current release is a
different version, so reinstalling the same version keeps the last different
release for rollback. Before switching, it runs the packaged `gateway-codex
--version` once (60 s limit, failures only warn) so macOS scans the new large
executable then and not during the service's first host start. Reinstalling
identical content is safe; different content under the same version is rejected. Preserve the existing data
directory. Service migration requests a safe idle stop before replacing a managed
LaunchAgent. Busy inference or request uploads refuse the upgrade.
The managed job is temporarily disabled during migration. The owning daemon
unloads its job only after its idle guard accepts the stop, so KeepAlive cannot
restart the old command. Older daemons need one safe restart to load the installed
idle-upgrade protocol. Failure reenables the job and restores its earlier plist.

A 0.4.0 adapter that is still running, or a rollback to 0.4.0, reads the same state
files, so this build saves a chat's tier or a new-chat default only when its row
declares it; see [rollback and mixed versions](speed-controls.md#rollback-and-mixed-versions).

Use `gateway service status`, `gateway doctor`, `gateway desktop status`, and
`gateway versions --check` after installation on each Mac. Registration
prepares future app launches and does not interrupt an open app. One fresh
launch is needed after first registration. The private desktop launch hook is
specific to the tested Codex build, so verify it after app upgrades.

Preview job consolidation with `gateway service consolidate`. Apply it only after
local and remote chats finish. See [the service migration checks](services.md).
An updated installer does not consolidate running jobs automatically.
Test an isolated supervisor under real launchd with
`node scripts/e2e-service-supervisor.mjs /absolute/installed/bin/gateway`.
The fixture exercises HTTP streaming, child and supervisor crashes, login setup,
and shutdown. Its relay child is a mock; it preserves the working native relay.
For next-login cleanup changes, run
`node scripts/e2e-login-consolidation.mjs /absolute/installed/bin/gateway`.
It uses uniquely named launchd fixtures to verify live-PID preservation, refused
manual promotion, and actual primary-job activation. It stops only those fixtures
and uses no provider inference or native authentication.

To remove the installation, run `gateway uninstall`. On macOS it first reads the
desktop state as a preflight and stops before removing anything, including when a
`launchctl getenv` fails or a login promotion is staged for the next login. A
unified service plan is not a refusal there, because the service step trashes that
file with the service; off macOS the preflight is skipped and the service step
gives its own platform answer. A later desktop error names what is already gone;
resolve that cause, then rerun `gateway uninstall`. The installation and
managed LaunchAgents move to Trash. Credentials and native Codex configuration
remain.
CLI registration cannot make an unconfigured SSH/cloud backend understand gateway
models; test each execution backend used by a shared chat.
