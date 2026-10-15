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
`gateway desktop unregister` remove a value of `1` from the login session only
when it is provably the gateway's. The session's `CODEX_CLI_PATH` proves the pair
when it names a gateway wrapper:

| Command | `CODEX_CLI_PATH` must equal |
| --- | --- |
| `gateway desktop register` | the receipt's wrapper, the wrapper this registration installs, or an older wrapper in this gateway's state directory |
| `gateway desktop unregister` | the receipt's wrapper or an older wrapper in this gateway's state directory |
| `gateway desktop status` (`legacyForceCli`) | the receipt's wrapper or an older wrapper in this gateway's state directory |

The last row is the common upgrade case: newer code writes a wrapper with a new
content hash, the receipt names that one, and the login session still holds the
older wrapper the previous registration set. A path counts as such a wrapper only
when it resolves to a file directly inside this gateway's configured state
directory whose name is exactly `desktop-wrapper-` plus 16 lowercase hex digits.
A look-alike — the same name in another directory, a name with a suffix, or a
shorter or non-hex suffix — stays foreign. Registration refuses a foreign value
(including a `1` without that proof) instead of replacing it, unregister leaves it
alone, and registration never deletes a stale wrapper file. `gateway desktop
register` additionally requires the receipt to exist beside an owned path: a
wrapper path with no receipt is not proof that a gateway exported the pair. `gateway desktop` only leaves an
inherited `1` out of the app it launches, and only when the inherited
`CODEX_CLI_PATH` is a gateway wrapper; it does not change the login session, so
later Dock launches still see it. `gateway desktop status` reports
`legacyForceCli: true` while a value that is ours is still set.

After installing a release that stops setting it, clear the old value first, then
restart the app:

1. Run `gateway desktop register`. This works for both the unified service and a
   standalone desktop LaunchAgent. Do not wait for the unified service to clear it
   on its own: the supervisor moves to a new release only when it is fully idle,
   with no app connected and no chat loaded (see `docs/RELEASING.md`), so it never
   restarts while ChatGPT stays open. Quitting ChatGPT lets it go idle and restart,
   and a standalone LaunchAgent also clears it at the next login.
2. Run `gateway desktop status` and confirm `legacyForceCli: false`.
3. Quit and reopen ChatGPT once. Reopening earlier keeps the old behavior,
   including the repeated "409 Remote app server already online" errors.
