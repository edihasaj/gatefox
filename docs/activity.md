---
summary: 'Gateway-owned, read-only execution snapshots and recorded turn outcomes; no Codex client changes.'
read_when:
  - Checking whether work continued after closing a viewing laptop
  - Changing the Gateway Activity screen or gateway activity command
  - Investigating missing completion or failure indicators after reconnect
---

# Execution activity

Open **Activity** in Harness Gateway, or run:

```sh
gateway activity --json --config /absolute/path/gateway.json
```

The report belongs to **this execution machine**, not every connected computer.
For a server, run the command there over SSH or open its Gateway app. A
client-only inference configuration does not make remote execution local.
The default native home is the user's `.codex`, not an agent's inherited
private `CODEX_HOME`. Use `--native-home /absolute/home` for a custom home.

```text
Existing service-owned SDKs + saved SDK history
  → short, ownership-verified read connections
  → Gateway Activity: running / waiting / completed / failed / interrupted / unknown

Private Gateway terminal telemetry (last 24 hours)
  → recorded outcome, with its observation time
  → current state remains unknown until verified with the SDK
```

A state describes a **sampled turn**, not completion of an entire requested
objective or goal. `notLoaded` alone never means done. Active SDK status takes
precedence over an older terminal turn. Metadata is rechecked after history;
an observed history change without verified running status becomes unknown.
An active turn waiting for approval or user input is explicitly **waiting**;
the report does not imply it can continue unattended or answer it automatically.
Socket replacement, conflicting owners, unavailable history and timeout do not
manufacture a successful or failed outcome.

The report is a bounded snapshot, not a complete audit. It checks at most 16
existing SDK sources and four loaded-list pages per source, samples up to 64
chats and displays up to 32. Recent saved chats, loaded chats and recorded
outcomes are candidates. Larger or incomplete enumerations are marked explicitly.
The complete operation has a five-second deadline. Each SDK request has a
two-second deadline. Cancellation closes only the observer's borrowed sockets.
No engine is started, no chat is resumed and no callback is answered.

The Activity screen refreshes every 15 seconds **only while mounted**. Snapshots
older than 30 seconds are labelled expired and cannot keep a live-looking
running badge. Changing configuration clears the previous host's report;
cancelled or superseded requests cannot restore it. Failed refreshes clear the
report instead of presenting old data as current. No LaunchAgent, notification
daemon, scheduler or new background job is installed.

The fallback reads at most the last 2 MiB of each of today's and yesterday's
private telemetry files, retaining at most 100 threads within 24 hours. Only
thread/turn IDs, fixed status/error classes and timestamps survive projection.
Messages, arguments, prompts and credentials are neither returned nor logged.
An observation timestamp is not invented as the turn's completion timestamp.

## Managed worker models

For an observed SDK chat using an internal managed worker alias, Activity reads
its existing private route pin and shows the selected model/account alias. The
JSON row includes `requestedModel` and `providerId`; the app and CLI show the
internal policy followed by the selected model. This is a read-only display:
it never selects a provider, creates a pin, changes the saved chat model or
restarts a worker. Missing pins leave the policy label unchanged. Unsafe pins
produce partial coverage without guessing a model. A pin describes the worker's
binding; the separately sampled SDK state still determines whether it is running.
The selected-model projection uses this inference host's local pin store. A
client-only execution host using remote inference cannot read those remote pins
and retains the policy label instead.

## Boundary

This is a **Harness Gateway feature**, not a patch for Codex's own unread dots.
Codex apps, signatures, profiles, settings, permissions and read receipts remain
untouched. Activity never replays a completion notification, inference request,
tool action or approval. The existing shared executor remains responsible for
work while a viewing laptop sleeps.

## Verification

```sh
npm run build
node scripts/run-tests.mjs dist/tests/activity.test.js
npm run app:test
node scripts/e2e-chat-state.mjs --package /absolute/verified/package \
  --root /tmp/task-specific-activity --activity
```

The real-SDK fixture verifies running and completed snapshots, disconnects both
application clients before a synthetic provider failure, then requires that
Gateway Activity expose that saved failure and retain it on refresh. It verifies
no extra inference and unchanged native configuration. No paid inference or
production chat is used. Rendered-window and actual laptop-sleep verification
are separate from these protocol and model tests.
