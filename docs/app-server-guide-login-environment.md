---
summary: 'The login race that can start ChatGPT without the gateway, the managed login agent that closes it, and what desktop status reports about it.'
read_when:
  - ChatGPT starts at login without CODEX_CLI_PATH
  - Registering, rolling back or removing the desktop login environment agent
  - Reading gateway desktop status for the login environment or API mode
---

# Desktop login environment

Part of the [Codex app-server adapter](app-server.md), and a section of the
[native relay guide](app-server-guide-native-relay.md).

## The login environment agent

ChatGPT is a login item and can start before the unified service has set
`CODEX_CLI_PATH`. When that happens the app launches its own bundled engine and
runs without the gateway until it is restarted; this was seen on a Mac that
rebooted after a power outage.

**With the unified service (0.4.8 and later)** the gateway has one background item,
`harness-gateway`, and no separate agent. The service daemon closes the race itself:
its very first step, before consolidation, any wait, the network or any child, is
`/bin/launchctl setenv CODEX_CLI_PATH <registered wrapper>`. It runs only when
`desktop-registration.json` names this gateway's own wrapper (the same ownership proof
registration uses), the wrapper is executable, the release runtime exists, and the
login session holds no value or one of the gateway's own wrappers. A foreign override is
never replaced. A failure never stops the daemon: it records one
`desktop_env_preset_failed` event with a fixed `reason` (`read` or `setenv`, see
[diagnostics](diagnostics.md)), never a value or a path. The `desktop-restore` child that
runs at every service start no longer writes the agent; it removes a managed one that
0.4.7 left, so a 0.4.7 Mac loses the `harness-gateway-login-env` item at its first 0.4.8
start. A plist at that label without the gateway's marker is left alone and reported as
`unmanaged`.

## Standalone registration

**Standalone registration (no unified service and no pending login plan)** keeps the
agent described below. To close the race there, registration also writes a
small LaunchAgent, `com.edihasaj.subscription-gateway.desktop-env`. It runs one
command at login and exits. macOS names a background item after the program a
LaunchAgent runs, so the agent does not run `launchctl` directly (Login Items would
list "launchctl"). Its only program argument is a private script in the gateway
state directory, `harness-gateway-login-env`, which Login Items lists by that name:

```text
#!/bin/sh
# Managed by subscription-gateway desktop-env
exec /bin/launchctl setenv CODEX_CLI_PATH '<state>/desktop-wrapper-<hash>'
```

It has `RunAtLoad`, no `KeepAlive`, `LimitLoadToSessionType` `Aqua`, no node and no
other environment. The script names the stable registered wrapper in the gateway state
directory, never a release path, and registration refuses any other path; the wrapper
is single-quoted for the shell. The script (mode 700) and the plist (mode 600) are
private and written atomically, the script first, and the agent is bootstrapped into
`gui/<uid>` when written. An agent written by 0.4.5 or earlier ran `launchctl`
directly; registering again replaces it with the script form. A script at that
path without the gateway's marker is refused, like an unmanaged plist.
A standalone `gateway desktop register` writes or updates it, so it follows the
registration. A plist with that label that does not carry the gateway's marker is
refused, and nothing is changed (on the unified service path it is only reported).

Where the unified service owns the variable (the desktop component's `desktop-restore`,
or a registration while a unified or staged plan owns it) no agent is written, and
registration returns `envAgent: false` and `loginEnv: "service"`, plus `envAgentRemoved:
true` when it removed a 0.4.7 agent. A failure to remove the agent or an unmanaged plist at
its label is caught: registration keeps going, and the service records a
`desktop_env_agent_failed` event with a fixed `reason` (`other` or `unmanaged`, see
[diagnostics](diagnostics.md)), never the error text or a path. The next start tries
again. A hand-run `gateway desktop register` on such a Mac takes the same path and records
the event under the component `service`. Only on a Mac without a unified plan does a
hand-run `gateway desktop register` write the agent, fail loudly when it cannot, and
record no event.

The script sets nothing unless the gateway can still run: before the `launchctl setenv` it
checks that the registered wrapper is executable and that the installed release's
`package/dist/cli.js` exists, and otherwise exits 0. A login after the gateway was
uninstalled, or unregistered by an older release, therefore does not set the variable again.

## API mode

While API mode is on, none of these paths arms the adapter. `<state>/api-mode.json` is the
switch, so the daemon's first-step preset, the `desktop-restore` child and a hand-run
`gateway desktop register` all hold back: the first two skip and record one
`desktop_api_mode` event (`action: "preset"`, `outcome: "skipped"`) per process, and a
hand-run register refuses with "API mode is on; run gateway desktop api-mode off first".
Neither the registration receipt nor the service plan is changed by that, because API mode
only takes the variable out of the login session; `gateway desktop api-mode off` puts it
back through the same preset. See [API mode](api-mode.md).

## Rollback and removal

Rolling back to 0.4.5 or earlier: those releases do not know this agent, so their
`gateway desktop unregister` and `gateway uninstall` leave its plist and script behind. Before
running either, remove them: `launchctl bootout gui/$UID/com.edihasaj.subscription-gateway.desktop-env`,
then move `~/Library/LaunchAgents/com.edihasaj.subscription-gateway.desktop-env.plist` and
`<state>/harness-gateway-login-env` to the Trash. Even if you do not, the guard above stops
the script from setting the variable once the release is gone.

`gateway desktop unregister` and `gateway uninstall` boot the agent out and move its
script and plist to the Trash (the script only when it carries the gateway's marker),
before they clear the variable. The agent is not a service
component: consolidation does not collect or retire it.

## Checking login status

`gateway desktop status` reads `CODEX_CLI_PATH` from the login (GUI) domain: it
parses only that key from the `environment` block of `launchctl print gui/<uid>`,
and falls back to `launchctl getenv` only when the print fails. `launchctl getenv`
over SSH reads a different domain and reported `activeForFutureLaunches: false`
even when the login session held the right value. Status also reports
`envAgent: true` when the agent exists, is the gateway's, and its script sets the
registered wrapper. `loginEnv` says who sets the variable at login: `"service"` when a
unified service (or its pending login plan) exists, `"agent"` when the standalone agent
is in place, otherwise `"none"`. `forceCliSet` and `legacyForceCli` come from the same block: status keeps
only whether `CODEX_APP_SERVER_FORCE_CLI` is present and non-empty (and whether it is
`1`), never its value, and uses `launchctl getenv` for both variables only when the
print fails.
