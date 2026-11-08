---
summary: 'Optional Full Disk Access invitation and macOS permissions used by Gatefox.'
read_when:
  - Changing the native app permission invitation or privacy settings
  - Investigating protected-file access, Automation, or Local Network grants
---

# Gateway permissions on macOS

The app offers an optional Full Disk Access invitation once, after the setup
wizard closes or on the next launch of an already configured app. **Open Full
Disk Access** opens **System Settings → Privacy & Security → Full Disk Access**.
**Not now** dismisses the invitation. Both choices are remembered in the current
launch's preferences; explicit configuration launches retain their isolated
preferences. Neither choice records an access grant.

**Settings → Permissions** always provides the same action. Enable
**Gatefox** manually in System Settings. If it is missing, use **+** to
select the installed app; **Show this app** reveals the current bundle in Finder.
An unbundled development executable has no app-reveal button. If a settings
link cannot open, the panel gives the manual navigation path.

Full Disk Access permits broad access to protected data, including Mail,
Messages, Safari data and backups. Ordinary development in accessible project
folders does not require it. macOS has no public general-purpose API to request
or reliably query this grant for the app and its separately running tools.
The app does not probe private files or read the TCC database to guess status.
Opening System Settings never produces a green permission indicator.

If macOS requests a quit and reopen, finish active work first. The control panel
does not restart the service or tool processes. Verify the intended file action
from its actual execution host after any required restart. The responsible
identity can be the signed gateway runtime, a harness, a terminal, or an
independent tool. Review the identity macOS reports instead of granting every
installed executable access. Permissions on one Mac do not authorize another.
See [Node and tool permissions](macos-background-item.md#node-and-tool-permissions)
for the signed runtime and responsibility boundary.

## Permissions for development work

The panel covers access used by Gatefox and its client-run tasks.
Additional permissions remain conditional on the actual action. Provider
inference does not execute tools or acquire permissions on the caller's behalf.

| Permission | When it applies |
| --- | --- |
| Full Disk Access | A development task needs protected files. Ordinary accessible project folders do not require it. |
| Automation | A client-run task uses AppleScript or Apple Events to control another app. Run the intended action to trigger consent for the actual requesting app and target app. |
| Local Network | The gateway connects to a configured model server or shared gateway on the LAN. Loopback-only use does not require it. macOS requests access when needed. |

**Other gateway permissions** exposes Automation and Local Network links. The
signed app and runtime already declare Automation and local-network use; opening
a settings pane does not request consent for an unrelated action or target.
The gateway does not request microphone, camera, Accessibility or Screen
Recording permissions for itself as part of this flow. Independent client tools
retain their own permission flows.

Apple's
[Privacy & Security settings guide](https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac)
describes the scope of each macOS grant and manually adding applications.

## Verification

Run the source gate and `npm run app:test`. Native tests cover invitation
deferral, explicit-answer persistence, isolated preferences, settings destinations,
and failures that retain manual instructions.

On an unlocked Mac, launch an isolated app fixture and verify the invitation
appears after setup. Dismiss it, relaunch, and confirm it stays dismissed while
Settings still offers the controls. Open Full Disk Access and verify the actual
pane, then inspect Automation and Local Network. Do not grant access or
restart active work as part of routine UI verification. A successful URL-open
callback proves dispatch only; rendered destinations and actual protected-file
actions need separate desktop evidence.

On October 29, 2026, the build and type checks passed. The full source run passed
3,562 gateway tests and 160 Claude desktop checks, with one intentional skip in
each suite. An earlier Unix-listener timeout passed both a targeted rerun and the
full rerun. Native verification passed 119 tests and 87 packaging checks. The
isolated app's Permissions panel was inspected visually, and its Full Disk
Access and Automation actions opened the actual System Settings pages. No
privacy grant or live gateway restart was performed. The production app has not
been updated by this source verification.
