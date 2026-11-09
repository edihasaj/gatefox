---
summary: 'Attribute the existing macOS gateway startup job to the signed fox app without restarting it.'
read_when:
  - Changing macOS Login Items, background attribution, or the signed service launcher
  - Signing or notarizing the native app
---

# One app identity in Login Items

GateFox uses one existing gateway LaunchAgent. A signed copy of the app
can associate that job with its name and fox icon. It does not register another
startup job or require its window to stay open.

Automatic latest-model polling belongs to this same service tree. It must not
add its own LaunchAgent or show a separate CLI-owned background item. Releases
after 0.8.7 retire that version's separate metadata job without changing the
signed app association, icon, inference process or current model selection.

```text
GateFox.app (Harness Gateway.app before 1.8.0)
  ├─ GatewayApp: settings window, exits when the last window closes
  └─ GatewayService: signed launcher
       └─ App-owned signed Node → current installed gateway service
            └─ The existing supervised components
```

Apple requires the startup executable and associated app to share a signing team.
The app therefore includes a small native launcher. The LaunchAgent's `Program`
names that launcher; its original `ProgramArguments`, label, environment, flags,
configuration, and logs stay intact. The launcher validates the installer-owned
command and runs its current installed JavaScript through the app's bundled Node.
It preserves the process ID, arguments, and working directory, sets the two
existing installer identity variables for that command, and puts its bundled
runtime directory first in `PATH`. The rest of the environment stays intact.

The app's background identity tool verifies the app, launcher, and Node signatures, the app bundle ID,
the exact owned registration, and the selected configuration. Under the existing
login-registration lock, it backs up the original plist and atomically adds only
`Program` and `AssociatedBundleIdentifiers`. A pending next-login migration,
unsafe file, changed registration, or conflicting association prevents an edit.
Unsigned development builds do not change the registration.

Under that same lock, the tool registers `app-runtime` in the existing CLI
installation and updates its owned command wrappers. They keep using installed
gateway code through the signed app runtime, including supervisor children and
MCP bridges. Original wrapper bytes join the private service backups. A wrapper
update takes effect on its next invocation; it does not replace a running process.
CLI installers preserve this app-runtime registration on later updates. A broken
registered app path fails with an actionable error instead of silently selecting
another Node identity.

The installer and app share an installation lock for the selected prefix. Both
managed command aliases retain the canonical `harness-gateway` command identity.
Runtime registration accepts only recognized installer templates belonging to
that prefix, including a user-owned custom prefix.

Runtime and plist publication share one rollback boundary. On failure, the app
restores only files that still match its own output; concurrent changes are
preserved along with any runtime dependencies they may need. Catchable termination
finishes rollback and releases the owned lock. `SIGKILL` cannot run cleanup: after
confirming that no installer or runtime publisher remains, move a leftover
`.gateway-installation-lock` directory to Trash before retrying. Unknown locks
are never broken automatically.

The app runs this check at launch and after setup. It uses its bundled management
runtime rather than an older installed CLI. The tool never unloads, enables,
bootstraps, signals, or restarts the live gateway. Its result describes the
registration for the **next service start**. macOS may keep an earlier name or
historical entry cached until the next login. A prepared plist is not proof that
the rendered Login Items list has refreshed.

Keep the installed app at its Applications path: the startup registration refers
to its launcher there. Quitting the settings window leaves the existing gateway
available. The **Open Login Items** button opens macOS's controls.

Do not use `sfltool resetbtm` to remove an old row. It resets background-item state
for unrelated applications too. Do not restart active local or remote chats to
refresh a name or icon.

New registrations prefer the managed `gatefox` command. Fresh installations use
`GateFox.app`, the `GateFox` configuration folder and `share/gatefox` install root.
Historical command aliases and ownership markers remain readable so existing
background registrations and rollback receipts continue working without a restart.

## Signing

Build a local app from a verified gateway release, then sign that build with a
Developer ID Application identity:

```sh
npm run app:build
npm run app:sign -- --app "/absolute/build/GateFox.app" \
  --identity DEVELOPER_ID_SHA1 --keychain /absolute/signing.keychain-db
```

The signing step creates an app-owned derivative of Node and signs the native
components under the same Developer ID team. It updates the bundled derivative's
component and checksum receipts and records their original hashes. It does not
change the canonical CLI release or the installed running engine. Signing and notarization are
separate outcomes; verify both before distributing a download.

The signing tool's help documents notarization and archive options. Credential
setup follows the shared Apple signing skill; never put a keychain password or
provider credential in a command argument.
When signing over SSH, unlock the keychain and sign in the same persistent
security session. A separate SSH session can report `errSecInternalComponent`
even while the keychain reports unlocked.

## Node and tool permissions

The app uses fixed signing identifiers across builds:

| Component | Signing identifier |
| --- | --- |
| App | `com.edihasaj.harness-gateway.app` |
| Service launcher | `com.edihasaj.harness-gateway.service` |
| Bundled Node | `com.edihasaj.harness-gateway.node` |

Keep the bundle identifier, signing team, and installed app path stable. A CLI
update changes the JavaScript under `current`, while the managed service uses
the Node executable inside that same app. A symlink to each release's Node would
still resolve to a different runtime path.
Tool children that resolve `node` through the inherited service `PATH` use that
same app runtime.

The service records its loaded JavaScript release in its status snapshot. The
watchdog matches that snapshot to the live service process before using it, so a
switch of `current` cannot relabel the service's code. This does not change the
signed runtime or managed launcher templates; older signed apps can still
recognize them for runtime association and updates.

