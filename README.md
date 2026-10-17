<img src="docs/assets/logo.png" width="88" height="88" alt="Harness Gateway fox">

For paused native builds and explicit production requests, see [CI cost policy](docs/ci-cost-policy.md).

# Harness Gateway

Formerly Subscription Gateway.

A local gateway for subscription and API providers. The project name is provisional.

Start with the [illustrated setup and usage guide](docs/index.html). It covers
installation, separate account registration, desktop models, shared Macs,
and service recovery. Open `docs/index.html` in a browser, or
serve the `docs/` folder with any static web server.

Clients send OpenAI Responses or Anthropic Messages requests. Both interfaces use
the same model aliases and provider routes. A provider adapter handles authentication
and inference. The client executes tools and returns their results to the gateway.
Claude Code can use GPT, Claude, and local model routes through its native Messages
interface; see [Claude Code setup and Messages compatibility](docs/messages.md).

Claude runs the unmodified Claude Code binary using its subscription login.
A private virtual MCP server declares the client's tools. The gateway returns
Claude's native tool calls to the client, which owns execution and approvals.
Claude's built-in tools and user customizations are disabled.

Codex uses a separate Sign in with ChatGPT registration and the public Responses
endpoint. Each account has its own provider ID, model aliases, and credentials.
Routing never switches accounts or billing modes after a failure.

Copilot uses the installed GitHub Copilot CLI's [SDK protocol](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility) 3 and subscription
login. Sessions expose only caller tools and disable local instruction
discovery. A one-shot session whose turn ended with a complete text answer is deleted
after inference; any other one-shot end kills its CLI. Live sessions (the
default) last until they park out, are evicted or are closed, and their CLI is
then killed and its private folder removed (see
[live Copilot sessions](docs/copilot-sessions.md)). Inherited BYOK settings and
GitHub token overrides are removed. The adapter verifies the reported subscription
route and exact model before completing a response. The SDK's allowed-model list
also restricts each session to the requested model. It adds no SDK dependency.
By default the gateway keeps one live Copilot session per Codex thread, so Copilot's
prompt cache stays warm across a tool loop; the same history sent as a new session on
every request rewrites most of it to the cache each time, which cost about 9.5 times
as much as the same work in a native Copilot session. Set `copilotSessions.mode: "oneshot"` on
the provider to turn that off, which is also what a request falls back to when a live
session cannot serve it (see [live Copilot sessions](docs/copilot-sessions.md)).

The Apple Silicon installer bundles a verified Node runtime. Subscription
inference hosts also need the native CLI for each configured provider. Desktop
clients need the signed Codex app and an adapter on the selected execution device.
The native connected-machine adapter uses the existing Codex connection. An SSH
forward is required only when that device uses the remote-gateway setup described
in [remote setup](docs/remote.md).

```sh
gh release download v0.4.6 -R edihasaj/harness-gateway \
  --pattern '*macos-arm64.tar.gz' --pattern SHA256SUMS
shasum -a 256 -c SHA256SUMS
tar -xzf harness-gateway-0.4.6-macos-arm64.tar.gz
./harness-gateway-0.4.6-macos-arm64/install
gateway --version
```

The installer needs no administrator access or repository checkout. It installs
versioned files under the user's local installation prefix. It refuses an
unrelated `gateway` command and preserves provider registrations during upgrades.
An earlier npm installation of this package is redirected to the installed command.

For a new inference host:

```sh
gateway init
gateway login claude
gateway login codex
gateway discover claude --load
gateway discover codex --load
gateway doctor
gateway service install
gateway desktop register
```

For a secondary Codex account, use `gateway login codex --account-email EMAIL`.
The gateway verifies that email in the signed identity token before saving its
separate registration. A different account is rejected. Browser sign-in waits
up to fifteen minutes; an expired callback requires a fresh sign-in.

For an existing development setup, `gateway setup --from-config PATH` copies only
gateway-owned registrations, the client token, and private preferences into the
installed data directory. It never copies native Codex authentication or settings.

