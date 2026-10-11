---
summary: 'Native connected-machine adapter using the existing Codex Desktop registration.'
read_when:
  - Changing Control other devices transport or native relay installation
  - Testing models through existing connected machines
---

# Native connected machines

The native relay sits in front of the gateway's app-server router. It uses the
same environment ID, installation ID, server name, account, and client-name scope
as the machine's existing Codex Desktop registration. It does not create another
machine or require an SSH entry in the desktop UI.

This adapter is in preflight testing. MacBook Pro 2's original registration is
online through the installed relay, and real desktop requests reach its router.
Registration checks also passed on Studio and the primary Mac. The separate
transport prototype was stopped and its temporary environment deleted.
The original connection still needs its rendered model and chat checks. Do not
remove a working connection until those checks pass.

The SDK reads host authentication from the native account through its normal auth
manager. Authentication is never copied into the relay home. Inference still uses
the gateway's separately registered providers. Only the original registration's
metadata is read from the primary SQLite database, through a read-only connection.
The relay keeps its own database and preferences in a private home. Native config,
transcripts, and SQLite files are not migrated or rewritten by registration.

The relay refuses a missing, disabled, or differently owned registration. Its SDK
build blocks creating replacement enrollments. It verifies the signed CLI matches
Codex 0.162.0-alpha.17.2 before using that version's transport. Another desktop
build requires an SDK update and verification.

## Activation

The old transport and the relay cannot own the same machine concurrently. Quit
ChatGPT normally on the test machine before activation. The installer never quits
the app. Install a release containing the relay, then run:

```sh
gateway native install
gateway desktop register
gateway desktop
gateway native status
```

The per-user LaunchAgent starts at login and restarts after a crash. SDK heartbeats,
acknowledgements, chunks, and reconnects carry the remote app-server messages.
The local adapter obtains real remote-control status and methods through an owned
private Unix socket. Its original executor's remote transport is disabled only
for that process. The primary configuration stays unchanged.

Existing registrations are bound to their native account. Signing out or changing
that account stops the relay's existing connection. It cannot silently adopt a
different account or create a new connected computer.

`gateway native uninstall` stops this managed transport and keeps its private
state. A fresh normal app launch restores the original remote transport. Explicit
uninstall cancels remote work. A changed running registration is refused until
the old service is stopped after active chats finish.

## Build and checks

The relay links the Apache-2.0 Codex SDK from the exact upstream commit documented
in `native-relay/NOTICE`. The build downloads a checksum-pinned archive into
gateway-owned build storage, then applies the outgoing-envelope, server-name,
and existing-enrollment guards there. The signed desktop bundle is unchanged.
The installer carries the SDK license, notice, and dependency inventory.

```sh
node scripts/build-native-relay.mjs --test --dev
node scripts/build-native-relay.mjs
node scripts/build-release.mjs --with-native
```

Current checks cover partial-frame cancellation, truncation, size limits, remote
biometric restrictions, and preservation of future response fields. The shared
router's live model changes, steering, permissions, and goal operations passed
Claude and Codex 2 tests. Native rendered checks and daemon restart during saved
chat recovery must pass before declaring this transport ready.
