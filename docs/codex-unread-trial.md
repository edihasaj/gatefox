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

## Guarded automatic read

The stock hook deduplicates reads by request ID, last turn ID/status, and a
native signal. An offline receipt can arrive after that hook already ran.
Replaying completion events can restore the dot without changing those dedup
keys. Merely adding the receipt revision is unsafe too: first unread can remain
A while a newer, unseen B changes the revision.

The paired candidate requires a stable receipt, a matching latest terminal turn
in fully loaded native history, and a still-focused, mounted chat on the same
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

**Conservative limitation:** native `isComplete` requires complete history and
item pagination. A long, partially loaded chat may retain its dot until full
hydration. Selection, summary metadata, or `thread/resume` alone never prove
reading. This candidate is not yet a complete solution for every paginated
native-window lifecycle.

Prepare paired assets and a rollback manifest without touching an app:

```sh
node scripts/codex-unread-trial/prepare.mjs /Applications/ChatGPT.app
```

The printed `/tmp/hg-unread-candidate-*/manifest.json` records source and asset
hashes and the uninstalled/unverified status. An app update invalidates the pins
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