Desktop registration applies to future normal app launches and is restored at
login. Quit the app normally once after initial registration. Run `gateway desktop`
to launch immediately with the adapter. The launcher refuses to stop a running app.
`gateway desktop status` checks registration and reports `legacyForceCli: true` while an old
`CODEX_APP_SERVER_FORCE_CLI=1` is ours to clear, `forceCliSet: true` while the variable holds anything
left after the gateway strips the single newline `launchctl getenv` prints (an empty value reads as not
set, and a read that fails or times out is an error, not `forceCliSet: false`), and
`staleWrapper: true` while the session names a gateway wrapper the receipt no longer names. `gateway desktop
register` clears the legacy value when a registration receipt proves the gateway set it (see
[the adapter setup](docs/app-server.md)). `gateway desktop unregister` removes the registration, and
`gateway uninstall` reads the same answer first, without writing, so it can stop before it removes
anything.

For an optional Codex CLI installation, generate settings in a separate home:

```sh
gateway_client_root="$HOME/.config/harness-gateway/clients"
gateway_codex_home="$gateway_client_root/codex"
mkdir -p "$gateway_codex_home"
gateway codex-config --model codex/gpt-6.1-sol > "$gateway_codex_home/config.toml"
CODEX_HOME="$gateway_codex_home" codex
```

Keep the native account’s base configuration unchanged. The generated file is
a complete configuration, not a named profile. This separate CLI home has its own
history and settings. The generated catalog exposes account
labels and reasoning controls. It also configures a credential helper so the
gateway token does not need to appear in the TOML file. The daemon reloads saved
model routes on the next request. A model name alone cannot switch an existing
native ChatGPT thread to the gateway. The experimental
[app-server adapter](docs/app-server.md) adds gateway models after native models
and routes new chats. Its rendered Claude/Codex launch passed on the test Mac;
see the remaining limits in [verification](docs/verification.md).

Subscription providers support account-specific discovery:

```sh
gateway discover claude --load
gateway discover codex --load
gateway codex-config --model codex/gpt-6.1-sol > gateway.codex.toml
```

Claude discovery reads the official CLI initialization catalog without sending an
inference prompt. It resolves model aliases and omits the duplicate Default row.
Codex discovery reads the signed-in account’s public model catalog. Omit `--select`
to load every offered model, or pass comma-separated IDs to choose a subset.
Refresh retains existing aliases for models that are still offered.

To configure Copilot, add a provider with `type: "copilot-subscription"`, a unique
`id`, `label: "Copilot"`, and an initial `models` alias map. Then run
`gateway login ID`, `gateway discover ID --load`, and `gateway doctor`.
Discovery keeps selectable models allowed by the account policy and omits Auto.
An optional `authDirectory` selects the CLI's Copilot home; credentials remain
under the native CLI's control. The gateway does not copy them. The metadata
uses the default context tier rather than promising the larger context tier.

Provider `label` controls the name before the middle dot, such as `Claude · Opus
5.5` or `Codex 2 · GPT-6.1-Sol`. Providers appear in configuration order; metadata
`priority` sorts models within each provider. Use `authDirectory` to isolate
another Claude account. There is no recent-use tracker.

Standard remains the default speed. Codex 2 discovery retains offered Fast tiers
for local and connected-machine model lists. Claude models that support fast mode
(Opus) offer Fast too, billed to Claude usage credits. Speed is independent of reasoning.
The current Copilot CLI has no selected-model Fast tier; unsupported requests
fail before inference. See [speed controls](docs/speed-controls.md).

On macOS, install an explicit user service to keep the daemon alive independently
of terminals and the Codex app:

```sh
gateway service install --config /absolute/path/gateway.local.json
gateway service status
gateway service restart
gateway service uninstall
```

Uninstall moves the managed LaunchAgent to Trash and preserves credentials.
Changing the listener port or state directory requires a daemon restart.

Use `gateway service consolidate --next-login` to keep one gateway startup entry
without stopping current chats. Existing services keep running until logout; the
single entry restores their duties at the next login. The command preserves the
native account and saves the original startup files for recovery. See
[service consolidation](docs/services.md) for activation checks.

