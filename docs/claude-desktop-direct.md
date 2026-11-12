---
summary: 'Set up the Claude app (Claude Desktop) with GateFox: first setup, switching configurations, SSH environments on other Macs, and what the gateway does for it.'
read_when:
  - Setting up the Claude app with GateFox for the first time
  - Connecting Claude Desktop to GateFox without the separate adapter and private inference process
  - Changing the Claude-safe model IDs, the Anthropic model list, or `claude-desktop configure --direct`
  - Moving an adapter profile to direct serving
  - Starting Claude Desktop Code sessions on another Mac over SSH, or changing the tailnet listener
---

# Claude Desktop (the Claude app)

GateFox shows every model it serves in the Claude app's model picker: your Claude
accounts first, then Codex accounts, local models and API models. The app talks to
the gateway on this Mac directly; nothing else is installed.

Claude Desktop refuses a model ID that names GPT or Qwen, so it cannot name
gateway aliases such as `codex/gpt-6.1-sol`. Until now a separate loopback
adapter translated Claude-safe IDs into aliases. The gateway now resolves
those IDs itself, so the app can connect to the same listener Codex and
Claude Code use.

```text
before   Claude Desktop → adapter :3467 → (private inference) → gateway → providers
direct   Claude Desktop ──────────────────────────────────────→ gateway → providers
```

There is no adapter process, no second gateway configuration, no extra port and
no LiteLLM-style proxy. Every model the gateway's catalog shows becomes one picker
row with its real provider and model label, such as **Claude · Opus 5.5**,
**Claude 2 · Opus 5.5** or **Codex · GPT-6.1-Sol**.

## Set it up

You need GateFox running on this Mac (`gateway doctor` passes) and the Claude app
installed.

