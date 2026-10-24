---
summary: 'Version-pinned, isolated experiment for Claude Desktop native reasoning metadata.'
read_when:
  - Testing native reasoning or Fast controls for opaque Claude Desktop gateway routes.
  - Changing the isolated Claude app trial or its archive patch.
---

# Native Claude picker experiment

This is an experimental developer harness, not an installer or a supported
Claude Desktop configuration. The normal adapter does not modify Claude.app.
The experiment changes a disposable copy of Claude Desktop 2.42304.2 to teach
its existing picker about explicitly declared opaque gateway models. It keeps
one row per model and does not impersonate a Claude model family.

The native picker reads reasoning options from main-process model rows. Claude
already generates a row for every configured gateway alias, but without
thinking metadata for unknown IDs. Appending renderer rows does not fix that:
the same-ID placeholders win. The trial fills only that main-process gap, before
Claude's unchanged effort cap/default function. Explicit hybrid and signed
catalog rows, existing thinking options, labels, permissions and capabilities
are preserved. The renderer assets stay pristine.

The synthetic catalog has two models with different reasoning options. Fast is
not enabled: this build explicitly marks `claude_code_fast_mode` as
`blocked_by_platform` for third-party profiles. The experiment does not bypass
that policy, even when a gateway model advertises priority service.

## Native Ultracode

Eligible gateway routes can explicitly declare `supports_ultracode: true` in
the trial catalog, together with `xhigh` reasoning. This adds Claude's special
`ultracode` selector stop, not another model row and not an alias for ordinary
Extra high reasoning. Routes without that opt-in or without `xhigh` do not
receive the mode.

The native cap/default function is unchanged. Its result must still contain
`xhigh` before the connector adds the separate Ultracode mode stop. Therefore
a Low, Medium or High cap cannot expose Ultracode. Existing native, bundled,
hybrid and verified catalog thinking descriptors remain authoritative.

The private trial CLI settings opt into `enableWorkflows: true`. Managed
workflow restrictions and native availability checks still take precedence.
The gateway does not execute agents or add orchestration policy: Claude's CLI
owns Ultracode and tool execution.

The offline CLI smoke sends the same native control request used by the app:
`apply_flag_settings` with `effortLevel: "xhigh"` and `ultracode: true`. It checks
the `get_settings.applied` state, not just requested/effective configuration,
then completes a synthetic Messages turn. Run it with an explicit native CLI:

```sh
node scripts/claude-native-trial/ultracode-smoke.mjs /absolute/path/to/native/claude
```

The test uses an empty private home and workspace, a generated fixture token,
disabled nonessential traffic, and text-only synthetic model output. It denies
tool permission requests and records only typed control/availability flags and
reasoning metadata. It does not prove a real model's multi-agent fan-out quality.

The October 24, 2026 native CLI 2.1.299 run passed. Initialize, flag application
and settings requests succeeded; `applied` reported `effort: "xhigh"`,
`ultracode: true`, `ultracodeRequested: true` and `ultracodeAvailable: true` for
the opaque fixture route. The Messages request carried `xhigh`, and the CLI
completed a successful result matching the synthetic marker. The
[sanitized Ultracode receipt](evidence/claude-native-picker-2026-10-24/ultracode-verification.json)
records those checks without request or response content. A completed response
is required: accepted configuration alone does not pass this smoke.

The native Ultracode menu click still needs an unlocked desktop. Neither this
run nor the catalog tests claim that a real provider executed agent fan-out.
This remains an isolated trial, not a change to the installed Claude app or
the live MacBook profile.

## Safety boundary

The source app must pass strict signature verification and match pinned hashes.
The script only patches an already-created, owned app copy under a task-specific
`/tmp/claude-native-picker.<id>` directory. It does not sign either app by default,
change the bundle identifier, install startup jobs, or alter the installed app.
The modified copy no longer has a valid resource seal. If macOS refuses to
launch it, stop and obtain explicit permission before signing the isolated copy.
With explicit owner approval, pass `--adhoc-sign` to the runner to re-sign only
that copy for local testing. It preserves runtime and device/privacy entitlements
and flags, but removes the three vendor-only application identifier, team
identifier, and Keychain access-group claims that an ad-hoc signature cannot
carry. The test uses synthetic credentials, not Anthropic Keychain identity.
The runner verifies both signatures afterwards and records the local
test signature. This is not a notarized distribution or a production install.
Before sealing the bundles, the signer explicitly signs every confined Mach-O
leaf (including `.node` modules and framework libraries). `codesign --deep`
alone misses some libraries, which would retain a different Team ID and fail
library validation at launch.
An ad-hoc signature cannot satisfy this build's hardened library validation.
To keep validation enabled, use `--developer-id CERTIFICATE_SHA1` instead, with
an existing Developer ID identity in the dedicated
`~/Library/Keychains/apple-codesign.keychain-db`. This does not create/import
certificates, unlock a keychain, notarize, or publish anything. Do not disable
library validation or system security as a shortcut.

