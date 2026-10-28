---
summary: 'Guarded, version-pinned client candidate for offline unread receipts; not installed or window-verified.'
read_when:
  - Investigating missing blue unread dots after laptop sleep or remote chat completion
  - Testing the experimental desktop unread receipt bridge
---

# Offline unread dots: guarded client candidate

**This is an experiment, not an installed fix.** The scripts only produce
renderer bytes in memory; the optional preparation script saves those assets and
their original bytes under `/tmp`. They do not copy, modify, sign, install, or
launch an application. They are not part of the gateway release package.

## Observed cause

With shared gateway execution, a synthetic turn completed while the reader was
disconnected. A fresh reader received the completed chat as idle and received
its durable unread receipt in the top-level `thread/list.readStates` map.
`thread/read.readState` agreed. The check also passed with the installed native
engine handling the native list. No paid inference or production chat was used.

The desktop renderer in app version `26.1021.31345` does not consume those
receipts. Its unread boolean normally changes on a live completion event, which
the disconnected reader missed. Restarting the gateway cannot repair that
client-side state.

```text
Remote SDK finishes → durable unread receipt exists
Laptop reconnects  → list contains receipt
Current renderer   → ignores receipt → no blue dot
Prototype bridge   → consumes receipt → existing unread store
```

### Sleep/wake diagnosis against the installed client

On October 28, the installed Studio and MacBook renderers both matched the exact
`26.1021.31345` asset hash below. The stock list paginator (`ptn` in this pinned
asset) appends only each reply's `data` rows and returns that array. It discards
the accompanying `readStates` map. The store's `getThreadHasUnreadTurn` checks the
saved local value first, so a saved `false` continues to hide attention after a
completion that happened while the client was disconnected.

`codex-unread-wake-diagnosis.test.mjs` executes those two extracted stock
functions in memory and reproduces the missing dot from a valid offline unread
receipt. Wrapping that same request with the uninstalled bridge restores the
stock getter without replaying a terminal or acknowledging a read. The separate
stock automatic-read regression still reproduces the earlier stuck-dot race.
These checks isolate the client-state failure; they do not simulate physical
sleep or verify a rendered application window.

The earlier replay attempt was introduced in `d5e3130`, made device-specific in
`0f7b6f5`, and disconnected from stock resume in `93afa8c`. The guarded client
candidate in `5f94e85` remains uninstalled. No app, running process or receipt
was changed to perform the October 28 diagnosis.

A read-only comparison also found eight of ten sampled SDK-unread chat IDs absent
from the MacBook's saved Studio-host unread set. The client does not acknowledge
those SDK receipts, so this mismatch can include chats already read locally; it
does not prove that all eight contain unseen work. The current candidate preserves
each native choice on first observation and reconciles subsequent revision changes.
It cannot retrospectively classify that ambiguous, pre-installation attention.

Replaying arbitrary old completion events is not a safe substitute. The renderer
has no general completion-ID deduplication before unread and notification side
effects; replay could mark an already-read chat unread or repeat an alert. The
gateway retains its bounded private ledger for a future explicit client contract,
but stock adapters do not query for or replay a historical terminal on resume.
Passive gateway observers remain status-only, and offline completion therefore
does not currently guarantee a stock unread dot.

## Prototype boundary

`scripts/codex-unread-trial/patch.mjs` locates the manager and notification
dispatcher structurally. Its paired entry point requires the exact app version
and both renderer and conversation-chunk SHA-256 hashes. Missing, changed,
ambiguous, or already-patched hooks are rejected. Tests execute independent
fixtures and the extracted, patched stock automatic-read function in a simulated
native scope. This is not execution in an actual application window.

The bridge imports SDK receipts into both the existing unread store and the
manager's loaded-row state. It acknowledges the manager's semantic read/unread
actions using the receipt's opaque revision; ordinary cache and terminal
store writes never send an acknowledgement. It serializes newer actions and
rejects stale snapshots without blindly retrying a read conflict. Each metadata map retains
at most 200 threads. Eviction conservatively rejects old in-flight snapshots
until a later refresh. Missing or malformed receipts retain legacy behavior.
It does not invent turns, execute tools, or change inference or permissions.

## Durable migration and wake reconciliation

