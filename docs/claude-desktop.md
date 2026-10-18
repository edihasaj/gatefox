---
summary: 'Opt-in Claude Desktop model aliases, isolated account catalogs, setup, and tested limits.'
read_when:
  - Adding Claude Desktop as a gateway client.
  - Showing multiple GPT accounts or local models in Claude's model picker.
  - Installing or updating the Claude-only adapter without changing Codex.
---

# Claude Desktop

Claude Desktop rejects model IDs that name GPT or Qwen. The optional Claude
adapter exposes stable opaque route IDs while retaining the actual provider and
model in the picker label. Native Claude IDs still select the primary Claude
account. A model is never redirected to another account after a failure.

```text
Claude Desktop: truthful model labels
    → Claude-only loopback adapter
    → gateway Messages endpoint
        ├── Claude: primary subscription
        ├── Codex: first registered GPT account
        ├── Codex 2: second registered GPT account
        └── Local: configured Qwen server
```

This is an opt-in third-party inference profile. It does not add models to the
first-party Claude subscription connection or modify the signed Claude app.
The app keeps its third-party history under `Claude-3p`.

## Account ownership and isolation

Give every GPT account its own gateway provider ID, model aliases, and scoped
Sign in with ChatGPT registration. Register the intended email with
`gateway login PROVIDER --account-email EMAIL --config PATH`. Native Codex
authentication is not a gateway credential source. Copying a native login does
not grant the gateway's required scopes.

When the existing Codex gateway must remain unchanged, create a separate
gateway configuration, state directory, fixed loopback port, and service label
for Claude. The existing provider modules can serve this instance. Run it with
`gateway serve --config PATH` under its own service. Do not use
`gateway service install` for a second instance: that command owns the shared
gateway service label.

An existing scoped registration on the same inference host can be referenced
through its existing absolute credential path. Do not create independent copies
of rotating refresh credentials. For several Macs, one inference host and
authenticated loopback SSH forwards avoid distributing provider credentials.
Only the gateway client token and non-secret model ownership metadata belong on
the other clients.

Qwen remains the configured local or tailnet API provider. Use the existing
endpoint and credential; selecting it does not turn it into a Claude model.

## Prepare the desktop profile

The configuration library must already contain one selected profile named
`Harness Gateway`. Its credential helper and unrelated settings are preserved
unless the configure command explicitly supplies the selected gateway helper.

```sh
gateway claude-desktop configure --gateway-config /absolute/claude-gateway.json
```

By default, this prepares candidate files under
`~/Library/Application Support/Claude-3p/alias-trial/candidate/`. Review the
profile and adapter configuration before applying. The source configuration is
read-only; it may contain the gateway's provider configuration or only its model
ownership metadata. Its authenticated live model catalog must agree with that
metadata.

The default adapter port is 3467, the primary Claude provider ID is `claude`,
and the default model is `claude-fable-5-1`. The command's help describes the
overrides for other installations. It refuses collisions, missing primary
routes, invalid catalogs, and an upstream endpoint that loops back to itself.

Native IDs map explicitly to the primary provider's public aliases. Secondary
routes use `claude-hg-route-<decimal hash>` identifiers derived from their public
aliases, with real `labelOverride` values. Secondary routes never claim a Claude
family or an unverified 1M context capability. Future accounts such as
`Claude 2` remain separate routes.

## Apply and run

Finish Claude work and quit its GUI before applying:

```sh
gateway claude-desktop configure --gateway-config /absolute/claude-gateway.json --apply
gateway claude-desktop install --config /absolute/Claude-3p/desktop-adapter/config.json
gateway claude-desktop status --config /absolute/Claude-3p/desktop-adapter/config.json
```

The configure step stages the two files, creates private backups, and restores
their exact previous bytes if replacement fails. It validates selected profile
identity and path confinement before writing. The macOS installer owns only the
Claude adapter's LaunchAgent and refuses an already loaded service or occupied
port. It does not stop the shared gateway or register a Codex client.

For foreground diagnostics:

```sh
gateway claude-desktop serve --config /absolute/adapter-config.json
```

The adapter binds only `127.0.0.1`, authenticates every endpoint, preserves query
strings and tool content, and forwards status and streaming failures. It serves
the model catalog and individual model detail required by the native picker.
An optional private audit records only configured route identity and status,
never prompts, tool arguments, headers, or credentials.

## Tools and subagents

The Claude harness executes tools and manages agents. The gateway continues to
serve inference only. The adapter does not generate roles, choose worker models,
change permissions, or silently substitute a model.

The Responses-backed GPT route can require optional tool properties to have a
value. For opted-in `codex-subscription` and `responses-api` routes, the adapter
represents optional non-nullable plain properties as nullable on the wire and
removes only those introduced nulls from returned tool arguments. Required
values, existing nullability, and explicit non-null choices are preserved.
Reference and composition subtrees remain unchanged. This conversion is scoped
to the Claude client and does not alter the existing Codex request path.

## Verified coverage and limits

The initial macOS trial verified the rendered picker, real GPT and Qwen replies,
switching models in one chat, exact file reads/writes, mixed-model native
subagents, skills, MCP, background agents, resume, and GPT image input. Model
identity was checked in child transcripts and route records rather than relying
on the assistant's claim.

- Use **Manual** permissions for compatibility models. The tested Auto
  permission classifier could not assess an opaque GPT alias and failed closed;
  the same native subagent task succeeded in Manual mode.
- Opaque aliases use Claude's generic 200K client context estimate and do not
  expose the native effort picker. The estimate is not the provider's true limit.
- Native Claude mobile Remote Control excludes custom gateways and proxies.
  Desktop aliases do not remove that restriction.
- Provider capabilities still apply. A text-only Qwen route does not accept
  images, and switching providers replays the conversation.
- Short connectivity proofs do not qualify long-session compaction or every
  possible MCP JSON schema.

Run `npm run build`, `npm run check`, and `npm test`. The adapter's loopback
fixtures also run separately with `npm run test:claude-desktop`. Packaging
includes both adapter modules; no Python runtime is required.
