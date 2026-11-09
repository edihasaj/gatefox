---
summary: 'Native connected-machine adapter using the existing Codex Desktop registration.'
read_when:
  - Changing Control other devices transport or native relay installation
  - Testing models through existing connected machines
  - Investigating remote stalls, sequence gaps, or native relay logs
---

# Native connected machines

The native relay sits in front of the gateway's app-server router. It uses the
same environment ID, installation ID, server name, account, and client-name scope
as the machine's existing Codex Desktop registration. It does not create another
machine or require an SSH entry in the desktop UI.

The adapter is included in managed GateFox releases. Keep each Mac's existing
registration and confirm its live state with `gateway rollout --verify --json`;
installation alone does not prove readiness. Earlier prototype results and
version-specific checks are recorded in [verification](verification.md).

The SDK reads host authentication from the native account through its normal auth
manager. Authentication is never copied into the relay home. Inference still uses
the gateway's separately registered providers. Only the original registration's
metadata is read from the primary SQLite database, through a read-only connection.
The relay keeps its own database and preferences in a private home. Native config,
transcripts, and SQLite files are not migrated or rewritten by registration.

The relay refuses a missing, disabled, or differently owned registration. Its SDK
build blocks creating replacement enrollments.

Choose [setup and builds](native-remote-setup.md) or [troubleshooting](native-remote-troubleshooting.md) for focused instructions.

## Verified app engines

The relay remains linked to the Codex SDK released as rust-v0.163.0-alpha.10.2.
The accepted engines retain the remote-control wire contract, so the relay can
keep that linked SDK. Earlier accepted 0.162/0.163 engines have byte-identical
`app-server-transport` source. The relay and the shared native host keep
separate lists in `src/native-engine-versions.ts`:

| App engine | Relay (`relayAcceptedAppEngines`) | Shared native host (`hostVerifiedAppEngines`) |
| --- | --- | --- |
| `codex-cli 0.167.0-alpha.3.2` | Requires the rebuilt relay (1.7.7); `app-server-transport`, state migrations and the `auth.json` format unchanged from 0.166.0-alpha.6 | Verified with the signed engine through the stdio and Unix shared-native fixtures, with and without `--host-codex` (8 Nov 2026, 1.7.8) |
| `codex-cli 0.166.0-alpha.6` | Requires the rebuilt relay (1.5.9); `app-server-transport`, state migrations and login byte-identical to 0.166.0-alpha.5.1 | Verified with the signed engine through the stdio and Unix shared-native fixtures, with and without `--host-codex` (4 Nov 2026) |
| `codex-cli 0.166.0-alpha.5.1` | Requires the rebuilt relay; remote-control wire contract unchanged from 0.165 | Verified with the signed engine through the stdio and Unix shared-native fixtures (31 Oct 2026) |
| `codex-cli 0.165.0-alpha.1.2` | Requires the rebuilt relay and the unchanged remote-control wire contract | Verified with the signed engine through the stdio and Unix shared-native fixtures |
| `codex-cli 0.164.0-alpha.11.1` | Runs with the linked transport after separate wire-contract review and relay tests | Shared after the signed SDK passed stdio and Unix reconnect, steering, Stop, once-only command and pending-approval checks |
| `codex-cli 0.163.0-alpha.11.2` | Runs with the linked 0.163.0-alpha.10.2 transport | Shared after the signed M5 SDK passed both stdio and Unix native/gateway disconnect, reconnect, steering, Stop, once-only command, and pending-approval checks |
| `codex-cli 0.163.0-alpha.11.1` | Runs with the linked 0.163.0-alpha.10.2 transport | Shared after the signed SDK passed the native disconnect, reconnect, steering, Stop, command, and approval checks |
| `codex-cli 0.163.0-alpha.11` | Runs with the linked 0.163.0-alpha.10.2 transport | Shared after the signed SDK passed the same checks |
| `codex-cli 0.163.0-alpha.10.2` | Runs; this is the SDK it links | Shared after the signed SDK passed the native disconnect, reconnect, steering, Stop, and approval checks |
| `codex-cli 0.162.0-alpha.17.2` | Runs, so a Mac whose app has not updated keeps its relay | Shares the engine |
| Anything else | Exits with status 1 before it connects | Not shared; a combined host serves gateway chats only and logs `native_sharing_unavailable` with `reason: sdk_version` |

