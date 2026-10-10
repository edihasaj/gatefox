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
Non-server commands, including `--version`, pass through unchanged. WebSocket and
daemon transports are not supported by this adapter.

On startup, a bounded native app-server process refreshes its own model metadata.
The adapter copies only public model rows from that engine's configured catalog
or model cache. It validates that the rows cover the engine's available models
and writes a combined catalog. Cache identity and authentication are excluded.
The resulting catalog is passed as a process argument. The native base config is
not edited. A mismatched or unavailable cache prevents startup.

Gateway default selections are saved to private `desktop-preferences.json` in
the gateway state directory. Model, effort, summary, and service-tier writes are
scoped to that file for both gateway and native model choices. String `replace` and
`upsert` operations are supported. Writes into native profiles, native version
guards, and batches mixing native changes with gateway defaults are rejected.
All other configuration writes are rejected, including the legacy whole-config
write. Obsidian-managed native settings remain the source of truth.

The installed desktop build recognizes `CODEX_CLI_PATH` and
`CODEX_APP_SERVER_FORCE_CLI`. These are implementation hooks, not an established
public desktop integration API. `scripts/codex-desktop-shim` is an executable
wrapper for the first hook. It accepts `GATEWAY_CONFIG`, `GATEWAY_NODE_PATH`, and
`GATEWAY_CODEX_PATH` when its defaults do not match the machine.

To test a fresh desktop launch, quit the app normally, keep the gateway daemon
running, and launch it with the wrapper:

```sh
open -a /Applications/ChatGPT.app \
  --env CODEX_CLI_PATH=/absolute/path/subscription-gateway/scripts/codex-desktop-shim \
  --env CODEX_APP_SERVER_FORCE_CLI=1
```

Choose a gateway model in a **new chat**. A loaded chat cannot switch between
native and gateway providers in this Codex version. The adapter rejects that
change before inference. Switching Claude and Codex 2 inside a gateway chat works
because they share the gateway provider and its account-scoped replay handling.
Native return from gateway history is not supported: a real probe failed on
foreign item IDs. The adapter does not rewrite stored native history to bypass it.

The combined catalog and native/Claude/Codex 2 tool loop have passed through the
real desktop-bundled engine. The rendered picker and this launch procedure still
need manual verification. Do not describe this as a verified desktop install.


The native engine caches its model catalog. A metadata-only test showed that
rewriting the catalog and asking for a native config reload did not update a
running engine. The current adapter loads models at connection startup. Live
catalog propagation to a connected desktop remains unfinished.


The daemon reloads atomically replaced gateway configuration on each request.
Each active inference keeps its original provider snapshot. Invalid updates fail
closed for new authenticated requests until repaired. Listener and state-directory
changes require an explicit restart. A macOS user LaunchAgent can keep the daemon
alive across terminal and app exits; it exports only PATH, not provider secrets.

The desktop adapter stores every model preference in gateway-owned state and
rejects writes into native Codex configuration. It does not edit Obsidian settings.
