<img src="docs/assets/logo.png" width="88" height="88" alt="GateFox fox">

# GateFox

Use your Claude, ChatGPT, Copilot and local models from the coding app you
already use. GateFox runs on your Mac, signs in to each account the
official way, and adds those models to the model picker of Codex, Claude Code and
Claude Desktop.

```
Codex · Claude Code · Claude Desktop
              │  Responses or Messages API
              ▼
     GateFox  (on this Mac, 127.0.0.1)
              │  one sign-in per account
              ▼
 Claude · ChatGPT · Copilot · API keys · local models
```

Your app still runs the tools, asks for approvals and owns the chat. The gateway
only translates requests and streams the answers back. It never runs tools,
never switches accounts after a failure and never logs tokens or request bodies.

**Where it works**

| | |
|---|---|
| **Mac** (Apple silicon) | The app, background service and updates; Codex, Claude Code and Claude Desktop |
| **Phone** | Codex in the ChatGPT app lists and continues your gateway chats; your Mac does the work through its [native relay](docs/native-remote.md) |
| **More Macs** | One Mac holds the accounts; the others connect to it ([below](#add-another-mac-optional)) |
| **Linux, Windows** | Not packaged yet, and [help is welcome](docs/roadmap.md#4-more-platforms) |

📖 **[Read the guide at gatefox.dev](https://gatefox.dev)**: setup, daily use,
adding more Macs and fixing problems. To read it offline, run `npm run docs:serve`.

## Quick start: one Mac

Everything runs on one Mac by default. You need an Apple Silicon Mac, the Codex
desktop app, and the official CLI for each subscription you connect (for example
Claude Code for a Claude subscription).

**Option A: the app.** Download
[**Harness-Gateway-1.7.8-macos-arm64.zip**](https://github.com/edihasaj/gatefox/releases/download/v1.7.8/Harness-Gateway-1.7.8-macos-arm64.zip)
(notarized, Apple silicon) or pick a version from
[all releases](https://github.com/edihasaj/gatefox/releases). Unzip it, move the
app to Applications and open it. The setup wizard connects your accounts, picks
models and starts the background service. From 1.8.0 the app is `GateFox.app`.

**Option B: the command line.**

```sh
VERSION=1.7.8
gh release download "v$VERSION" -R edihasaj/gatefox \
  --pattern '*macos-arm64.tar.gz' --pattern SHA256SUMS
shasum -a 256 -c SHA256SUMS
tar -xzf "harness-gateway-$VERSION-macos-arm64.tar.gz"
"./harness-gateway-$VERSION-macos-arm64/install"

gateway init                       # private config, listens on 127.0.0.1 only
gateway login claude               # sign in to each account you want
gateway discover claude --load     # load the models it offers
gateway service install            # keep it running in the background
gateway desktop register           # add the models to the Codex app
gateway doctor                     # check everything
```

Quit Codex once and reopen it. New models appear after the native ones, with
labels such as **Claude · Opus 5.5**.

## Add another Mac (optional)

The first Mac keeps every account and serves the others. Each extra Mac gets
only a client token and an SSH tunnel; no account credentials are copied.

```
 laptop ── SSH tunnel ──► main Mac (accounts + gateway) ──► providers
```

```sh
# on the extra Mac, after installing the gateway
umask 077; mkdir -p ~/.local/state/harness-gateway-client
ssh you@main-mac 'gateway token' > ~/.local/state/harness-gateway-client/client-token
gateway setup --client --port 3459 --token-file ~/.local/state/harness-gateway-client/client-token
gateway tunnel install --tunnel-id main --host you@main-mac --port 3459 --remote-port 3457
gateway desktop register && gateway doctor
```

See [remote clients](docs/remote.md) for details and the native connected-machine option.

## Documentation

| Start here | Then |
|---|---|
| [Guide](https://gatefox.dev): set up, use, add Macs, fix problems | [All docs](https://gatefox.dev/reference.html): searchable index of every topic |
| [Commands and providers](docs/cli.md) | [Architecture](docs/architecture.md) |
| [Claude Code](docs/messages.md) · [Claude Desktop](docs/claude-desktop.md) | [API providers](docs/api-providers.md) · [Remote Macs](docs/remote.md) |

## Development

```sh
npm ci
npm run build && npm run check && npm test
npm run docs:serve     # build the docs site and preview it at http://127.0.0.1:8765
```

Node 22 or later. Tests run in a private temporary home and never touch your real
gateway. See [CI](docs/ci.md) and [releasing](docs/RELEASING.md).

## Contributing and security

Want to help? The [roadmap](docs/roadmap.md) lists next steps (better Claude app support,
DeepSeek, more harnesses, Linux and Windows) with an issue for each, including
[good first issues](https://github.com/edihasaj/gatefox/issues?q=is%3Aopen+label%3A%22good+first+issue%22).
See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Release archives include the licenses of bundled components.

## Compatibility names

GateFox was called Harness Gateway, and before that Subscription Gateway. Names that
existing installations and saved chats depend on keep an older spelling: the Codex provider ID
`subscription_gateway` (stored in gateway chats saved before 1.8.0, which records new chats as `gatefox`; both ids are registered in every gateway executor;
a Mac that opts in to `"chatIdentity": "openai"` stores its new chats as `openai`, see
[harness identity](docs/harness-identity.md)), the LaunchAgent labels
`com.edihasaj.subscription-gateway*`, the install root `~/.local/share/subscription-gateway`
(fresh installations since 1.8.0 use `~/.local/share/gatefox`), the state folder
`~/Library/Application Support/Subscription Gateway` (fresh installations use `GateFox`), and the
ownership markers in service and execution-host receipts. Changing any of them
needs a migration on every Mac. The installed command is `harness-gateway`; since 1.8.0 the
installer also writes `gatefox` with the same contents (an update run by a 1.7.x app adds it
on the next install), and
`gateway` remains as a second launcher with the same contents, so existing scripts
and old LaunchAgents keep working. macOS names a background item after the program a
LaunchAgent runs, so the plists the gateway writes name `harness-gateway`, and System
Settings, Login Items shows "harness-gateway" under "Allow in the Background". With
the unified service that is the gateway's one background item: since 0.4.8 the
service's daemon sets `CODEX_CLI_PATH` itself at its start, and the separate
`harness-gateway-login-env` item that 0.4.7 added is removed at the first 0.4.8
service start. Only a standalone `gateway desktop register`, with no unified
service, keeps that login environment agent. When a service is rewritten by 0.4.7 macOS posts one "Background Items
Added" notification for harness-gateway, and the old "gateway" entry disappears from
the list. See [services](docs/services.md).
