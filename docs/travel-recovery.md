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

Mosh's terminal reconnection does not provide these JSON-RPC ownership or
approval guarantees. The existing SSH and connected-machine transports remain
in place; the executor lifetime is independent of those connections.