A prelude redirects Electron app data, profile, logs, crash dumps, and the Code
CLI configuration before vendor modules load. Cowork is disabled. The fixture
uses an ephemeral loopback listener, a private generated credential, and
synthetic text responses. Receipts contain only model IDs and sanitized
reasoning/tier controls, never prompts, tools, or credentials. No provider
subscription is used.
The runner also disables app auto-updates in the trial profile, sets its working
directory to the private empty workspace, and uses Chromium's
`--use-mock-keychain` for synthetic Electron OSCrypt storage only. The mock key
is not suitable for real credentials, does not isolate direct native Security
framework integrations, and must never be used with a real profile. Do not
connect Office365, sign in to provider accounts, or relaunch the trial without
that flag. No real Keychain access should be approved for this experiment.

## Run and verify

Create an APFS clone of the official app inside a new task-specific directory
under `/tmp`, named `Claude Native Trial.app`. Do not use hard links. The trial
runner expects the pinned official app at `/Applications/Claude.app` and the
installed `~/.local/bin/gateway` credential helper. Invoke:

```sh
node scripts/claude-native-trial/run.mjs /tmp/claude-native-picker.EXPLICIT_ID
```

Use the actual task directory, not the placeholder. A task directory can be
used only once. Keep the runner alive during GUI testing; stop it with SIGINT
when done. Check `prepared.json`, `running.json`, and `requests.json` in that
directory. They are experimental receipts, not deployment readiness evidence.

On an unlocked desktop, verify that each opaque model appears exactly once,
the available effort options match its declaration, selections survive model
switching and continuation, and low/high/max reach `/v1/messages` as selected.
Verify Standard/Fast separately, including refusal or hidden controls for an
unsupported model. Never infer success from metadata or a screenshot alone.
The harness does not enable remote debugging or bypass app security checks.

## Current verification status

On October 24, 2026, the owner explicitly approved re-signing the disposable
copy. An ad-hoc signature first failed with restricted-entitlement error -424;
after removing vendor identity claims it failed hardened library validation.
The existing Developer ID identity, applied to every Mach-O leaf and then the
bundles, allowed the trial process to stay running and create its own Electron
and CLI state directories. Hardened runtime and library validation remain
enabled. Both the original and trial app pass strict deep signature verification.

After the workstation was unlocked, the original launch was found waiting in
an Electron Keychain read. It was stopped without approving access; the
synthetic mock-Keychain launch opened the UI. An updater attempt had also used
Claude's shared ShipIt cache before auto-updates were disabled in the trial.
The installed app was not changed. A Finder automation request during folder
selection was denied, not granted.

The corrected main-process hook displays Claude's own native Effort popover
with its Faster-to-Smarter slider. A synthetic turn selected through that
slider reached `/v1/messages` with `output_config.effort: "low"` and returned
`NATIVE_PICKER_OK`. The bundled CLI executable ran under the private trial
profile, and the selected project was the empty trial workspace. Native model
menus contain exactly one row per fixture model. Defaults were separately
observed as medium before the main hook; auxiliary requests can use high and
are not evidence of a manual high-effort selection.

The [cropped UI capture](evidence/claude-native-picker-2026-10-24/native-effort.png)
and [sanitized receipt](evidence/claude-native-picker-2026-10-24/verification.json)
exclude unrelated desktop windows, credentials and prompts.

The workstation subsequently re-locked. Manual high/max forwarding,
model-switch persistence and continued-session/relaunch checks are pending.
This is not a deployed default or a MacBook rollout. A prior core run passed,
but the latest full gate reported 3,303 passes, one failure and one skip: the
untouched real-`lsof` idle-child test in `service-claude-activity.test.ts` failed.
It also failed alone: this host's CoreDevice DeviceFS mount emits a `can't
stat()` warning on `lsof` stderr. The service activity checker intentionally
fails closed on incomplete process information. That check was not weakened.
The final separate desktop suite, including Ultracode configuration and smoke
regressions, reported 93 passes, no failures and one skip. Do not report the
full gate as green.
The synthetic runner and fixture were stopped after the workstation re-locked;
the signed candidate and sanitized receipts remain for the pending tests.

Run `npm run check`, `npm run build`, and `npm test` before handoff. Focused
tests are in `scripts/claude-desktop-tests/claude-native-*.test.mjs`. Preserve
required receipts and remove owned disposable staging after testing ends.
