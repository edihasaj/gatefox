---
summary: 'Claude Desktop served by the gateway itself: no adapter port, no second gateway, and picker rows from the gateway model list.'
read_when:
  - Connecting Claude Desktop to GateFox without the separate adapter and private inference process
  - Changing the Claude-safe model IDs, the Anthropic model list, or `claude-desktop configure --direct`
  - Moving an adapter profile to direct serving
---

# Claude Desktop, served directly

Claude Desktop refuses a model ID that names GPT or Qwen, so it cannot name
gateway aliases such as `codex/gpt-6.1-sol`. Until now a separate loopback
adapter translated Claude-safe IDs into aliases. The gateway now resolves
those IDs itself, so the app can connect to the same listener Codex and
Claude Code use.

```text
before   Claude Desktop → adapter :3467 → (private inference) → gateway → providers
direct   Claude Desktop ──────────────────────────────────────→ gateway → providers
```

Nothing else is installed. There is no adapter process, no second gateway
configuration, no extra port, and no LiteLLM-style proxy. Every model the
gateway's catalog shows becomes one picker row with its real provider and
model label: Claude accounts, GPT accounts, local models, and API models such
as DeepSeek through OpenRouter.

## Set it up

The Claude Desktop configuration library must already contain one selected
profile named `GateFox`, as for the [adapter profile](claude-desktop.md#prepare-the-desktop-profile).
With the gateway running:

```sh
gateway claude-desktop configure --direct
```

This reads the gateway's model list and writes a candidate profile to
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
| `--model ID_OR_ALIAS` | Lists that model first, by row ID or gateway alias. Without it, the model the profile already starts with stays first. |
| `--native-model-metadata` | Writes opaque row IDs with `behavesAs`, for an app version that reads it. See [native model metadata](claude-desktop-native-metadata.md). |

`--port` and `--primary-claude-provider` belong to the adapter profile and are
refused with `--direct`.

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

This check uses no account and no paid inference. The rendered Claude Desktop
picker against a direct profile, the `/model` picker after discovery, a real
provider turn selected in the app, and Auto mode through a direct profile
have not been verified yet.

Return to the [Claude Desktop guide](claude-desktop.md).
