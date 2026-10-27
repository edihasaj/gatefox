---
summary: 'Install the native fox app and manage the gateway using its existing settings.'
read_when:
  - Installing or changing the native macOS app
  - Changing app configuration discovery, setup, status, or packaging
---

# Harness Gateway for macOS

The native app sets up and manages gateway connections. It
uses the same accounts, model routes, background service, and desktop registration
as the command line. The fox appears in its window and Dock icon.

On first launch, the app finds the configuration named by the managed gateway
LaunchAgent. If there is none, it looks in
`~/Library/Application Support/Subscription Gateway/gateway.json`. Settings lets
you choose a different existing JSON file. The app remembers that path locally;
it does not copy your provider registrations or change your model choices.

Open **Add connection** to connect an account, API, or local server and choose
its models. An unconfigured Mac opens this wizard automatically. Existing
configurations open directly in the dashboard. See
[setup and connection management](app-management.md) for account and model behavior.

Connections identifies whether this Mac hosts its own providers or consumes a
shared gateway. Hosts edit their local connections and selected models. Pure
shared clients show the serving hostname and a read-only catalog, with retry
when the gateway cannot be reached. SSH chats use their remote Mac's gateway;
installing the control panel does not copy connections between Macs.

The wizard and connection editors share the same field styling, with matching
text and secure-entry insets, a visible focus border, and a minimum height aligned
with the action buttons. Manual model fields expand to fit multiple lines.

Select **Set up once** to enable missing background service and desktop
registration. A running service is preserved. Setup refuses a different service
configuration or a pending login migration rather than taking over either.
Closing or quitting the control panel leaves the gateway running. Its managed
service and desktop registration return at login.
Closing the last window exits the control panel after its pending setup cleanup.
A signed app can associate the existing startup item with the app's name and fox
icon without restarting it. See [background identity](macos-background-item.md)
for signing, staging, and macOS display-refresh behavior.

The overview checks the real loopback health endpoint, the background service,
and desktop registration separately, refreshing every thirty seconds while the
window is open. Provider rows show configured routes and
model counts; they do not claim a working provider login. Use `gateway doctor`
to check those registrations.

**Diagnostics** shows this Mac's per-model cache use, Copilot session rebuilds,
provider failures and reconnect signals over a selected time window. Missing
usage is displayed as unreported, and older generic failures stay generic. See
[diagnostics](diagnostics.md) for coverage and privacy limits.

The wizard opens browser sign-in and reports missing provider prerequisites.
Claude and Copilot subscriptions need their official CLIs. The bundled runtime
supports API and local-server setup without a separate Node installation.

## Build and install locally

Use an Apple Silicon Mac with Xcode and a verified extracted
gateway release. The app uses only Apple frameworks and adds no dependencies.

```sh
npm run build
npm run check
npm test
npm run app:test
npm run app:build -- --backend /absolute/path/to/extracted-gateway-release --install-local
open "$HOME/Applications/Harness Gateway.app"
```

If `--backend` is omitted, the builder uses the current installed gateway release
under `~/.local/share/subscription-gateway/current`. It verifies every payload
file against its checksum manifest, rejects symlinks and unlisted payload files,
and copies only the release payload. The bundled Node license and all gateway
component license files travel with it. Account files and local configuration
are outside that payload.

The result is a `.app` and a ZIP under `.state/macos-app/build-*/`. The ZIP can be
extracted and the app moved to Applications. `--install-local` installs a new
copy in `~/Applications`; it refuses an existing app. Quit an earlier copy and
move it to Trash before replacing it.

The app prefers the existing managed `~/.local/bin/gateway` command. Its bundled
release is used for setup when the command is missing. Packaging an app does not
upgrade an existing CLI, change its service ownership, or migrate remote hosts.
The app build receipt records the app and backend versions separately.

Local builds are not signed for distribution or notarized. Use `npm run app:sign`
with the same Developer ID team on every update. It signs the app, helpers, and
an app-owned Node derivative with fixed identifiers and the Automation entitlement.
The service then runs installed gateway code through that stable bundled runtime.
See [Node and tool permissions](macos-background-item.md#node-and-tool-permissions)
for initial approvals and verification limits. Before distributing downloads,
notarize and staple the complete app and verify Gatekeeper on another Mac.
Do not re-sign the Codex desktop app.

## Updates

Signed production builds publish through a private GitHub app release. The app
checks daily, waits for its GUI to close before activation, preserves the
existing gateway service and active work, and retains the prior bundle for
rollback. See [macOS app updates](macos-updates.md).

## Development checks

`npm run app:test` runs native configuration/status/process checks and the
packaging manifest checks. It uses the installed Xcode developer directory when
`DEVELOPER_DIR` is unset, because Command Line Tools alone omit XCTest.
The bundle builder uses the same selection because current SwiftUI state macros
also require the Xcode toolchain.
Use `swift build --package-path native/macos` to
compile the app without making a bundle.

For real desktop verification, launch the installed app, inspect Overview and
Settings, quit, and relaunch. Check that the selected path persists and that the
gateway service PID survives closing the app. Exercise setup only against an
isolated fixture or an explicitly intended installation. Never stop live chats
to verify the control panel.

## Local verification record

On October 18, 2026, the Apple Silicon bundle installed and launched locally.
The app's actual configuration/status code reported two providers, twenty models,
a healthy gateway, an active service, and desktop registration ready. The
configuration digest and service PID stayed unchanged after quitting and
relaunching the control panel. Fifteen native checks, six packaging checks, and
the 1,172-test gateway suite passed.

The desktop was locked during capture. Shotport's app capture and frontmost-window
retry both failed with ScreenCaptureKit error `-3811`, so the rendered Overview,
Settings navigation, and Dock appearance still need an unlocked-screen check.
The local app and ZIP are not signed or notarized for distribution.

The same verified bundle was also installed over SSH on the MacBook that day.
Its existing three providers and twenty-one models reported ready. The rendered
Overview, fox logo, Settings page, Refresh shortcut, and quit/relaunch were
checked on its unlocked desktop. Its configuration digest and gateway service
PID stayed unchanged throughout installation and relaunch.