The paired candidate journals receipt revisions in IndexedDB. Its scope is a
SHA-256 hash of the native durable account identity and execution-host token,
obtained through the native facade's own lifecycle guard. Host display names and
random manager generations are never persistence identities. The account-unaware
legacy facade, missing WebCrypto/IndexedDB, storage failure, or a retired scope
leaves the native behavior in place.

| Observation | Local projection |
| --- | --- |
| First receipt for an existing chat | Preserve the native read/unread choice; save its revision without sending an ACK. |
| Same revision after reload or wake | Use the saved projection. |
| Later SDK revision | Reconcile its unread state, including completions missed while disconnected. |
| Successful durable start/fork | Register a fresh chat so its first completion is not treated as legacy history. |
| Semantic read/unread already satisfied by the SDK | Persist the explicit local choice without an unnecessary SDK mutation. |

**Migration limit:** the native ready facade returns `false` for any ID absent
from its unread set, including a chat it has never seen. SDK unread alone cannot
distinguish a previously read chat from a new chat created elsewhere. A first-seen
chat created on another device therefore also keeps that native choice; its next
receipt revision reconciles normally. Only a start/fork response witnessed by
this client establishes a safe fresh baseline. A complete cross-device rollout
needs an explicit initial catalog/migration contract; this candidate does not
guess creation times or claim to repair that ambiguity.

Each scope retains up to 10,000 chat checkpoints. Capacity failure preserves
native behavior instead of evicting unseen attention. Successful deletes remove
the chat's checkpoint. Rows contain only a scope hash, chat ID, opaque revision,
boolean, and journal sequence; account identities and message content are not
stored in this database.

A shared transactional sequence is captured before metadata requests. A delayed
reply cannot replace a newer checkpoint written by another window. Push events
request fresh metadata rather than trusting their arrival order. Local action
generations abort pending IndexedDB projections that race with a read/unread action,
including their disk writes. Failed explicit no-op choices remain bound to their
captured revision until a later action or refresh retries them. They never retarget
a read onto newer attention. Persistence
operations have a two-second deadline and cannot fail the caller's successful SDK
response. Historical completion events are never replayed.

## Guarded automatic read

The stock hook deduplicates reads by request ID, last turn ID/status, and a
native signal. An offline receipt can arrive after that hook already ran.
Replaying completion events can restore the dot without changing those dedup
keys. Merely adding the receipt revision is unsafe too: first unread can remain
A while a newer, unseen B changes the revision.

The paired candidate requires a stable receipt, a matching latest terminal turn
with fully loaded items, and a still-focused, mounted chat on the same
host before invoking the stock semantic read. Its acknowledgement uses the
captured revision, never a blindly retargeted conflict revision. Every newer
SDK attention publication changes that revision, even if first unread stays
the same (`publish_thread_attention` in the pinned SDK state runtime).

```text
Capture receipt R + action/history generations
  → query latest SDK turn
  → await native loaded-history capability; copy ID/status/completeness; dispose it
  → metadata-only thread/read must still report R
  → recheck generations, focus, mounted chat, host, and matching terminal history
  → call stock semantic read without another await → CAS acknowledgement of R
```

When no valid receipt is known, the original local-only read behavior remains.
An unknown-revision read never queues a durable acknowledgement. A later receipt
can restore attention and trigger guarded reconciliation.

Native history invalidation (`K2n`, keyed by conversation ID in this pinned
renderer) and receipt subscriptions permit retry after hydration. Failed proofs
do not consume a revision. The hook coalesces evaluations, retires probes on
unmount, and expires their commit authority after five seconds. Raw validation
RPCs do not ingest receipts or invalidate their own action epoch. Old same-host
managers are disposed before installing successor wrappers.

Manual unread before the first receipt remains pending and requests metadata
for its CAS. It must become `threadStart`; an existing turn-based unread receipt
does not satisfy manual intent. Transport failure retains that intent until a
later refresh or explicit action retries it.

The native latest turn retains its item-pagination proof even when older thread
pages are absent. The candidate accepts that turn only when its oldest item page
is loaded, its older cursor is exhausted, and it is neither loading, evicted,
nor reconnecting. The latest SDK turn ID/status must still match. This permits a
read in a long chat without fetching every older turn. Missing or partial latest
items retain the dot. Selection, summary metadata, or `thread/resume` alone never
prove reading. Native-window lifecycle verification remains required.