See [desktop update compatibility](desktop-update-compatibility.md) for startup
diagnostic passthrough, app-bundle replacement isolation and the 0.164 review.

The 0.163.0-alpha.11.2, 0.163.0-alpha.11.1, 0.163.0-alpha.11, 0.163.0-alpha.10.2, and 0.162.0-alpha.17.2
releases ship a byte-identical `app-server-transport` crate, so the
remote-control protocol, the patched stream-end hooks, the existing-registration
guard and the `remoteControl/*` methods are the same for these app engines. The 0.163 state
database adds two migrations, and the SDK opens a database that a newer release
migrated, so a rollback to a 0.162 relay still opens the relay home.

The 11.2 comparison covered all 36 `app-server-transport` files, which matched
11.1 and the linked 10.2 source byte for byte. Its signature and reported version
were checked on the M5 before the isolated shared-native fixture ran. The fixture
used no copied authentication or paid inference and left no owned SDK process
behind. This compatibility admission requires a newly built relay; changing the
TypeScript list alone cannot update an older installed relay binary.

Shared-engine verification covers more than the protocol. In 0.163,
pending unloads became a map with a wake-up
signal, listener removal now checks the thread's generation, finished v2 sub-agent
threads unload automatically, and startup configuration resolves against the
working directory. The 0.163 fixture also verifies every frontend disappearing
during inference or a pending approval, followed by recovery of the same SDK
process, turn, history, and original approval request. An engine joins
`hostVerifiedAppEngines` only after
`scripts/e2e-shared-native.mjs` passes against it. The relay needs none of that,
because it never uses the host's engine (see the next section).

The relay's own list is `native-relay/src/cli_version.rs`; a gateway test fails when
it differs from `relayAcceptedAppEngines`. The relay compares the text that the app
CLI prints for `--version`; it does not check the code signature itself. Its `--codex`
path is the app's own launcher, taken from the service plan or the registration, and a
host that shares an engine verifies OpenAI's signature (TeamIdentifier `2DC432GLL2`)
before it runs it. Gateway chats are a separate pin: they run the release's own
gateway SDK (0.162.0-alpha.17.2), whatever engine the app ships. A relay that refuses
the app's engine exits at once, and after three such exits the service sets it aside
with `component_paused` and reason `failing` instead of restarting it in a loop. A new
app engine needs a new relay build and this verification again.