1. **Create a configuration named GateFox in the Claude app, once.** Open the
   app's third-party configuration window (**Developer → Configure Third-Party
   Inference…**; see Anthropic's
   [in-app configuration guide](https://claude.com/docs/third-party/claude-desktop/in-app-configuration)).
   Set **Inference provider** to **Gateway**, the gateway base URL to
   `http://127.0.0.1:3457`, name the configuration `GateFox`, and apply it. The next
   step fills in everything else. A configuration still named `Harness Gateway` is
   also accepted and renamed.
2. **Quit the Claude app** (⌘Q), then write the GateFox settings:

   ```sh
   gateway claude-desktop configure --direct --apply
   ```

3. **Open the Claude app.** The account menu at the bottom left reads
   **you · GateFox**, and the model picker lists your Claude accounts first.

Without `--apply` the command only writes a candidate for review. It reads the gateway's model list and writes a candidate profile to
`~/Library/Application Support/Claude-3p/alias-trial/candidate/desktop-profile.json`.
Review it, finish Claude work, quit the app, and apply:

```sh
gateway claude-desktop configure --direct --apply
```

`--apply` replaces only the selected profile, after writing a private backup
under `Claude-3p/setup-backups`, and refuses to run while Claude is open. It
sets the gateway origin, the credential helper, and the model rows. Unrelated
profile settings are kept. Run the command again after you add, remove or hide
models in the gateway; the picker does not refresh by itself.

| Option | Effect |
| --- | --- |
| `--gateway-config PATH` | Uses that gateway configuration for the port and client token. The default is the installed configuration. |
| `--endpoint URL --token-file PATH` | Names a gateway reached through a loopback SSH forward. Only its public model list is read. |
| `--tailnet` | Names this Mac's Tailscale HTTPS address, `https://NAME.ts.net:PORT`, instead of `127.0.0.1`. Needed for [SSH environments](#ssh-environments). |
| `--ssh-host HOST` | With `--tailnet`, adds the host to the profile's `sshHostAllowlist`. Repeat it, or separate hosts with commas. |
| `--model ID_OR_ALIAS` | Lists that model first, by row ID or gateway alias. Without it, the model the profile already starts with stays first. |
| `--native-model-metadata` | Writes opaque row IDs with `behavesAs`, for an app version that reads it. See [native model metadata](claude-desktop-native-metadata.md). |

`--port` and `--primary-claude-provider` belong to the adapter profile and are
refused with `--direct`.

Rows are listed Claude accounts first: the primary Claude account, then the
other Claude accounts, then every other provider in the gateway's catalog order.

On a Claude app that reads native model metadata (5.1231 or later was checked), add
`--native-model-metadata` so Codex and other reasoning rows show the app's own effort
control.

### Switch configurations

The Claude app keeps third-party configurations and their chats separately from your
normal Claude sign-in, under `~/Library/Application Support/Claude-3p`. Switch between
configurations from the account menu: **Inference configuration**, choose one, then
**Apply Changes**. Every `--apply` keeps the previous profile in
`Claude-3p/setup-backups`.

## SSH environments

Claude Desktop can run a Code session's Claude Code engine on another machine over
SSH, while the window stays on this Mac. With a third-party profile such as GateFox,
two rules from Anthropic decide whether that works
([SSH remote sessions on 3P](https://claude.com/docs/third-party/claude-desktop/ssh-remote-sessions)):

1. SSH stays off, and **New environment** offers no SSH tab, until the profile sets
   `sshHostAllowlist`.
2. The remote engine calls the profile's endpoint **from the remote host**, with the
   token the credential helper prints on this Mac. Claude Desktop refuses a loopback
   endpoint (`localhost`, `*.localhost`, `127.x`, `::1`, `0.0.0.0`) for those sessions
   with "SSH sessions can't use your model provider settings". It checks the literal
   name only, and resolves nothing.
3. Every other endpoint must use `https://`. The app accepts plain `http://` only on
   loopback, and its configuration window drops any other `http://` URL when it saves.

Codex's SSH support carries the gateway inside its own SSH connection. Claude Desktop
owns its SSH connection and opens no tunnel for inference, so the gateway must answer
on an address the host can reach, over HTTPS. With `tailnetListener` the gateway also
listens on this Mac's own Tailscale addresses, with TLS and this Mac's Tailscale
certificate:

```text
local session   Claude Desktop ─────────────────────────────► https://NAME.ts.net:3457 ─┐
SSH session     Claude Desktop ══SSH══► host: Claude Code ───► https://NAME.ts.net:3457 ─┴► this Mac's GateFox
```

The gateway fetches the certificate itself with `tailscale cert`: a Let's Encrypt
certificate for this Mac's MagicDNS name, which Tailscale renews. The gateway asks for it
again every 12 hours and serves a renewed one to new connections without rebinding. Tailscale
prints the pair to standard output and the gateway keeps it in memory only; nothing is
written to disk, which also suits the sandboxed App Store build of Tailscale. The tailnet must allow
HTTPS certificates (Tailscale admin console → **DNS** → **HTTPS Certificates**). Without a
certificate the tailnet listener stays closed and records `tailnet_listener` with state
`certificate_unavailable`; it retries every five minutes.

Both kinds of session use this Mac's gateway, its accounts and its model list, as a
Codex SSH chat does.

### Set it up

You need Tailscale on this Mac and on the host, with MagicDNS and **HTTPS
Certificates** turned on for the tailnet (Tailscale admin console → **DNS**). Both the
standalone and the App Store build of Tailscale work. Check that `ssh HOST` already
works from a terminal on this Mac.

1. Add `"tailnetListener": true` to the gateway configuration. The running gateway
   fetches its certificate and starts listening within about a minute, without a
   restart, on the same port.
2. Quit the Claude app, then write the profile. Name each host both by the alias you
   type in the app and by the address that alias resolves to (`ssh -G HOST | grep
   '^hostname'`), because the app checks the resolved address:

   ```sh
   gateway claude-desktop configure --direct --tailnet \
     --ssh-host macbook-server --ssh-host 100.73.86.17 --apply
   ```

3. Open the Claude app. Choose the environment selector under the prompt box, then
   **New environment** → **SSH** → **Host** → **Add SSH connection…**:

   | Field | Value |
   | --- | --- |
   | Host | the alias from `~/.ssh/config`, such as `macbook-server` |
   | User | your user on the host, or blank when the SSH config sets it |
   | SSH key | the `IdentityFile` that `ssh -G HOST` prints. Press ⌘⇧. in the file picker to show `.ssh` |

   Accept the host key, choose a folder on the host and select **Create
   environment**.

To add a host later, run step 2 again with every host listed.

The host needs the Claude Code engine's own requirements and a route to this Mac over
Tailscale; it needs no GateFox. `--ssh-host` entries are hostnames, `*.domain`
wildcards or IP addresses, matched against the `HostName` that `~/.ssh/config` gives for
the entered host. `*` is refused, because every listed host receives the gateway token
for the session. Without `--ssh-host`, an allowlist already in the profile is kept.

### What the tailnet listener accepts

| Check | Behavior |
| --- | --- |
| Addresses | This Mac's non-internal addresses in `100.64.0.0/10` and `fd7a:115c:a1e0::/48`, rechecked every 30 seconds, so an address that appears after login is picked up and one that leaves is closed. |
| Peers | Only Tailscale addresses. Any other peer is closed before the TLS handshake. |
| Transport | TLS 1.2 or later with this Mac's Tailscale certificate. Plain HTTP is not served there. |
| Requests | Handed to the loopback listener's own HTTP server: the same client token, the browser-origin refusal, admission limits and timeouts. Only `GET /health` answers without the token, as on loopback. |
| Upgrades | An in-place upgrade keeps the sockets and reconciles them with the configuration it adopts. Setting the key to `false`, or removing it, closes them. |

Every tailnet device can reach the port, and any device holding the client token can use
every account this gateway serves. Turn the listener on only on Macs whose SSH sessions
need it, and issue the token only to machines you trust.

The profile names the MagicDNS name, which stays the same when the Tailscale address
changes. If the Mac or the tailnet is renamed, run the `configure` command again. Each listener start records a `tailnet_listener` telemetry event with the number of
addresses served, not the addresses themselves.

## Model IDs

The gateway derives the IDs from each alias alone, with the same function the
adapter profile uses, so an ID is stable for as long as its alias exists.

| Row | ID the app sends | Resolves to |
| --- | --- | --- |
| Model of the primary Claude account | Its own ID, such as `claude-fable-5-1` | The gateway's bare-name routing |
| Any other route with reasoning levels | `claude-opus-5[hg-route-<n>]`, or `claude-hg-route-<n>` with `behavesAs` | That alias |
| Any other route without reasoning levels | `claude-hg-route-<n>` | That alias |

An ID is another spelling of one fixed alias. It never selects a different
account, and a failed request is never moved to another model. The gateway
also accepts the hidden effort and speed aliases that earlier adapter profiles
listed, so a chat saved against an adapter profile continues when the adapter
used the same gateway aliases.

The primary Claude account is the one marked `defaultForBareModels`, or the
only Claude subscription when there is exactly one. With two Claude accounts
and no designation, no account keeps native IDs: every Claude model is listed
as a route row with its account label, and Auto mode has no reviewer (see
[auto mode](messages.md#auto-mode)). Mark one account to keep its native rows:

```json
{ "id": "claude-primary", "type": "claude-subscription", "defaultForBareModels": true }
```

That setting also decides which account serves a bare Claude model name from
any other client, so set it deliberately.

## What the gateway does for these IDs

The behavior matches the adapter and applies only to a request that names a
Claude-safe ID. A request that names an alias is handled as before.

- The reply carries the ID the client named.
- A reasoning effort the route does not offer is lowered to the highest
  offered level below it, or raised to the lowest one. The gateway never adds
  an effort the client did not send.
- An auxiliary review keeps its own generation controls.
- For `codex-subscription` and `responses-api` routes, optional tool
  properties are sent as nullable, and only the nulls introduced that way are
  removed from returned tool arguments. See
  [tools and subagents](claude-desktop.md#tools-and-subagents).
- A row the catalog hides is not listed, but its ID still resolves.

Each resolved request records a `claude_direct_route` telemetry event with the
alias and whether a hidden variant was used. It contains no request content.

## Endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/models` with an `anthropic-version` or `x-api-key` header | Returns the Anthropic model list: one row per visible model, with a `gatefox` object holding the alias, the offered efforts, and the bridge ID. |
| `GET /v1/models` without those headers | Returns the alias list, unchanged. |
| `GET /v1/models/{id}` | Returns one model by row ID, bridge ID or hidden alias. An unknown ID is a 404 in the Anthropic error envelope. |
| `POST /v1/messages` | Resolves a Claude-safe ID as described above. |

`POST /v1/responses` does not accept these IDs.

## Claude Code model discovery

Claude Code can fill `/model` from a gateway when
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is set next to
`ANTHROPIC_BASE_URL`. It keeps only IDs that contain `claude` or `anthropic`,
which is why it used to hide every GPT and local model here. The Anthropic
list above passes that filter, so discovery now returns one row per gateway
model, with its real label.

The [generated settings](messages.md#claude-code-setup) remain the better
setup for Claude Code. They list the gateway aliases themselves and declare
the launch model's context window and default effort. A discovered row is an
ID Claude Code does not know, so it assumes a 200K window for it.

### When it does not connect

| Message in the app | Cause | Fix |
| --- | --- | --- |
| New environment shows no **SSH** tab | The profile has no `sshHostAllowlist` | Run step 2 with `--ssh-host` |
| "SSH host "100.x.y.z" is not allowed by your organization's managed settings" | Only the alias, not its resolved address, is listed | Add the address with another `--ssh-host` |
| "Some saved settings can't be used as written: inferenceGatewayBaseUrl" | The profile has a non-loopback `http://` endpoint, written by 1.9.3 | Choose **Cancel**, not Save; quit the app and run step 2 again on 1.9.6 or later |
| "SSH sessions can't use your model provider settings" | The profile still names `127.0.0.1` | Run step 2; it needs `--tailnet` |
| `configure` says the gateway does not answer on `https://…` | The tailnet listener has no certificate yet | Check HTTPS Certificates in the tailnet, then wait a minute; `gateway diagnostics` shows `tailnet_listener` `certificate_unavailable` meanwhile |

## Moving from the adapter

Apply a direct profile as shown above. The adapter configuration on disk and
a running adapter component are left as they are, so the previous profile in
`setup-backups` still works if you restore it. An idle adapter can stay until
you retire it; nothing connects to it once the profile names the gateway.

If the adapter pointed at a different gateway configuration with different
alias names, the opaque IDs differ, and a chat saved against the old profile
asks you to choose a model again.

## Limits

- Claude Desktop shows its effort control only for a model ID it recognizes,
  or for a row with `behavesAs` on an app version that reads it. Fast mode and
  Ultracode are not offered to third-party profiles by the unmodified app.
- The app estimates the context window from the model ID, not from the list.
  A mapped route inherits a 1M estimate; see the
  [compaction limitation](claude-desktop.md#one-row-per-model-native-thinking-controls).
- The profile holds at most 200 rows. The command reports the count and fails
  instead of dropping a model.
- A catalog that would need more than 1000 hidden effort and speed aliases
  keeps its rows and drops only those hidden aliases.
- Managed routing aliases (`managed/...`) are not listed.
- Claude's mobile Remote Control does not accept a custom gateway, and the
  Claude mobile app has no setting for one. Gateway models reach a phone
  through the ChatGPT app and the [native relay](native-remote.md).

## Verification

On 11 November 2026 the native Claude Code CLI 2.1.299 completed six turns
against a real gateway listener with no adapter, using a synthetic loopback
backend. Bridge rows and opaque rows with `behavesAs` both reached their own
upstream model. A `max` request reached a route that offers up to `high` as
`high`, and `medium` reached a `low`/`high` route as `low`. In the sixth run
the settings held no picker rows: the client's own gateway discovery kept
both listed rows, and a turn on a discovered ID completed. See the
[sanitized receipt](evidence/claude-direct-2026-11-11/cli-verification.json).

```sh
npm run build
node scripts/e2e-claude-direct.mjs --claude /absolute/path/to/claude
```

This check uses no account and no paid inference.

In the app, on 11 and 12 November 2026 (Claude Desktop 4.23118 and 5.1231.2): the
picker listed the direct profile's rows with Claude accounts first, and a real Claude
Opus 5.5 turn sent from the app window completed. Real turns on Claude, Claude 2 and
Codex rows completed through the same endpoint. With `tailnetListener`, another Mac
reached the HTTPS endpoint with certificate verification, was refused without the
client token, and could not reach plain HTTP there. A complete turn in an SSH
environment, the `/model` picker after discovery, and Auto mode through a direct
profile have not been recorded yet.

The [adapter profile](claude-desktop.md) is the earlier setup; it stays supported for
existing installations.
