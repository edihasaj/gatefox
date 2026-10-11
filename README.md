# Subscription Gateway

A local gateway for subscription and API providers. The project name is provisional.

Clients send OpenAI Responses requests. A provider adapter handles authentication
and inference. The client executes tools and returns their results to the gateway.

Claude runs the unmodified Claude Code binary using its subscription login.
A private virtual MCP server declares the client's tools. The gateway returns
Claude's native tool calls to the client, which owns execution and approvals.
Claude's built-in tools and user customizations are disabled.

Codex uses a separate Sign in with ChatGPT registration and the public Responses
endpoint. Each account has its own provider ID, model aliases, and credentials.
Routing never switches accounts or billing modes after a failure.

Copilot uses the installed GitHub Copilot CLI's [SDK protocol](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility) 3 and subscription
login. Per-request sessions expose only caller tools, disable local instruction
discovery, and are deleted after inference. Inherited BYOK settings and GitHub
token overrides are removed. The adapter verifies the reported subscription
route and exact model before completing a response. The SDK's allowed-model list
also restricts each session to the requested model. It adds no SDK dependency.

Requires Node 22+ and the native CLI for each configured subscription provider.

```sh
npm ci
npm run build
node dist/cli.js init
node dist/cli.js login codex
node dist/cli.js discover claude --load
node dist/cli.js discover codex --load
node dist/cli.js doctor
node dist/cli.js serve
```

In another terminal, generate Codex settings:

```sh
node dist/cli.js codex-config --model codex/gpt-6.1-sol > gateway.codex.toml
```

Keep the native account’s base configuration unchanged. Save the generated file
as `~/.codex/subscription-gateway.config.toml`, then launch the CLI with
`codex --profile subscription-gateway`. The generated catalog exposes account
labels and reasoning controls. It also configures a credential helper so the
gateway token does not need to appear in the TOML file. The daemon reloads saved
model routes on the next request. A model name alone cannot switch an existing
native ChatGPT thread to the gateway. The experimental
[app-server adapter](docs/app-server.md) adds gateway models after native models
and routes new chats. Its rendered Claude/Codex launch passed on the test Mac;
see the remaining limits in [verification](docs/verification.md).

Subscription providers support account-specific discovery:

```sh
node dist/cli.js discover claude --load
node dist/cli.js discover codex --load
node dist/cli.js codex-config --model codex/gpt-6.1-sol > gateway.codex.toml
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

Development gate: `npm run build && npm run check && npm test`.
Adapters also exist for ordinary APIs; the current delivery
focus is Claude, Codex, and Copilot subscriptions.

Inline image attachments and image tool results use native provider image inputs.
The verified formats are PNG, JPEG, GIF, and WebP. See [Responses support](docs/responses.md)
for payload limits and provider preprocessing. Stop/continue and saved-chat image
history have passed through the real Codex engine on the test Mac.

See [architecture](docs/architecture.md), [Responses support](docs/responses.md),
[verification](docs/verification.md), [desktop adapter](docs/app-server.md), [remote clients](docs/remote.md).
