---
summary: 'Plan for 1.8.0: replace every Subscription Gateway and Harness Gateway name with GateFox, including the stored provider ID, without breaking installed Macs or saved chats.'
read_when:
  - Working on the GateFox rename (1.8.0)
  - Changing a name that installed Macs, saved chats or the patched Codex SDK depend on
---

# The GateFox rename

Goal: no "Subscription Gateway", "subscription_gateway", "Harness Gateway" or
"harness-gateway" anywhere a person sees it, including the Codex error
"Model provider `subscription_gateway` not found". Installed Macs, saved chats and the
phone must keep working through the change.

## Why some names cannot just be replaced

A name in code can change in one commit. A name that is also **stored outside the
repository** needs a migration, because the running code, older releases still loaded
on a Mac, and saved data all look it up:

| Name today | Where it is stored | Count in running code |
| --- | --- | --- |
| Provider ID `subscription_gateway` | Every saved gateway chat (Codex SQLite and rollout files), each Mac's Codex config, the patched SDK (`LEGACY_GATEWAY_PROVIDER_ID`) | 10 in `src`, 6 in Rust patches |
| `HARNESS_GATEWAY_EXECUTOR` | Environment of every gateway executor; read by the patched SDK | 2 in `src`, 6 in Rust patches |
| `~/.local/share/subscription-gateway` | Install root: releases, `current`, launchers, app runtime link | ~10 |
| `~/Library/Application Support/Subscription Gateway` | Configuration, credentials, state, logs | 3 |
| `com.edihasaj.subscription-gateway*` | LaunchAgent labels and plists (service, tunnels, desktop) | ~10 |
| `Managed by subscription-gateway …` markers | Plists, launchers, receipts that prove ownership | ~20 |
| `Harness Gateway.app`, `com.edihasaj.harness-gateway.app` | App path and bundle ID (macOS permissions, Login Items, updater) | ~10 |
| `harness-gateway` command, package `@edihasaj/harness-gateway` | Launchers, installer and updater checks | ~70 |
| `Symbol.for("harness-gateway/…")` keys | In-process registries shared between an old and a new release during live takeover | ~12 |

## Plan

Two releases plus one data migration.

**1.8.0: new names, old names still read**

1. Provider ID: new chats are saved as `gatefox`. Every gateway executor registers
   both `gatefox` and `subscription_gateway`, so old chats keep opening and the
   "not found" error cannot appear. Display name: **GateFox**.
2. Rust SDK patches: `GATEFOX_EXECUTOR` replaces `HARNESS_GATEWAY_EXECUTOR` (both
   read for one release); the legacy provider list gains `gatefox`. This needs a fresh
   gateway SDK build and its compaction and queue tests (about 25 GiB, several hours).
3. Install root `~/.local/share/gatefox`, state folder
   `~/Library/Application Support/GateFox`. On the first idle service start, 1.8.0
   moves each folder and leaves a link at the old path, so a process still running an
   older release finds its files.
4. LaunchAgent labels `com.edihasaj.gatefox*`: the existing next-login consolidation
   swaps old for new jobs once, without stopping chats.
5. Ownership markers: read both spellings, write only the GateFox one.
6. Commands: `gatefox` is the primary launcher; `gateway` stays as the short name;
   `harness-gateway` and `subscription-gateway` remain as links for one release.
7. App: `GateFox.app` and `GateFox-VERSION-macos-arm64.zip`, published only as
   `v1.8.0`. 1.7.6 and later updaters accept these names. After the swap, 1.8.0 renames
   the app folder and rewrites the service path in one step.
8. Live-takeover keys (`Symbol.for`): 1.8.0 checks both keys, so an in-place takeover
   from 1.7.8 still works.

**Chat migration (in 1.8.0, run per Mac at an idle moment)**

`gatefox chats migrate` rewrites the provider of saved gateway chats from
`subscription_gateway` to `gatefox` in Codex's SQLite and rollout files, with a backup
and a dry run first. The gateway already writes these records for the `openai`
identity option, so the format is known. Native chats are never touched.

**1.8.1: remove the old names**

After every Mac reports `ready` on 1.8.0 and every chat is migrated: stop registering
`subscription_gateway`, remove the old-folder links, the old launchers, the old
markers and the old `Symbol.for` keys, and remove the Compatibility names section.

## Decision needed

- **Bundle ID** `com.edihasaj.harness-gateway.app`: changing it to
  `dev.gatefox.app` resets the app's Full Disk Access, Automation and Login Items
  approvals on every Mac (you approve them again once). Users never see the bundle ID.
  Keep it, or change it?

## Order of work

1. Every Mac `ready` on 1.7.8 (in progress).
2. Gateway SDK rebuild with the renamed patches, then the code changes above, tests
   for each migration (folders, labels, markers, provider alias, chat rewrite,
   takeover from 1.7.8).
3. Release 1.8.0, roll out one Mac at a time, `gateway rollout --verify` ready on each.
4. Migrate chats on each Mac; confirm none still name `subscription_gateway`.
5. Release 1.8.1.