Every stop now logs its reason on the line before `Native relay stopped; private state
retained`: one of the relay's own fixed refusals, such as `Native relay requires the
matching Codex CLI build` or `Another relay owns this native server`, or a coarse class
for anything else. Paths, accounts and values are never printed.

The relay reads the original machine registration from the native database with
`/usr/bin/sqlite3 -readonly`. A service restart stops every engine that has that
database open, and the next opener recovers or checkpoints its WAL under an exclusive
lock. Without a busy timeout the read failed at once with `database is locked`, so the
new relay exited about 30 ms after `Native relay host authenticated`, three times in a
row, and paused for half an hour (MacBook Pro, 31 Oct 2026). The read now waits up to
five seconds for the lock and retries a failed run twice, one second apart. A missing or
disabled registration is an answer, not a failure, and is still refused at once.

## Relay sessions and native chats

Each phone stream starts its own `gateway codex-shim` session, so the model list, the
chat list and the routing the phone sees are the gateway router's. The relay answers
only `remoteControl/*` itself; `thread/list`, `model/list` and turns go to the router.

Native chats run where any adapter runs them. When the host shares the native engine,
the session attaches to it. Otherwise the session's adapter runs a private native engine
on the native home: always on a plan with `sharedNativeExecutor: false`, and as a
fallback when the host cannot share the app's engine. From 0.4.7, private engines share
the native home with each other, so the app's adapter and the relay's sessions each run
one. The ChatGPT app opened after the relay connected leaves remote control to the relay.

One chat still has one writer. The SDK keeps a per-chat writer lock in
`<native home>/thread-writer-locks`: while the app's engine holds a native chat, the
phone's `thread/resume` is refused with `already has an active writer`, and once the
app lets the chat go (it closes the chat's engine, for example by quitting), the phone
continues it. Gateway chats use the host when the plan shares gateway executors, and
otherwise private gateway engines under the same lock.

## Project trust on mobile

A project appearing in the picker does not prove that its original folder has a
saved trust decision. This affects both new chats and existing chats. A trusted
child repository does not trust its parent folder, and a `projects."/"` entry is
not a wildcard. Mobile can refuse the turn before `turn/start`, with
"Can't verify project trust". Check the native engine's `config/read` response
with the selected `cwd` and `includeLayers: true`; use the native user layer,
not a gateway executor's private configuration snapshot.

An operator who wants all selected folders trusted can explicitly set
`"trustAllProjects": true` in that machine's gateway configuration. This is off
by default and applies when an adapter process loads that configuration. Existing
listeners keep their loaded choice until they retire normally. The
adapter saves real, version-guarded native trust entries for registered project
roots and requested working directories. New project creation and chat
start/resume/fork also establish trust before the result reaches the client or
the chat loads. Gateway executors receive the same policy in their own private
configuration, so an older snapshot does not lose the choice.
Existing aliases are resolved and both spellings are trusted, so a canonical
untrusted entry cannot defeat the selected folder's trust. Starts without a
working directory use the engine's reported default before loading settings.
A shared host from an older release that cannot report its default requires an
explicit folder for such a start until that host upgrades normally.

This policy accepts every selected folder, including a folder previously marked
untrusted. Repository instructions, project configuration and enabled hooks may
therefore load automatically. Command approval and sandbox settings remain the
caller's choices. The adapter returns the engine's actual configuration and layer
provenance; a managed override or failed write remains a failure. It does not
manufacture a trusted response or start a separate maintenance job.

Clearing the flag stops automatic trust after the adapter processes reload. Trust decisions
already saved remain in Codex's user configuration until the operator changes
them. A gateway release that predates this option must first adopt a release
that implements it; editing configuration alone cannot add the behavior.

Run `node scripts/e2e-project-trust.mjs --root /tmp/TASK/project-trust` to verify
the policy through the signed native engine and both adapter execution paths.
The fixture uses private homes, a local model catalog and one localhost mock
turn, with no external provider inference.

## Activation

Read [activation](native-remote-setup.md#activation) in the focused guide.

<a id="registering-a-relay-under-the-unified-service"></a>

Read [Registering a relay under the unified service](native-remote-setup.md#registering-a-relay-under-the-unified-service).

<a id="moving-a-mac-to-the-0163-relay"></a>

Read [Moving a Mac to the 0.163 relay](native-remote-setup.md#moving-a-mac-to-the-0163-relay).

## Session diagnostics

Read [session diagnostics](native-remote-troubleshooting.md#session-diagnostics) in the focused guide.

## Stream ends

Read [stream ends](native-remote-troubleshooting.md#stream-ends) in the focused guide.

## Transport counters

Read [transport counters](native-remote-troubleshooting.md#transport-counters) in the focused guide.

## Lost-request detection

Read [lost-request detection](native-remote-troubleshooting.md#lost-request-detection) in the focused guide.

## Reset switch

Read [reset switch](native-remote-troubleshooting.md#reset-switch) in the focused guide.

## Reading the logs

Read [reading the logs](native-remote-troubleshooting.md#reading-the-logs) in the focused guide.

## Build and checks

Read [build and checks](native-remote-setup.md#build-and-checks) in the focused guide.
