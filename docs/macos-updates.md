---
summary: 'Daily signed macOS app updates from the private GitHub release.'
read_when:
  - Changing the macOS app updater or app release assets
  - Investigating an unavailable, deferred, or rolled-back app update
---

# macOS app updates

The installed app checks the private `app-vVERSION` GitHub releases daily. It
needs existing GitHub authentication that can read `edihasaj/harness-gateway`;
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

The updater checks the asset hashes, app metadata, and signed in-bundle
`update-policy.json` before activation. The policy binds the app to the exact
backend archive version, production commit, and SHA-256. It refuses missing,
partial, modified, or mismatched assets.

Activation waits until every app window has closed. It does not stop or replace
the existing managed gateway service, and active chats and jobs continue on the
already installed CLI release. Opening the app before an update is ready keeps
the current bundle active.

The previous app bundle remains available after activation. If the new bundle
cannot launch or pass its verification, the updater restores that retained
bundle and leaves the gateway installation and its configuration alone.

## Release availability

The updater sees an app release only after its draft assets have all uploaded,
their GitHub-reported sizes and SHA-256 digests match local files, and the draft
is published. App releases are private. GitHub authentication is therefore a
deployment prerequisite, not an app setup flow.

Use the local production release command described in
[Release](RELEASING.md#macos-app-distribution). It does not dispatch, enable, or
rerun GitHub Actions. Follow the [CI cost policy](ci-cost-policy.md): hosted
native work stays off unless Edi explicitly requests its separate paid,
production-only workflow.
