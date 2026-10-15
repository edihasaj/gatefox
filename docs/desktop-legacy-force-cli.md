---
summary: 'How the gateway removes the CODEX_APP_SERVER_FORCE_CLI value older releases exported.'
read_when:
  - Upgrading a Mac from a gateway release that exported CODEX_APP_SERVER_FORCE_CLI
  - Debugging durable chats or SSH rows that run as local app-servers, or repeated 409 remote-control errors
---

# Legacy FORCE_CLI cleanup

An older gateway also exported `CODEX_APP_SERVER_FORCE_CLI=1`, which pushed durable
chats and SSH rows through the adapter as extra local app-servers. Registration,
including the unified service's re-registration at start and the login agent, and
`gateway desktop unregister` remove a value of `1` from the login session only when it is provably the
gateway's. Two things prove it, and every command needs both: the registration receipt must name a wrapper,
and the session's `CODEX_CLI_PATH` must name a gateway wrapper.

| Command | Receipt | `CODEX_CLI_PATH` must equal |
| --- | --- | --- |
| `gateway desktop register` | names a wrapper | the receipt's wrapper, the wrapper this registration installs, or an older wrapper in this gateway's state directory |
| `gateway desktop unregister` | names a wrapper | the receipt's wrapper or an older wrapper in this gateway's state directory |
| `gateway desktop status` (`legacyForceCli`) | names a wrapper | the receipt's wrapper or an older wrapper in this gateway's state directory |

The older-wrapper case is the common upgrade case: newer code writes a wrapper with a new content hash, the
receipt names that one, and the login session still holds the older wrapper the previous registration set.
A path counts as such a wrapper only when it is an absolute, normalised path naming a regular file owned by
you, or a missing entry, directly in the gateway state directory, whose name is exactly `desktop-wrapper-`
plus 16 lowercase hex digits. A look-alike stays foreign: the same name in another directory or a
subdirectory of the state directory, a name with a suffix, a shorter, non-hex, or uppercase suffix, a path
that climbs back through `..` or ends in a slash, or a name held by a symlink or a directory. The
`gateway desktop` launcher runs the inherited `CODEX_CLI_PATH` through the same path test in
`src/desktop-wrapper-path.ts`, or accepts the exact wrapper it is about to launch, and stops there: it
never stats the entry, so an accepted name is proof enough for it. That check has one effect, which is to
drop a legacy `CODEX_APP_SERVER_FORCE_CLI=1` from the single app process the launcher starts; it changes
nothing in the login session. Registration refuses a foreign value instead of replacing it, unregister
leaves it alone, and registration never deletes a stale wrapper file. If a foreign `CODEX_CLI_PATH`
override blocks registration, run `launchctl unsetenv CODEX_CLI_PATH` and then register again.

The receipt requirement is what turns a missing receipt into a refusal rather than a guess. Where the
receipt was cleared or never written, a gateway wrapper path beside a `1` proves the path is ours but says
nothing about who exported the pair: `gateway desktop register` refuses with a message that names the
variable and the remedy, never a value, saying that `CODEX_APP_SERVER_FORCE_CLI` is set to the legacy
value, and `gateway desktop status` reports `legacyForceCli: false`. `gateway desktop unregister` still
clears an own `CODEX_CLI_PATH` there, because that path is ours whether or not the receipt survived, and it
leaves the `1` alone; when it does, it reports `legacyForceCliKept: true` so the cleared path and the kept
value show up in one output, and `gateway uninstall` passes that flag through. `gateway desktop status` also
reports `staleWrapper: true` while the session points at a wrapper of ours that the receipt no longer
names; that alone is not an active adapter, so `activeForFutureLaunches` stays `false` until a registration
writes the current wrapper. Alongside `legacyForceCli`, status reports `forceCliSet`, which reads the
variable with `launchctl getenv`, removes exactly one trailing newline, and counts it as set when anything
remains, so a whitespace-only value is set; it never carries the value itself. If `launchctl` cannot be run
or times out, register, unregister and status fail with that error rather than treating the variable as
unset, so `forceCliSet: false` is only ever reported on a successful read. `gateway desktop` only leaves an
inherited `1` out of the app it launches, and only when the inherited `CODEX_CLI_PATH` names a gateway
wrapper by that spelling test; it does not change the login session, so later Dock launches still see it.

After installing a release that stops setting it, clear the old value first, then
restart the app:

1. Run `gateway desktop register`. This works for both the unified service and a
   standalone desktop LaunchAgent. Do not wait for the unified service to clear it
   on its own: the supervisor moves to a new release only when it is fully idle,
   with no app connected and no chat loaded (see `docs/RELEASING.md`), so it never
   restarts while ChatGPT stays open. Quitting ChatGPT lets it go idle and restart,
   and a standalone LaunchAgent also clears it at the next login.
2. If registration refuses because no receipt proves the value, clear it yourself
   and register again: `launchctl unsetenv CODEX_APP_SERVER_FORCE_CLI`. That is
   the whole remedy for the missing-receipt case; nothing else in the gateway
   touches the value without a receipt naming a wrapper.
3. Run `gateway desktop status` and confirm `forceCliSet: false`, not only `legacyForceCli: false`.
   A value that is not ours also reads `legacyForceCli: false`, while `forceCliSet: false` is the proof
   that no `CODEX_APP_SERVER_FORCE_CLI` is left in the session at all.
4. Quit and reopen ChatGPT once. Reopening earlier keeps the old behavior,
   including the repeated "409 Remote app server already online" errors.
