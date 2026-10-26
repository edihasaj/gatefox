---
summary: 'Keep executor ownership separate from laptop connections, and adopt native sharing without interrupting active work.'
read_when:
  - Investigating a chat that stops after laptop sleep, travel, or a network change
  - Enabling native executor sharing or testing disconnected clients
---

# Sleep, travel, and reconnects

Laptop sleep and offline periods are expected. Recovery must not depend on
changing power settings, keeping a desktop window open, or moving a workspace.

```text
Client loses its connection
  → its transport detaches
  → the execution machine keeps its owned SDK and turn
  → a fresh client reads and joins that existing turn
```

The execution machine must itself be running to perform work. Sleep suspends
its processes; a shutdown ends them. On reconnect, the saved chat remains the
source of truth. A missing connection alone is not proof that a command failed,
and the adapter must not resend `turn/start` or repeat a tool command to make
the interface look active.

When a shared gateway executor loses only an adapter socket during an active
turn, the adapter reattaches the chat and verifies the SDK's saved turn state.
It never accepts a pending approval or repeats a caller action; unavailable or
unverified state remains available through the ordinary explicit resume path.

## Discover running chats after restarting the app

A fresh desktop connection discovers recent chats through `thread/list`. The
adapter overlays the owning shared executor's current status on saved native
`notLoaded` rows. An `active` status lets the desktop show its running indicator
without starting or resuming a turn.

If the first list misses the executor or its metadata deadline, the adapter
retries the listed candidates in the background. Once the engine answers, a
verified `thread/status/changed` snapshot updates the running indicator without
requiring another manual list refresh. Missing or unavailable engines do not
prove a chat idle. Candidate counts, reads, and deadlines are bounded; real SDK
status events take precedence over earlier metadata reads.
The adapter remembers up to 512 listed candidates and rotates through four at a
time on its five-second refresh. Successful snapshots can arrive while a slow
neighbour is still pending, and an unsuccessful delivery remains eligible for
retry. Large lists can therefore take several refreshes to recover fully.

The indicator and an attached transcript are separate. Opening a chat uses the
normal resume path to join its stream. The gateway does not replay `turn/start`,
commands, approvals, or completion notifications to make it look connected.
This recovery covers rows the client has actually listed; a chat outside that
list, a host with auto-connect disabled, or the desktop's catalog-history mode
needs its own discovery path. It does not turn API-mode app-owned engines into
durable service-owned executors.

Verify cold and delayed discovery with the isolated SDK fixture:

```sh
node scripts/e2e-chat-state.mjs --package /absolute/verified/package \
  --root /tmp/task-cold-reconnect --restart-discovery
node scripts/e2e-chat-state.mjs --package /absolute/verified/package \
  --root /tmp/task-delayed-reconnect --restart-discovery --delayed-discovery
```

The previous application client disconnects during synthetic inference. The new
client starts with an ordinary state-database list; it must find the same running
turn and later its real completion without starting inference again. The delayed
case makes the first executor lookup unavailable and requires automatic status
recovery without a second list. No account or paid inference is used.

## Native and gateway ownership

Shared gateway executors already belong to the service. Shared native execution
uses the app's original, signature-verified SDK and its existing native home.
Disconnecting a client of either shared executor closes only that client's
socket. A private executor belongs to its adapter and ends when that adapter
ends, so native sharing must be active before a client disconnect can preserve
that executor.

The native SDK must pass the real shared-native checks before its version is
accepted. Those checks cover every frontend disappearing during inference and
during a pending user approval. Reconnect must preserve the SDK process and turn
identity, recover saved results, and never answer an approval automatically.
See [native connected machines](native-remote.md) for verified versions and
[verification](verification.md) for the fixture.

Managed private native launches whose configuration and home match an existing
native relay service plan reserve that home before spawning the SDK. Private
engines may share that reservation with compatible
private engines, but a shared host cannot claim the home until those private
writers have ended. A live or uncertain owner is never displaced.

## Adopt sharing without closing active chats

Use `gateway service shared-native --on-restart` to stage native sharing for
the existing managed service. The command records intent separately from the
active service plan. It preserves gateway sharing, tunnels, components,
authentication, native configuration, and running connections.

Only a subsequent primary LaunchAgent daemon start may apply that intent.
Startup verifies the current plan, SDK, and writer census again. A changed
plan, unsupported SDK, surviving old adapter, or unknown writer leaves the
intent pending and keeps the current valid service plan authoritative. Startup changes only the native
sharing flag and saves the original plan first. A manual daemon invocation
cannot activate the intent.

Staged, installed, and active are separate states. Staging is not evidence that
an existing private executor has become durable. After natural adoption, check
`gateway service status`. For combined native and gateway sharing, also require
`gateway rollout --verify`; its direct-tool canary requires gateway sharing.

## Recovery boundaries

Explicit Stop, user-paused or blocked goals, approval requests, authentication
and billing failures, and usage limits retain their meaning. Shared ownership
does not clear them or create another inference turn.

The SDK handles provider stream reconnection. A request whose retries are
exhausted remains a real failure, and queued work remains available for an
explicit continuation. The gateway never replays uncertain side effects.

## Unread dot after sleep

The desktop renderer sets its unread dot and completion alert only when it
receives a live terminal event for a loaded thread. After sleep, it resumes the
thread but can miss a terminal that the shared executor emitted while no app
session was attached; its durable SDK read receipt does not repair that state.

The adapter keeps a private host-wide ledger at
`<state>/completion-replay.json`. It records a followed turn separately for
each device and marks it delivered when that device's adapter forwards its
terminal frame. After a successful `thread/resume`, the adapter reads the SDK's
latest turn and may forward that exact terminal frame once. The record is shared
by every local adapter process, is bounded to 512 device/thread entries and
seven days, and only a terminal completed within 24 hours is eligible.

```text
device follows turn → app disconnects → SDK finishes → that device resumes
                                            ↓
                           latest saved terminal is replayed once
```

The ledger atomically claims the replay before it emits, so concurrently
resuming sessions from the same device cannot both replay it. A claim is
released when its app write fails and an unconfirmed claim expires after one
minute; a normally connected app still receives its own live terminal event.
The adapter never replays a start, tool action, approval, read state, or
non-terminal event.

An SSH proxy identifies its client by hashing its SSH client address with a
local, random private salt, so the ledger receives only a stable local pseudonym
instead of an address. Sessions without that hello are `local`; relay
registration identifies only the host's remote-control route, not where an
inbound app session originated. This means a Mac whose SSH address changes
between sleep and wake is a new device and does not receive the earlier replay.
It also still depends on ChatGPT reloading the chats it was streaming after
reconnect; that behavior was observed in 26.1021.31345.

See the [isolated unread prototype](codex-unread-trial.md) for the renderer
evidence and the separate client-side testing boundary.

Mosh's terminal reconnection does not provide these JSON-RPC ownership or
approval guarantees. The existing SSH and connected-machine transports remain
in place; the executor lifetime is independent of those connections.
