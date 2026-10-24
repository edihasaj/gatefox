---
summary: 'Verify native ownership through the real desktop wrapper and the app launcher.'
read_when:
  - Changing native engine path resolution or desktop wrapper generation
  - Investigating organization-settings startup errors after enabling shared native execution
  - Verifying desktop startup after a gateway service restart
---

# Native launcher verification

The ChatGPT app's `codex-cli/bin/codex` is a shell launcher, not a symlink.
Shared-native verification resolves it to the signed `CodexCLI.app` engine, while
an existing host's base receipt can still name the launcher. Test both spellings
against the verified native engine and retain the receipt's recorded checksum.
A test that starts every process with the signed binary misses this boundary.

## Isolated regression

Run `scripts/e2e-shared-native.mjs` against a complete candidate package, with its
verified gateway SDK available. Alongside the usual `--gateway`, `--package`,
`--root`, `--candidate-engine`, and `--host-capabilities native,gateway`, pass:

```text
--desktop-app /Applications/ChatGPT.app
--adapter-codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
--host-codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
```

Keep `--codex` on the app's signed executable. `--candidate-engine` must match
that executable's exact version. This mode starts the real host with the launcher,
uses a normally generated desktop wrapper for stdio, and passes the launcher
through the Unix adapter. The host uses production native SDK verification.
Also run without `--host-codex` to cover hosts that already record the signed path.

The fixture uses fresh private homes and mock providers. It never copies native
authentication or edits the primary native configuration. Its output records
which path variants were used, whether an ownership mismatch occurred, and
whether all owned processes were cleaned up.

## Startup diagnostics

Recent ChatGPT builds call `app-server --print-startup-config` before they open
their normal RPC session. The registered wrapper recognizes app-server help and
version requests, the `--print-*` diagnostic family, and every app-server
subcommand expressed as an unconsumed positional token.
Those invocations go straight to the original CLI with their argv, standard
streams, environment, and exit status unchanged; they do not read gateway
configuration, state, credentials, catalog, relay, or start an adapter.

The boundary is deliberately narrow. An unknown app-server option, a value after
an option that takes one (including `-c`/`--config`), and arguments after `--`
remain normal adapter sessions. A positional token that has not been consumed by
one of those options is the original CLI's subcommand, including hidden, future,
and invalid commands. This prevents future session flags or literal configuration
text from silently changing providers while leaving CLI command ownership with
the native engine. `--print-*` is the reserved diagnostic namespace, so future
startup probes do not need another wrapper change.

## Installed startup and restart

`scripts/probe-desktop-wrapper.mjs` performs read-only startup checks through the
exact registered wrapper. Pass `--wrapper /absolute/registered-wrapper`,
`--native-home /absolute/native-home`, and `--output /tmp/startup-result.json`.
It initializes a client, reads organization requirements, lists models, and lists
one page of chats. It records success, counts, and numeric error codes, without
chat contents, configuration values, or inference.

Require those checks before and after the normal service restart, confirm desktop
registration remains active for future launches, and require `gateway rollout
--verify --json` to report `ready` on each machine. A temporary `CODEX_CLI_PATH`
override, a passing direct-binary fixture, or an opened app alone is insufficient.
Service restarts must retain their normal idle guard; a refused restart is pending
verification and does not authorize stopping active work.
