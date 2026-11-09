---
summary: "Connection recovery, native transports, direct tools, installers and SSH verification procedures."
read_when:
  - Reading historical transport and installer verification or choosing a matching verification script
---

# Transport and installer verification

These are version-specific evidence records and procedures, not a claim that every later build was tested. For current installed readiness, run `gateway rollout --verify --json`. Return to the [verification overview](verification.md).

## Active gateway connection recovery

Run the compiled candidate against a verified gateway SDK package:

```sh
node scripts/e2e-gateway-reconnect.mjs \
  --package /absolute/release/package \
  --code /absolute/compiled/checkout \
  --root /private/evidence
```

The check drops only the adapter's shared gateway socket while the real SDK
keeps its turn. It requires automatic reconnection without a frontend request,
the same SDK process and turn, one genuine terminal event, and recovery of text
emitted while disconnected through `item/completed`. A second case finishes the
turn before reconnection. A pending approval case requires the original frontend
callback ID, no execution before an explicit fixture approval, and one actual
command execution afterward. All inference uses a local mock provider, and all
homes and ownership records belong to the fixture. These checks exercise the
adapter protocol; they do not prove rendered desktop behavior.

## Disconnected native clients (0.6.2)

The signed `codex-cli 0.163.0-alpha.10.2` passed
`scripts/e2e-shared-native.mjs` with combined native and gateway ownership over
both stdio and the real SDK's Unix proxy. The fixture verifies the exact OpenAI
signature, executable, and engine version before accepting the candidate:

```sh
node scripts/e2e-shared-native.mjs \
  --gateway /absolute/release/package/dist/cli.js \
  --package /absolute/release/package \
  --candidate-engine 0.163.0-alpha.10.2 \
  --host-capabilities native,gateway \
  --root /private/evidence
```

Every frontend disconnects while native inference is held. The same host and SDK
finish that turn while detached, and a fresh frontend reads its real completed
history without another provider request. A separate turn executes one approved
command that appends a byte to a fixture counter, then disconnects during its
next inference request. After detached completion and resume, the counter still
contains one byte and no extra provider request was sent.

Every frontend also disconnects during a pending user approval. Resume replays
the original request and settings without answering it or executing its command;
an explicit Stop then cancels it and a follow-up completes. Two-client Stop,
steering, model and speed isolation, immutable SDK identity, native configuration
preservation, and owned-process cleanup also pass. The fixture uses private
homes, no copied authentication, and local mock inference. It does not prove
rendered desktop controls or the built-in cloud transport.

Staged-adoption regressions separately cover unchanged live plans, primary-daemon
activation, legacy-writer deferral, changed plans, signature/runtime failures,
post-commit recovery, and exact private receipt checks. Readiness remains pending
until staged ownership is active and the host actually holds the native home.

## Live adapter upgrade (0.6.1)

Run `node scripts/e2e-live-upgrade.mjs --previous /absolute/0.6.0/package
--package /absolute/0.6.1/package --code /absolute/compiled/0.6.1 --root
/private/evidence`. The check copies both complete immutable packages into a
private managed layout, starts the released adapter over a private Unix socket,
and keeps that one frontend connection open while its 0.6.0 execution host is
replaced by the candidate host. A mock provider makes no paid requests.

Before replacement the old host performs a real direct tool command and local
Git commit. A deliberately held second turn proves the host's quiet-stop guard
refuses a busy upgrade. Once it finishes, the fixture stops only its host,
fault-injects removal of its private old package, and starts the candidate host.
The already-loaded old adapter must recover its verified SDK through
`managed/current`, resume the same thread with its saved model, provider,
workspace and permissions, and use the resumed connection to spawn a child
agent that performs a second command and commit. The result independently
checks that the original commit was not replayed, the host PID changed, both
SDK packages passed receipt verification, native authentication was never
copied, and all owned process groups and sockets stopped. It records only
sanitized booleans and versions in a `live-upgrade-*.json` evidence file under
the supplied root; active fixture state uses a short private `/tmp` path so its
Unix sockets fit macOS's address limit.

## Hostless direct tools (0.6.0)

