---
summary: 'Current GateFox names and the compatibility identities used by existing installations and saved chats.'
read_when:
  - Changing app, command, installation or saved-chat identities
  - Recovering an existing installation that uses an older name
---

<!-- Preserve published deep links to the former rename reference. -->
<a id="the-gatefox-rename"></a>
<a id="why-some-names-cannot-just-be-replaced"></a>
<a id="plan"></a>
<a id="progress-branch-codexgatefox-180"></a>
<a id="decision-needed"></a>
<a id="order-of-work"></a>

# Names and compatibility

GateFox is the current product name. Harness Gateway and Subscription Gateway
remain in some stored identities that installed services and saved chats use.
These are supported compatibility identities, not unfinished rename work.

## Current names

| Surface | Name |
| --- | --- |
| App | `GateFox.app` |
| Commands | `gatefox`, `gateway` and `harness-gateway` run the same gateway |
| Stable release tag | `vVERSION` |
| App download | `GateFox-VERSION-macos-arm64.zip` |
| CLI download | `gatefox-VERSION-macos-arm64.tar.gz` |
| New gateway chat provider | `gatefox` |

See [releasing](RELEASING.md) for publication and [app updates](macos-updates.md)
for signed installation and rollback.

## Existing installations

Fresh installations use `~/.local/share/gatefox` and, on macOS,
`~/Library/Application Support/GateFox/gateway.json`. An existing installation
can retain `~/.local/share/subscription-gateway` and
`~/Library/Application Support/Subscription Gateway/gateway.json`; updates keep
using those locations. Updates do not promise a folder or LaunchAgent rename.
See [the Mac app](macos-app.md) for configuration discovery.

The following identities must not be removed as cosmetic cleanup:

| Identity | Why it remains |
| --- | --- |
| `com.edihasaj.subscription-gateway*` LaunchAgent labels and ownership markers | They identify existing managed services and their recovery records. |
| `com.edihasaj.harness-gateway.app` bundle ID | Keeping it preserves the app's signing identity, permissions and background association. |
| `HARNESS_GATEWAY_EXECUTOR` alongside `GATEFOX_EXECUTOR` | Running executors and SDKs may read either marker. |
| `Symbol.for("harness-gateway/…")` registry keys | Loaded releases share live sessions and ownership through these keys. |
| A `Harness Gateway.app` compatibility link | A loaded service can still refer to that path until its next natural start. |

App relocation accepts only the verified sibling app relationship described in
[app updates](macos-updates.md#renaming-the-installed-app-to-gatefoxapp).
It does not authorize changing arbitrary app paths or macOS privacy records.

## Saved chats

Current gateway executors register both `gatefox` and `subscription_gateway`.
Existing chats keep opening under their recorded provider ID; migration is
optional. A resume never rewrites a chat's provider identity.

`gateway chats migrate` previews a supported saved-chat migration; `--revert`
previews the reverse direction. To make changes, quit ChatGPT and stop the
gateway service normally, then use `--apply` or `--apply --revert`.
The command requires the canonical provider registration, backs up the database,
and preserves native chats. It updates rollout metadata before database rows so
an interrupted migration can be resumed. Keep the generated backups.

See [harness identity](harness-identity.md) for the full saved-chat contract.
