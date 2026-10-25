---
summary: 'Isolated, version-pinned prototype for desktop unread dots after offline completion; not installed or released.'
read_when:
  - Investigating missing blue unread dots after laptop sleep or remote chat completion
  - Testing the experimental desktop unread receipt bridge
---

# Offline unread dots: client prototype

**This is an experiment, not an installed fix.** The scripts only produce
renderer bytes in memory. They do not copy, modify, sign, install, or launch an
application. They are not part of the gateway release package.

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

Replaying old completion events is not a safe substitute. The renderer has no
general completion-ID deduplication before unread and notification side effects;
replay could mark an already-read chat unread or repeat an alert. Passive
gateway observers must remain status-only.

## Prototype boundary

`scripts/codex-unread-trial/patch.mjs` locates the manager and notification
dispatcher structurally. Its pinned entry point requires the exact app version
and renderer SHA-256. Missing, changed, ambiguous, or already-patched hooks are
rejected. Independent synthetic fixtures are executed; installed vendor code is
only read and parsed in memory.

The bridge imports SDK receipts into both the existing unread store and the
manager's loaded-row state. It acknowledges the manager's semantic read/unread
actions using the receipt's opaque revision; ordinary cache and terminal
store writes never send an acknowledgement. It serializes newer actions and
rejects stale snapshots without replaying a conflict. Each metadata map retains
at most 200 threads. Eviction conservatively rejects old in-flight snapshots
until a later refresh. Missing or malformed receipts retain legacy behavior.
It does not invent turns, execute tools, or change inference or permissions.

An actual window test is still required before claiming the blue dot works.
Applying the prototype to a disposable ChatGPT/Codex app copy would require
explicit authorization for that app's signing and identity changes. Prior
Claude trial authorization does not authorize modifying ChatGPT. The installed
application must remain untouched without that authorization.

Run the isolated regression tests with:

```sh
node --test scripts/claude-desktop-tests/codex-unread-patch.test.mjs \
  scripts/claude-desktop-tests/codex-read-state-bridge.test.mjs \
  scripts/claude-desktop-tests/codex-unread-races.test.mjs
```

The existing synthetic chat-state fixture also has an optional `--unread`
check. It acknowledges an initial receipt, disconnects the reader, completes
another turn, reconnects, and checks both restored unread state and an explicit
durable read acknowledgement. It asserts that no completion was replayed and
that a later refresh stays read. The store is a synthetic facade, so this still
does not verify a native window dot.

```sh
node scripts/e2e-chat-state.mjs --package /path/to/verified/package \
  --root /tmp/task-specific-evidence --unread \
  --native-engine /path/to/original/native/codex
```

`--native-engine` changes only the fixture's native-side engine. The verified
gateway SDK still owns gateway inference. All chat homes, synthetic responses,
and gateway configuration remain isolated under `/tmp`.

On October 25, 2026, the isolated check passed with the original installed native
engine and the verified gateway SDK: three synthetic turns, zero paid inference,
offline receipt imported, explicit read persisted, subsequent refresh stayed
read, and zero replayed terminal events. The 23 focused bridge, structural-hook,
and race checks also passed. These are protocol and synthetic client checks,
not evidence of a working dot in the installed window.

The final source check, build, and full test suites passed on an isolated
snapshot containing only this experiment: 3,327 core tests and 116 desktop tests
passed, with two optional skips. Unrelated in-progress API-mode changes in the
shared checkout were excluded from that snapshot.
