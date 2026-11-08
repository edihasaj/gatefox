---
summary: 'Daily signed macOS app updates from the private GitHub release.'
read_when:
  - Changing the macOS app updater or app release assets
  - Investigating an unavailable, deferred, or rolled-back app update
---

# macOS app updates

The installed app checks the `app-vVERSION` GitHub releases daily. It
uses the GitHub CLI's existing login to read `edihasaj/harness-gateway`, the
repository's former name, which GitHub redirects to `edihasaj/gatefox`;
the updater never asks for, stores, or prints a token. A release provides one
notarized app ZIP, its matching gateway backend archive, `app-update.json`, and
`SHA256SUMS`.

```text
private GitHub draft → signed ZIP + signed policy → daily check
                                               ↓
                                    checksum and receipt validation
                                               ↓
                             wait for every app window to close
                                               ↓
                           activate retained bundle / preserve CLI service
```

The updater downloads both the matching canonical CLI archive and signed app ZIP.
It checks their hashes, app metadata, and signed in-bundle `update-policy.json`
before activation. The policy binds the app to the exact backend archive version,
production commit, and SHA-256. It refuses missing, partial, modified, or
mismatched assets.

Activation waits until every app window has closed. It preserves active chats and
jobs: processes already loaded from the earlier CLI release continue, then adopt
the installed CLI release through their normal idle-update protocol. Opening the
app before an update is ready keeps the current bundle active.

The updater retains the previous app bundle for transaction rollback. A failed
installation transaction restores that retained bundle; it does not claim to
detect or roll back a later launch failure. The gateway configuration remains
unchanged.

After a successful installation is acknowledged and its transaction journal is
finalized, the updater removes that update's downloaded ZIP, backend archive and
extracted staging files. It only cleans the exact owned `app-update-<uuid>` folder
whose manifest, archive digest and tree match the completed update. Pending,
foreign, changed, linked or in-use installation paths are never guessed at.
The retained rollback app bundle and installed current/previous releases stay.
Cleanup failure does not undo or misreport an otherwise successful update.

Recovery restores only files that still match the transaction's publication
receipts. It preserves concurrent changes. A forced termination can leave an
unknown installation lock, which the updater will not break automatically.
After confirming that no installer or updater remains, move only the stale
`.gateway-installation-lock` directory in the installation root to Trash before
retrying.

Update transactions skip the installer's release pruning, so the same cleanup then
runs after the update is finalized (`src/app-updates/retention.ts`). It keeps the
current and previous releases, the newest other release, and any release a running
process or saved service plan refers to. It also removes gateway generations beyond
the newest 12 that are at least three days old and unreferenced. Both come back from
a release download or the next engine start. An incomplete inventory, or a process
running through `current` whose source release cannot be identified, prevents all of
this; so does an open update transaction.

The CLI installer bounds each process/open-file inventory at 64 MiB so busy Macs
can complete the release-retention check. A timeout, overflow or incomplete scan
still prevents pruning; it never establishes that an old release is unused.

## Release availability

The updater sees an app release only after its draft assets have all uploaded,
their GitHub-reported sizes and SHA-256 digests match local files, and the draft
is published. App releases are private. GitHub authentication is therefore a
deployment prerequisite, not an app setup flow.

Use the local production release command described in
[Release](RELEASING.md#macos-app-distribution). It does not dispatch, enable, or
rerun GitHub Actions. Follow the [CI cost policy](ci-cost-policy.md): hosted
native work stays off unless Edi explicitly requests its separate paid,
production-only workflow. Before the release is uploaded, that command runs the
updater fixture against an existing signed app and installed CLI release in a
fresh private fixture directory; no live service is changed.

## Desktop verification limits

The October 18 inspection found one gateway startup job on Studio and MacBook.
MacBook's Login Items panel still displayed two enabled GateFox rows.
Reading the records behind those rows required administrator authorization, so
their exact cause remains unverified. No background-item reset or service
restart was used to clear the display.

Existing services keep their loaded runtime until their normal idle upgrade.
Matching signing requirements and passing isolated runtime checks do not prove
that a macOS privacy grant survives an app update. That check still needs an
existing approved action on an unlocked Mac; no privacy grants were reset or
automatically accepted during verification.