Prepare paired assets and a rollback manifest without touching an app:

```sh
node scripts/codex-unread-trial/prepare.mjs /Applications/ChatGPT.app
```

The printed `/tmp/hg-unread-candidate-*/manifest.json` records source and asset
hashes, checkpoint migration/scoping, and the uninstalled/unverified status. An app update invalidates the pins
and refuses preparation. Rollback from an authorized trial is to discard its
disposable app copy; the original signed application remains unchanged.

An actual window test is still required before claiming the blue dot works.
Applying the prototype to a disposable ChatGPT/Codex app copy would require
explicit authorization for that app's signing and identity changes. Prior
Claude trial authorization does not authorize modifying ChatGPT. The installed
application must remain untouched without that authorization.

Run the isolated regression tests with:

```sh
node --test scripts/claude-desktop-tests/codex-unread-*.test.mjs \
  scripts/claude-desktop-tests/codex-read-state-bridge.test.mjs
```

Run the real-IndexedDB checks with `abx` installed:

```sh
node scripts/codex-unread-trial/verify-checkpoints.mjs
```

This creates its own localhost origin and isolated `BROWSE_STATE_FILE` under
`/tmp/hg-checkpoint-browser-*`, then stops only that browser daemon. It does not
connect to ChatGPT or the gateway. Checks cover first-sync choices, new chats,
semantic read persistence, account/host isolation, retired scopes, capacity and
storage errors, document reload, and stale/concurrent replies from separate
same-origin documents with real IndexedDB connections. Its `report.json` records
only synthetic test results. These checks do not reproduce physical Mac sleep
or verify the installed app's rendered dot, and they do not change the mobile client.

The existing synthetic chat-state fixture also has an optional `--unread`
check. It acknowledges an initial receipt, disconnects the reader, completes
another turn, reconnects, and checks both restored unread state and an explicit
durable read acknowledgement. It also rejects a guarded read from the older
transcript before allowing a matching hydrated view. It asserts that no
completion was replayed and that a later refresh stays read. Its store and
loaded-history view are synthetic facades, so this still
does not verify a native window dot.

```sh
node scripts/e2e-chat-state.mjs --package /path/to/verified/package \
  --root /tmp/task-specific-evidence --unread \
  --native-engine /path/to/original/native/codex
```

`--native-engine` changes only the fixture's native-side engine. The verified
gateway SDK still owns gateway inference. All chat homes, synthetic responses,
and gateway configuration remain isolated under `/tmp`.

On October 25, 2026, the earlier isolated check passed with the original installed native
engine and the verified gateway SDK: three synthetic turns, zero paid inference,
offline receipt imported, explicit read persisted, subsequent refresh stayed
read, and zero replayed terminal events. The 23 focused bridge, structural-hook,
and race checks also passed. These are protocol and synthetic client checks,
not evidence of a working dot in the installed window.

The final source check, build, and full test suites passed on an isolated
snapshot containing only this experiment: 3,327 core tests and 116 desktop tests
passed, with two optional skips. Unrelated in-progress API-mode changes in the
shared checkout were excluded from that snapshot. Those results describe the
earlier prototype, not this candidate's native-window readiness.

On October 26, 2026, the guarded real-SDK fixture passed with three synthetic
turns and zero paid requests: offline receipt restored, older transcript refused,
matching hydrated view acknowledged durably, refresh stayed read, and zero
replayed completions. Regressions also cover unchanged-first-unread supersession,
pending manual unread, stale manager overlap, invalidated proofs, and close/reopen
of the same chat. The build and type check passed; 3,485 core tests and 144
desktop tests passed, with two optional skips and no failures. Native-window
verification remains pending.

On October 28, 2026, the migration/checkpoint candidate passed build, type check,
3,557 core tests and 160 desktop tests, with two optional skips and no failures.
Ten real-browser IndexedDB checks passed, including transaction rollback after a
semantic read during first-sync writes, separate-document concurrency and reload.
Independent review found and verified corrections for the first-sync disk race,
failed/duplicate no-op choices, and stale cross-window choice revisions. The
real-SDK fixture also passed with three synthetic requests, zero paid inference,
and zero replayed completions; that protocol fixture uses a synthetic store and
does not exercise IndexedDB. The candidate remains local and uninstalled. Mobile,
physical sleep/wake, and native-window verification remain outside this evidence.
