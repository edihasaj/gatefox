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

The native picker reads reasoning options and a Fast descriptor from its own
model catalog. The trial appends gateway metadata at that lookup boundary,
preserves existing native entries, and leaves unadvertised capabilities off.
The synthetic catalog has two models with different reasoning options; only
one advertises priority service. Displaying a control is not proof that the
bundled Claude Code transport honors it. Reasoning and Fast each require
separate wire-level verification before use with real inference.

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

The workstation remained at the lock screen and the app had no visible window.
Native control rendering, actual effort forwarding, Fast transport, and
descendant CLI isolation remain unverified. An unlocked desktop is required to
continue. The latest core suite reported 3,304 passes, no failures and one skip;
the latest desktop suite reported 73 passes, no failures and one skip.

Run `npm run check`, `npm run build`, and `npm test` before handoff. Focused
tests are in `scripts/claude-desktop-tests/claude-native-*.test.mjs`. Preserve
required receipts and remove owned disposable staging after testing ends.
