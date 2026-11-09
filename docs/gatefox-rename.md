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

**Chat migration (1.8.1, run per Mac while ChatGPT and the service are stopped)**

`gatefox chats migrate` (also `gateway chats migrate`) prints what it would change.
With `--apply` it moves saved chats from `subscription_gateway` to `gatefox`:

1. It refuses while ChatGPT, any Codex app-server or the GateFox service runs, and
   when `config.toml` has no `[model_providers.gatefox]` row.
2. For each chat it rewrites only the `model_provider` in the rollout's first
   (`session_meta`) line; every later byte stays identical. The engine keeps older
   rollouts compressed as `<recorded path>.zst`; those are rewritten through zstd. A
   rollout that changes during its rewrite is left alone and reported.
3. It copies `state_5.sqlite` (`VACUUM INTO state_5.sqlite.before-gatefox-chats-TIME`),
   then moves the `threads` rows in one transaction.

Rollouts change before the database, so running it again finishes an interrupted run.
A chat whose rollout no longer exists (its desktop generation was removed) only gets
its row moved; `paginated` chats keep their history in `thread_history_1.sqlite`.
`--revert` moves the chats back. Native chats are never touched. Both ids stay
registered, so a chat opens whichever id it carries.

**1.8.1: remove the old names**

After every Mac reports `ready` on 1.8.0 and every chat is migrated: stop registering
`subscription_gateway`, remove the old-folder links, the old launchers, the old
markers and the old `Symbol.for` keys, and remove the Compatibility names section.

## Progress (branch `codex/gatefox-1.8.0`)

| Step | State |
| --- | --- |
| Provider id `gatefox` for new chats, both ids registered, listed and guarded | Done: code, SDK patches (`gateway-executor-v4`), 4,303 core and 147 desktop tests, 33 SDK gate tests |
| Executor marker `GATEFOX_EXECUTOR` (old marker still set and read) | Done |
| Clients wait for the host to claim the native home after a restart (the Studio `native_owner_pending` race) | Done |
| Docs for the two ids (`harness-identity.md`, `app-server.md`, `RELEASING.md`, troubleshooting) | Done |
| End-to-end scripts: new chats expect `gatefox`, both markers stripped and checked; direct-SDK fixtures keep `subscription_gateway` as the old-chat coverage | Done (they run with the release package) |
| Configuration default: fresh installs use `GateFox/gateway.json` (`~/.config/gatefox` on Linux); a Mac with only the `Subscription Gateway` one keeps it until `gatefox migrate` (CLI, app, Claude Desktop adapter, probe script) | Done |
| Install root: fresh installs use `share/gatefox`; an existing `share/subscription-gateway` keeps updating in place (installer, signed service launcher, app runtime, uninstall, consolidation, desktop agent, scripts). The launcher also accepts the `gatefox` command and a `# Managed by gatefox installer` marker | Done |
| Moving an existing install root and state folder (`gatefox migrate`), LaunchAgent labels, writing the new ownership markers | After 1.8.0 (1.8.x): each touches every live service, and the old names keep working |
| `gatefox` command: a third managed launcher; update journals record it as optional, so a 1.7.x updater's journal still recovers, and the installer skips it under such a journal because that updater refuses unknown receipts | Done |
| `GateFox.app`: builds and release scripts emit the GateFox app and asset names; an app updated in place at `Harness Gateway.app` renames itself at launch and rebinds the service plist and app-runtime link (see `macos-updates.md`) | Done |
| `gatefox chats migrate`: dry run, `--apply`, `--revert`; rollouts (including `.zst`) then `state_5.sqlite` after a copy | Done (1.8.1) |
| Display names: Claude Desktop profile and sign-in agent are GateFox; a Harness Gateway profile is still selected | Done |
| Release build with a fresh SDK, rollout one Mac at a time | In progress |

The bundle ID stays `com.edihasaj.harness-gateway.app` unless Edi decides otherwise.

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