Run `node scripts/e2e-direct-tools.mjs --package /absolute/release/package
--code /absolute/compiled/checkout --root /private/evidence`. It starts the real
packaged gateway SDK through `DesktopCatalog`, `AppServerBackends`, and
`AppServerRouter` with no `codex-code-mode-host`. Two gateway chats carry native
rows that respectively declare `code_mode_only` and no tool mode at all. The
selected runtime changes both to explicit `direct` rows, exposes `exec_command`
(not Code Mode's `exec` or `wait`), then uses the SDK's real `spawn_agent` path
to create bare-native child chats. The children edit two isolated workspace files
and make local conventional Git commits. The fixture asks for `code_mode_only`
and `code_mode_host` while only its disposable repository uses full access; the
explicit direct rows take precedence. A local mock provider observes successful
command-output continuations; the fixture independently verifies exact file bytes,
Git history, clean status, completed child turns, saved provider identity, and
untouched native config and authentication. It records only sanitized booleans and
model/provider identifiers in `result.json`, copies no authentication, and sends
no paid inference requests.

The same script accepts an SDK whose verified receipt pins `codex-code-mode-host`
(0.6.6 and later). Such an SDK keeps native tool modes, so the fixture gives both
native rows an explicit `direct` mode and proves they still win over the caller's
`code_mode_only` and `code_mode_host` settings. `hostlessSdk` in `result.json`
records which shape ran. The script also checks that a host sits beside the
executable exactly when the receipt names one. The rollout readiness probe runs
this script, so every release package with either SDK shape must pass it.

## Loaded service release

Run `node scripts/e2e-service-release.mjs --package /absolute/release/package`
to copy public runtime code into an isolated release tree, start its supervisor,
move `current`, and observe a real heartbeat. The supervisor keeps its original
`runningRelease`, and the watchdog detects it even when the injected process
inventory incorrectly reports the newly installed release. The check copies no
authentication and sends no inference requests.

## Catalog generation capacity (0.5.6)

Run `node scripts/e2e-generation-capacity.mjs --package /absolute/release/package`
against a compiled release with its verified gateway SDK. Five real SDK processes
load separate catalogs and chats, and each chat remains readable through its
original writer. The check then suspends one unloaded fixture SDK, starts a sixth
catalog within five seconds, resumes that SDK, and verifies the released sixth
generation (which loaded no chat) retires without another acquisition. The SDK
may retain the five started chats after unsubscribe; cleanup preserves them.
It uses isolated chat storage,
copies no authentication, and sends no inference requests. Version 0.5.5
reproduces the four-generation refusal; 0.5.6 passes that part but remains
vulnerable to the suspended-engine case. Shared and per-connection adapter regressions
also cover retaining loaded chats, active turns, client leases, and reclaiming
unused generations. Rendered desktop recovery still requires live activation.

The v0.2.23 source passes the reduced gateway scope checks. The v0.2.22 candidate
passed installed Responses terminal checks, and v0.2.21 passed isolated backend
ownership and compaction checks.
MacBook Pro 2's original Control other devices connection is active through its
native relay. Full desktop parity through that connection remains unverified.
SSH, Unix proxy, and local engine results do not prove the cloud connection.

## Observed transport outage

During the 12 October outage, the primary Mac's inference process remained healthy
with no active requests. Its reverse-forward LaunchAgents for MacBook Pro 2 and
Studio were unloaded, but not disabled. Tailscale had also stopped. Restoring
those jobs and bringing Tailscale up made both remote `gateway doctor` checks
report ready with 25 added models. The earlier Qwen tunnel was restored separately.

The primary Mac's kernel boot time was 5 October. These observations do not show
an outage reboot or an automatic-start failure. Why the jobs were unloaded is
unknown. Edi reopened the affected original connected-computer model list and
confirmed that Claude, Codex 2, Copilot, and Qwen returned without an app restart.

The development code enables a disabled gateway job when the user explicitly
registers it, without restarting an already loaded process. Newly owned SSH
children use a ten-second connection timeout and one connection attempt before
their supervisor retries. The supervisor also supplies these defaults when it
starts a child from an older plan; it preserves explicit values and running jobs.
These changes are not yet active on the deployed devices.

### Device-local inference

On 12 October, the installed v0.2.10 command on MacBook Pro 2 passed an isolated
Claude Sonnet 5.5 run using that device's existing subscription login. Its daemon
configuration contained only a local Claude provider. It used no inference
forward to the primary Mac. The signed SDK streamed replies and reasoning,
followed a hidden repository `AGENTS.md` marker, read and patched a file, retained
follow-up history, acknowledged interruption in 3 ms, cleaned up the interrupted
request, and completed a recovery turn. Native configuration stayed unchanged,
and the isolated Codex home contained no copied authentication.

Device-local Codex 2 GPT-6.1-Sol also passed streaming, hidden repository
instructions, file reads and edits, follow-up history, reasoning, interruption,
cleanup, and recovery on the test Mac. Its independent gateway registration
verified the requested secondary email. Native configuration stayed unchanged,
and no primary authentication was copied.

Configurations retaining the 25 public routes are staged on the test Mac and
Studio. They are not active. Studio still needs its independent secondary Codex
registration. Its Copilot CLI is now installed, authenticated, and advertises all
four selected models. Qwen's HTTPS endpoint returned its configured model with
authentication. Device credentials and final cutover still need verification
before removing the working inference forwards. The existing Codex cloud
connection carries chat transport; it does not provision these registrations.

### Compaction and silent streams in v0.2.11

The signed Codex SDK passed forced compaction recovery through the updated
gateway. An upstream HTTP 400 context-limit error and an SSE context-limit error
before the first delta both retained `context_length_exceeded` in a failed
Responses event. With generic stream retries disabled, Codex trimmed history
from eight input items to seven, completed compaction, and completed a subsequent
turn. The isolated native configuration stayed unchanged and contained no copied
authentication. These controlled checks establish the recovery mechanism;
the running v0.2.6 daemon has no request failure logs to attribute the reported
historical failure to a specific cause.

The signed SDK also passed a controlled silent-stream check with a shortened
500 ms idle timeout. Comment-only heartbeats failed before a 1.5-second reply.
Genuine Responses progress events kept the same silent request alive until its
real reply completed. Interrupting during that quiet period produced the SDK's
actual interrupted status, released gateway capacity, stopped heartbeats, and
allowed recovery in the same SDK process. This test used mock inference and an
isolated home, with no primary configuration or authentication access.

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
