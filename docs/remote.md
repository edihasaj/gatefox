---
summary: 'Use GateFox across several Macs: share one Mac''s accounts with others, or work on another Mac over SSH from the Codex app or the Claude app.'
read_when:
  - Adding a second Mac to GateFox, or connecting a MacBook to the main Mac
  - Working on another Mac over SSH from the Codex app or the Claude app
  - Changing client-only configurations, tunnels or remote SSH registration
---

# Other Macs

<a id="remote-gateway"></a>

There are two separate things you may want, and they combine:

| Goal | How | Who runs the model call |
| --- | --- | --- |
| **Use the main Mac's accounts on a laptop** | The laptop gets a client token and a tunnel | The main Mac's gateway |
| **Work in a project on another Mac** (files, terminal, tools there) | Codex app: SSH connection · Claude app: SSH environment | See below |

## Share one Mac's accounts

Keep every account on one Mac. Each other Mac gets only a client token and an SSH
tunnel; no account credentials are copied. On the other Mac, after installing GateFox:

```sh
umask 077; mkdir -p ~/.local/state/gatefox-client
ssh you@main-mac 'gateway token' > ~/.local/state/gatefox-client/client-token
gateway setup --client --port 3459 --token-file ~/.local/state/gatefox-client/client-token
gateway tunnel install --tunnel-id main --host you@main-mac --port 3459 --remote-port 3457
gateway desktop register && gateway doctor
```

The tunnel runs inside the existing GateFox service; nothing else starts at login. The
client token unlocks every account on the main Mac, so keep it owner-only and give it
only to your own devices. The main Mac must stay awake and reachable.

Model selection stays on the main Mac: run `gateway discover … --load` there, and
every client sees the change.

## Work on another Mac over SSH

| | Codex app | Claude app |
| --- | --- | --- |
| Add the host | Settings → SSH connections, using an alias from `~/.ssh/config` | **New environment → SSH → Add SSH connection…** |
| Prepare the host | `gateway ssh register --codex ORIGINAL_PATH` on the host | Nothing; the host needs no GateFox |
| Prepare this Mac | Nothing | `tailnetListener` and `configure --direct --tailnet --ssh-host …` ([steps](claude-desktop-direct.md#ssh-environments)) |
| Models in that session | The host's own gateway | This Mac's gateway, over Tailscale HTTPS |
| Network | Only SSH | SSH, plus Tailscale with HTTPS Certificates on |

In both apps, files, the terminal and tools run on the host, while the chat stays in
this Mac's window.

## A separate Codex CLI home

To try gateway models in the Codex CLI without touching your main settings, generate a
complete configuration in its own home:

```sh
mkdir -p ~/.config/gatefox/clients/codex
gateway codex-config --model codex/gpt-6.1-sol > ~/.config/gatefox/clients/codex/config.toml
CODEX_HOME=~/.config/gatefox/clients/codex codex
```

On a client-only Mac add `--endpoint http://127.0.0.1:3459/v1 --token-file
~/.local/state/gatefox-client/client-token`. The command saves a public catalog next to
the token; run it again after the main Mac changes its model selection. The Codex
client owns its workspace and runs tools locally; moving inference to another Mac does
not move file edits there.

## Details

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
The native control panel shows this client-only configuration as a read-only
shared catalog and identifies the serving host through authenticated
`GET /v1/gateway-info`. An older host without that endpoint must be updated to
show its catalog in the control panel; inference and the existing model endpoint
are unchanged. Connection and model-selection editing stays on the host.
Register the backend that owns the chat's workspace. Sharing the catalog does
not transfer local workspace files or automatically configure an SSH execution
backend that bypasses the desktop adapter.

For desktop SSH projects in the Codex app, run `gateway ssh register --codex ORIGINAL_PATH` on
the remote Mac. Then add its existing host alias under the client's SSH connection
settings. Those rows are native SSH connections: the desktop runs Codex on the
remote Mac, so the gateway models available in them come from that Mac's own
`gateway ssh register` and gateway configuration, not from the client's catalog.
The gateway listener on that Mac follows installs by itself: the first
connection made after an update starts a listener on the new release, and any
session already running finishes on the old one.
Only the listener owns upgrade retirement for Unix sessions. A session cannot
upgrade its containing process by disconnecting: reconnecting its native proxy
would return to that same loaded listener. Per-session idle upgrade watches are
therefore reserved for stdio adapters, whose parent actually starts a new process.
Managed listeners retire when no sessions remain, or an installed-release
bootstrap publishes a replacement alias without terminating existing sessions.

For drop diagnosis, correlate client connection-state timestamps with the remote
`unix_session_end` telemetry record. It includes a process-local `sessionId`,
fixed `cause`, numeric WebSocket `closeCode`, and `durationMs`. Causes distinguish
local session end/failure, listener shutdown, queue/protocol limits, socket errors,
and an otherwise unclassified transport close. A `transport_closed`/1006 record
alone does not prove a Wi-Fi, SSH, or peer fault; it requires client-side evidence.
No close reason, exception text, address, RPC body, or tool arguments are logged.
`gateway diagnostics --since 1` groups them under `connectionEnds` by cause and
close code; use the underlying event timestamps to correlate both ends.
After a reboot, it also recovers its own dead socket when macOS has changed the
filesystem device number. See [automatic reboot recovery](reboot-recovery.md)
for ownership checks and the separate desktop-startup boundary.

On macOS, the SSH proxy gives the original Codex byte copier fresh stdout and
stderr pipes. Node forwards their opaque bytes with backpressure and waits for
output to drain before returning the native exit status. Inheriting a descriptor
Node already made nonblocking could make the native copier fail with
`Resource temporarily unavailable (os error 35)` when its output filled, producing
an abnormal WebSocket close even though the listener and shared engines survived.
The regression pauses the caller while the real signed native proxy sends a
4 MiB stream, then verifies every byte and its successful exit. No protocol frames,
tool calls or reconnects are replayed by this forwarding.
The app's Unix socket and native proxy must reach the gateway adapter on that
machine; the built-in Control other devices connection currently bypasses it. See
[the adapter setup](app-server.md) for command protection and removal.
