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
These identities remain supported so naming changes preserve chats and permissions.

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
using those locations. The explicit path migration below gives them canonical
GateFox entry paths while retaining their original storage and ownership identity.
Updates never apply this migration automatically.
See [the Mac app](macos-app.md) for configuration discovery.

## Explicit path migration

```sh
gatefox migrate --json                  # Read-only preview, including blockers.
gatefox migrate --apply --json          # Only during a coordinated maintenance window.
gatefox migrate --revert --json         # Preview rollback.
gatefox migrate --apply --revert --json # Remove only aliases this transaction created.
```

Install the matching GateFox app and CLI before applying this migration. Close
ChatGPT and GateFox and stop the managed service deliberately with the operator;
the command never closes an app, unloads a job, restarts a process or starts a
service. Loaded jobs, active writers, installer locks and pending app updates block
application. A preview reports these blockers without writing files.

For an existing installation, migration creates these verified aliases:

| Canonical entry | Original storage retained |
| --- | --- |
| `~/Library/Application Support/GateFox` | `~/Library/Application Support/Subscription Gateway` |
| `~/.local/share/gatefox` | `~/.local/share/subscription-gateway` |

On Linux, the configuration entry is `~/.config/gatefox`, backed by
`~/.config/subscription-gateway`. Fresh canonical installations need no alias.
Independent directories at both names are a conflict; migration never merges or
overwrites them. Foreign links, writable backing folders and unowned files are refused.

The backing folders deliberately keep their existing names. Moving them would
invalidate absolute paths held by immutable releases, updater rollback and older
service registrations. GateFox's command, installer and native app recognize only
the exact owned alias and continue using the original configuration identity.
Relative credential paths, executor ownership hashes and app preferences therefore
stay the same. There is one data store, one installation and one background job.

A private receipt at `~/.local/state/gatefox-rename/transaction.json` records the
aliases and their filesystem identities. Retrying resumes recorded publications;
rollback removes only the recorded links after checking every one. It keeps data,
permissions and the receipt. Preexisting aliases are never adopted for rollback.
Applying again after rollback archives the reverted receipt before starting a new
transaction.
If a process dies between creating a link and recording its inode, retry refuses
to claim that uncertain link; preserve the receipt and review that link before
recovery. A replaced or missing recorded link also requires review. Do not delete
backing storage to resolve a rename conflict.

To return to an older app/CLI release, revert these aliases with the matching
migration-capable release first, then follow the normal release rollback.
Historical releases do not understand the canonical aliases' ownership contract.

The following identities must not be removed as cosmetic cleanup:

| Identity | Why it remains |
| --- | --- |
| `com.edihasaj.subscription-gateway*` LaunchAgent labels and ownership markers | They identify existing managed services and recovery records. They remain compatibility keys; the signed app supplies the GateFox name and icon. |
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

`gatefox chats migrate` previews a supported saved-chat migration; `--revert`
previews the reverse direction. To make changes, quit ChatGPT and stop the
gateway service normally, then use `--apply` or `--apply --revert`.
The command requires the canonical provider registration, backs up the database,
and preserves native chats. It updates rollout metadata before database rows so
an interrupted migration can be resumed. Keep the generated backups.

This is separate from path migration, which never rewrites chats. The saved-chat
command's reverse direction selects every `gatefox` chat, including chats originally
created with that identity; it is not transaction-specific rollback. Keep saved
provider identities in place when preserving those existing GateFox chats matters.
Both provider IDs remain supported.

See [harness identity](harness-identity.md) for the full saved-chat contract.
