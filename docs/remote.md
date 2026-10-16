---
summary: 'Share one gateway catalog across trusted SSH-connected machines.'
read_when:
  - Connecting a MacBook or remote Codex client to a gateway on another host
---

# Remote gateway

Run `gateway serve` on the inference host. Keep its provider registrations and
native Claude account directories there. Use one authoritative host when you
want every client to see the same configured models.

Keep model selection on that authoritative host. For example, load only these
four Copilot models while preserving the other providers:

```sh
gateway discover copilot \
  --select gpt-6.1-sol,gpt-5.6-terra,claude-sonnet-5,claude-opus-5.5 --load
```

GPT-5.6-Terra was the latest Terra offered by the registered Copilot account on
11 October 2026. Discovery without `--load` does not change the selection.
Include the selection when loading again; an unrestricted `--load` loads the
provider's full offered catalog.

The desktop and SSH adapters fetch this shared selection. Each device can also
generate an opt-in CLI configuration in a separate home:

```sh
gateway_cli_home="$HOME/.local/state/subscription-gateway-cli"
mkdir -p "$gateway_cli_home"
gateway codex-config --model codex/gpt-6.1-sol \
  > "$gateway_cli_home/config.toml"
CODEX_HOME="$gateway_cli_home" codex
```

Regenerate the CLI snapshot after changing the host's selection. This separate
home uses the secondary subscription routes and has its own settings and history.
The generated file is a complete configuration, not a named profile. The primary
`config.toml` stays unchanged.
An obsolete repo-local `gateway.local.json` overrides the installed configuration
when running development commands. Retire that file after migrating to the
installed configuration to keep one model-selection source.

Open an SSH forward from the client:

```sh
ssh -N -L 127.0.0.1:3458:127.0.0.1:3457 \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 user@host
```

Install the gateway CLI on the client. Transfer only the gateway's client token
over authenticated SSH into an owner-only file. Do not transfer provider tokens:

```sh
umask 077
mkdir -p .state
ssh user@host 'gateway token' \
  > .state/remote-client-token
```

Fetch the host's catalog and generate client settings:

```sh
gateway codex-config --model claude-sonnet-4-6 \
  --endpoint http://127.0.0.1:3458/v1 \
  --token-file .state/remote-client-token > gateway.codex.toml
```

This command needs no local provider configuration or upstream login. It saves a
public catalog next to the token and writes TOML containing a credential-helper
command. Repeat it after the host changes its model selection, then restart Codex.
Use `--catalog PATH` to choose a different snapshot path. The token grants access
to all accounts configured on that daemon; issue it only to trusted machines.

The Codex client owns its workspace and executes tools locally. Moving inference
to Studio does not move file edits to Studio. When Codex itself runs on Studio,
its tools operate on Studio's workspace instead.

The MacBook-to-Studio Claude Max path has been tested with native Codex file
reads, free-form patches, follow-up history, cancellation, and recovery. Studio
has not yet registered a separate gateway Codex OAuth account. MacBook Pro 2 also passed the Claude/Codex 2 tool loop. Its authenticated reverse
SSH forward is supervised by a user LaunchAgent on the inference host.

For the desktop adapter, set the client configuration port to the forwarded
loopback port. Use an absolute client state directory containing the private
`client-token` file. The adapter fetches fresh public metadata from the inference
host, so it does not need provider credentials or a local account discovery run.
CLI profile catalogs remain startup snapshots.

Installed clients can use a configuration without local providers:

```sh
gateway setup --client --port 3459 --token-file ./client-token
gateway tunnel install --tunnel-id host --host user@host \
  --port 3459 --remote-port 3457
gateway doctor
gateway desktop register
```

Copy the client token through authenticated SSH with owner-only permissions.
`gateway doctor` verifies the forwarded public catalog. Each device needs its own
desktop registration; syncing a chat does not register its model provider.
Register the backend that owns the chat's workspace. Sharing the catalog does
not transfer local workspace files or automatically configure an SSH execution
backend that bypasses the desktop adapter.

For desktop SSH projects, run `gateway ssh register --codex ORIGINAL_PATH` on
the remote Mac. Then add its existing host alias under the client's SSH connection
settings. Those rows are native SSH connections: the desktop runs Codex on the
remote Mac, so the gateway models available in them come from that Mac's own
`gateway ssh register` and gateway configuration, not from the client's catalog.
The gateway listener on that Mac follows installs by itself: the first
connection made after an update starts a listener on the new release, and any
session already running finishes on the old one.
The app's Unix socket and native proxy must reach the gateway adapter on that
machine; the built-in Control other devices connection currently bypasses it. See
[the adapter setup](app-server.md) for command protection and removal.
