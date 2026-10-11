---
summary: 'Experimental Codex desktop adapter: additive model catalog and per-chat routing.'
read_when:
  - Connecting the gateway to the Codex desktop app
  - Changing app-server routing, model selection, or configuration writes
---

# Codex app-server adapter

The experimental adapter keeps the original Codex executable and native login.
It adds configured gateway models after the native models and starts new gateway
chats with `modelProvider: subscription_gateway`. Native chats keep their provider.

```sh
gateway codex-shim --config /absolute/path/gateway.local.json \
  --codex /absolute/path/original-codex -- app-server --listen stdio://
```

Stdout carries JSON-RPC only. The adapter forwards notifications, maps server
request IDs for approvals, bounds frames to 16 MiB, and stops its child on exit.
Non-server commands, including `--version`, pass through unchanged. The adapter
accepts `stdio://` and private `unix://` listeners. A Unix listener serves the
WebSocket protocol used by desktop SSH connections. It gives each connection its
own native and gateway executors. It refuses occupied sockets, requires a
user-owned directory without group/world write access, and sets the socket to
mode 0600. Network WebSocket listeners are rejected.

For the desktop SSH path, install the managed command on the remote Mac:

```sh
gateway ssh register --codex /opt/homebrew/bin/codex
gateway ssh status
```

Use the absolute path returned by `command -v codex` before registration. The
managed `~/.local/bin/codex` command decorates app-server operations and delegates
other commands to that original CLI. Registration refuses an unrelated existing
command. `gateway ssh unregister` moves only its own command to Trash. Native
configuration and authentication files are unchanged.

The app prepends `~/.local/bin` to the remote command search path and starts a
Unix listener. The managed command uses a gateway-owned control home under
`~/.local/state/gw-ssh`, scoped to the gateway configuration and native home.
It redirects only the original `app-server proxy` child's control home to that
socket. Inference and account discovery retain the original native home. Codex's
own daemon socket is not replaced. A live gateway listener is reused; a crashed
socket is recovered only when its private ownership record matches.
Add the host under Settings, Connections, SSH, then select its workspace.
The built-in Control other devices connection reaches the native engine directly
and bypasses a desktop or SSH wrapper. The separate
[native transport adapter](native-remote.md) reuses the machine's original
registration and routes that connection through the same gateway router. Its
rendered checks are still in progress on the test Mac.

On startup, a bounded native app-server process refreshes its own model metadata.
The adapter copies only public model rows from that engine's configured catalog
or model cache. It validates that the rows cover the engine's available models
and writes a combined catalog. Cache identity and authentication are excluded.
The public rows form a combined catalog for gateway executors. The original
native process keeps its native model and account defaults. The adapter registers
only the added `subscription_gateway` provider through process arguments, so
saved gateway chats can resolve that provider when read or resumed. It does not
write the native configuration. A mismatched or
unavailable cache prevents startup.

Gateway default selections are saved to private `desktop-preferences.json` in
the gateway state directory. Model, effort, summary, and service-tier writes are
scoped to that file for both gateway and native model choices. String `replace` and
`upsert` operations are supported. Writes into native profiles, native version
guards, and batches mixing native changes with gateway defaults are rejected.
All other configuration writes are rejected, including the legacy whole-config
write. Obsidian-managed native settings remain the source of truth.

Each adapter connection rereads private preferences when reading settings or
starting a chat. Preference updates use a shared file lock and merge the latest
saved values. Two desktop connections cannot return a cached reasoning level or
overwrite an unrelated preference change with an older snapshot.

The installed desktop build recognizes `CODEX_CLI_PATH` and
`CODEX_APP_SERVER_FORCE_CLI`. These are implementation hooks, not an established
public desktop integration API. `scripts/codex-desktop-shim` is an executable
wrapper for the first hook. It accepts `GATEWAY_CONFIG`, `GATEWAY_NODE_PATH`, and
`GATEWAY_CODEX_PATH` when its defaults do not match the machine.

To test a fresh desktop launch, quit the app normally with Command-Q and keep
the gateway daemon running. The launcher refuses to stop a running app. It starts
the signed binary directly with explicit environment variables and saves a private
receipt with its PID. A launch receipt does not prove rendered model selection.

```sh
gateway desktop --config /absolute/path/gateway.local.json
```

Use `--native-home PATH` for an isolated native test home. Omit it to keep the
original native account home. The launcher does not edit either native config
or authentication files. LaunchServices can reuse an existing instance, so an
`open -a` invocation alone is insufficient evidence that overrides took effect.

`gateway desktop register` stores a managed per-user LaunchAgent and sets only
the desktop CLI override variables for future launches. The agent restores them
at login and does not open or quit the app. Registration refuses an unrelated
existing CLI override. `gateway desktop unregister` removes its own overrides.
This keeps normal Dock launches configured after initial activation without
editing the Obsidian-managed native configuration.

Gateway chats receive a current-chat title tool. It reads native saved metadata
and uses `thread/name/set` for renames. The adapter forwards the resulting live
name notification and rejects title arguments targeting another chat. Native
chats retain their existing tools. Read-only saved-chat metadata needs neither
gateway inference nor model discovery.

Choose a gateway model in a **new chat**. A loaded chat cannot switch between
native and gateway providers in this Codex version. The adapter rejects that
change before inference. Switching Claude and Codex 2 inside a gateway chat works
because they share the gateway provider and its account-scoped replay handling.
Native return from gateway history is not supported: a real probe failed on
foreign item IDs. The adapter does not rewrite stored native history to bypass it.

Gateway executors enable Codex's active-step model switching. The adapter forwards
`thread/settings/update`, `turn/settings/update`, `turn/steer`, and goal operations
with their original turn IDs and authorization fields. A thread-level model
selection remains the default after a saved chat resumes. An active-turn model
update applies at the next inference step. A captured tool step keeps its approval
requirements; changing thread access updates subsequent turns.

These controls passed live tests with Claude Sonnet 5.5 and Codex 2 GPT-6.1-Sol.
Goal creation, reads, updates, notifications, and clearing were tested. Automatic
goal continuation and every rendered control remain separate desktop checks.

The launch procedure and real Claude/Codex 2 conversations have been verified
in the rendered desktop on MacBook Pro 2. Initial activation requires a fresh
app launch with these environment variables. Test on another machine before
relaunching a working app.

Max and Ultra are separate desktop display choices. Under Model features, enable
the offered levels in Available reasoning efforts. Availability varies by model
and the app's feature settings. The gateway does not rewrite those settings or
advertise unsupported provider effort levels.

The adapter fetches the inference host's public catalog when listing models and
starting gateway work. A changed catalog starts a fresh gateway executor for new
chats. Loaded native and gateway chats keep their connections. To select a newly
added model in an older loaded gateway chat, close and resume that saved chat, or
start a new one. Ephemeral chats cannot be resumed after their executor exits.

The desktop query itself has a five-minute cache and refetches on focus in the
installed build. Catalog changes require no app restart after initial activation,
but immediate visible picker updates are not guaranteed. There is no fabricated
account-change notification to force a refresh.

Gateway executors use a private configuration home and share native chat storage.
They do not copy the primary auth file. See [architecture](architecture.md) for
configuration isolation, catalog generations, and failure recovery.