Use `gateway service consolidate` to preview replacing the gateway's individual
jobs with one supervisor. Apply with `--apply` after local and remote chats finish.
The migration preserves endpoints and saves rollback copies. See
[service ownership](docs/services.md).

Development gate: `npm run build && npm run check && npm test`. `npm test` runs the suite under a private
temporary folder and a private home folder (`scripts/run-tests.mjs`, `HOME` is `<folder>/home`) that it removes
afterwards, so the real ones are left as they were, including `~/.local/state/gw-exec`, where execution hosts keep their
folders, receipts and socket links; name test files
after `--` to run only those. The runner fails a test that sets no timeout after 120 s
(`GATEWAY_TEST_TIMEOUT_MS`), lets a test file exit once its tests have ended, and runs the suite in its own
process group, so a signal to the runner stops every test process and it exits with 128 plus the signal. Each test
process exits on the signal, so the Copilot CLIs it started (they run in groups of their own) stop with it, and the runner
removes the stale sockets its run linked to in `/tmp/codex-daemon-<uid>`, the one place the pinned SDK fixes outside both folders.
Test processes refuse the real per-user roots outside a temporary folder, and the runner fails a run that left a test
receipt in the real `gw-native` or `gw-exec` ([CI](docs/ci.md)).
Hosted macOS native CI is manual-only: dispatch from `production` with
**Run paid macOS native checks** enabled (default off); ordinary development pushes and PRs stay on Ubuntu. The local
guard is `node --test scripts/tests/ci-native-policy.test.mjs`; see [CI](docs/ci.md).
Adapters also exist for ordinary APIs; the current delivery
focus is Claude, Codex, and Copilot subscriptions.

`chat-completions-api` supports local vLLM servers and compatible APIs through
their native streaming endpoint. API providers accept either `credentialFile`
(owner-only) or `apiKeyEnv`. Local HTTP endpoints must use loopback; reach a DGX
Spark through `gateway tunnel install`. Qwen 3.8 Flash Next passed real Codex
streaming, file reads, patches, follow-ups, reasoning, interruption, and recovery.
Its current gateway route supports text only.

The gateway translates subscription and API inference into the caller's Responses or Messages
protocol. The client owns agent roles, delegation, model selection, permissions,
tool execution, and chat names. The gateway adds no role instructions, default
worker, or agent-only tools. Saved gateway chats remain readable before model
discovery and resume through the registered provider.

`gateway uninstall` moves the installed files to Trash, removes managed services
and desktop registration, and preserves the data directory and credentials. On
macOS it first runs a read-only desktop preflight, which reads the desktop state
and stops before anything is removed. A `launchctl getenv` that fails stops it the
same way, and so does a gateway login promotion staged for the next login. A
unified service plan does not stop it, because the service step moves that file to
Trash with the service. Elsewhere there is no desktop registration to plan, so the
service step answers with its own platform message. If a desktop step fails once
removal has started, the error names what is already gone: resolve that cause,
then rerun `gateway uninstall`.

Inline image attachments and image tool results use native provider image inputs.
The verified formats are PNG, JPEG, GIF, and WebP. See [Responses support](docs/responses.md)
for payload limits and provider preprocessing. Stop/continue and saved-chat image
history have passed through the real Codex engine on the test Mac.

See [architecture](docs/architecture.md), [Responses support](docs/responses.md), [Messages support](docs/messages.md),
[verification](docs/verification.md), [desktop adapter](docs/app-server.md), [remote clients](docs/remote.md).

## Compatibility names

The project was renamed from Subscription Gateway. Names that existing installations
and saved chats depend on keep the old spelling: the Codex provider ID
`subscription_gateway` (stored in every gateway chat), the LaunchAgent labels
`com.edihasaj.subscription-gateway*`, the install root `~/.local/share/subscription-gateway`,
the state folder `~/Library/Application Support/Subscription Gateway`, and the
ownership markers in service and execution-host receipts. Changing any of them
needs a migration on every Mac. The `gateway` command remains; the installer also
adds `harness-gateway`.