The app and its signed helpers carry the Apple Events entitlement. The app's
Info.plist explains Automation and local-network use. Node retains the runtime
exceptions from the bundled official runtime, with the debug-only
`get-task-allow` entitlement removed. The attribution check verifies the app,
service launcher, and Node against their expected identifiers and signing team.

These declarations allow macOS to ask for consent; they do not grant consent.
Expect initial approvals when moving from a release-specific Node identity.
macOS chooses the responsible process for each permissioned action. An external
tool that establishes its own responsibility, or explicitly invokes a different
Node executable, can still have separate permissions. The gateway does not change
caller permissions, provider tool policy, or the signatures of other applications.

Verify an actual file, network, or Automation action before and after an update
on an unlocked Mac. Compare `codesign -d -r- --entitlements -` for the app-owned
runtime across builds. A successful signing check or Login Items association alone
does not prove that an existing TCC grant survived.

## Verification

Run the gateway build, type check, tests, and `npm run app:test`. The native gate
also exercises the service launcher's argument handling and signing-derivative
receipts. Verify a signed copy with `codesign --verify --deep --strict`, then
validate its notarization ticket and Gatekeeper assessment before distribution.
Run `node scripts/e2e-macos-runtime.mjs "/absolute/GateFox.app"` against
the signed app. It uses a private mock installation to verify the actual signed
launcher, installed command wrapper, and child `node` across two CLI versions,
without reading provider credentials or requesting OS privacy permissions.

Before applying attribution to a real installation, record the configuration
digest, service PID, and startup job count. Confirm all three remain unchanged
afterward, apart from the intended plist metadata. Verify the rendered Login
Items identity separately when an unlocked desktop is available.

Apple documents the association and matching-team requirement in
[Updating helper executables from earlier versions of macOS](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos).
The broader background-service structure is described in
[Manage login items and background tasks](https://support.apple.com/guide/deployment/manage-login-items-and-background-tasks-depdca572563/web).

## Earlier background-attribution package, October 18, 2026

The following record describes the earlier package, which preserved upstream
Node. It does not validate the app-owned Node derivative or consent persistence
introduced above. Those require their own signing and runtime checks.

The complete source gate passed 1,224 tests. The native app passed 34 tests,
including waiting for setup before termination; packaging, signed-derivative,
and native-launcher checks passed 29 tests. A real isolated launchd registration
ran the signed launcher with the original command arguments and was then removed.
The signed SDK's bundled-engine receipt validation succeeded.

Apple accepted notarization submission
`98da385c-e2bb-48c4-8068-730990d92ef2`. Stapler validation and Gatekeeper reported
`accepted` with `source=Notarized Developer ID`. The app and its launcher use the
Applifyer Developer ID team `T8J48M4QVY`. The original installed gateway release
and the official Node runtime were preserved.

The notarized package was installed on Studio and MacBook. Each machine still
had exactly one gateway startup plist. A semantic comparison confirmed that only
`Program` and `AssociatedBundleIdentifiers` changed. Both real configurations,
running gateway PIDs, desktop registrations, and model counts were preserved.
The installed app's real bridge remained ready on both machines. The name/icon
change is staged for the next service load; the locked desktops prevented a new
rendered Login Items check, so cached row disappearance is not claimed.

## App-owned Node verification, October 18, 2026

The Node identity update passed 1,233 gateway tests, 34 native app tests, and 45
packaging, launcher, and signing checks. Independent review verified that runtime
registration completes before the LaunchAgent metadata is published, and that
a refused runtime association preserves the original registration.

Apple accepted notarization submission
`65b5f803-b356-4eb7-9a89-f947d2d0364a`. The final app passed strict signature
verification, stapler validation, and Gatekeeper as `Notarized Developer ID`.
Its Node uses `com.edihasaj.harness-gateway.node`, team `T8J48M4QVY`, and the
Automation entitlement. The signed artifact passed the isolated two-version
test on both Macs, including child launches through the managed wrapper and
through `PATH`.
The app, service helper, and Node also retained identical designated signing
requirements between the signed `0.5.0` backend preflight and the `0.5.1`
backend app.

The same artifact was installed on Studio and MacBook at their existing
Applications paths using an atomic directory exchange. Their owned wrappers and
runtime registration were prepared without stopping a gateway process. Both
health endpoints remained healthy; configuration digests, service PIDs, provider
counts, and startup-job counts were unchanged. The bundled and installed CLI
version was `0.5.1`; the app version remained separately recorded.

Existing processes keep their loaded runtime. The service adopts the app-owned
Node on its next start. Existing adapters and tool children also need to exit
normally before they can use the new runtime. Initial OS consent can still be
required for this new identity.

Shotport app capture and its frontmost-window retry both failed with
ScreenCaptureKit `-3811`. Probeport's wrapper also failed with `kill EPERM`;
direct signed-artifact and lifecycle checks supplied the evidence above.
Rendered permission dialogs and TCC consent persistence across a real app update
remain unverified. No privacy grants were reset, edited, or automatically accepted.

The same notarized artifact was subsequently installed on `macbook-server`
(M2 Max, macOS 27.0.1), which previously had no native Gateway app. Its actual
signed-runtime update fixture, Gatekeeper assessment, health endpoint, registered
Node path, and stable Node signing requirement passed. Its CLI remained `0.5.0`;
configuration digest, service PID, provider count, and startup-job count stayed
unchanged. Its existing service was prepared for the next start without loading
another job or opening the control panel. This completes the rollout to all three
managed Macs. The signing and TCC behavior described here applies to macOS.
