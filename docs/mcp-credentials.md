---
summary: 'Prevent interactive MCP OAuth Keychain prompts on an unattended Mac.'
read_when:
  - Investigating a gateway-codex prompt for Codex MCP Credentials
  - Configuring MCP authentication on a headless gateway host
---

# MCP credentials on an unattended Mac

Codex's default `mcp_oauth_credentials_store = "auto"` can read the macOS
Keychain before falling back to a file. A Keychain authorization dialog can
therefore hold an MCP operation open on an unattended execution host. Signing
the executor gives it a stable identity, but does not remove locked-Keychain
or per-item authorization requirements.

For a host whose operator chooses noninteractive MCP credential storage, set
this top-level value in its native Codex `config.toml`:

```toml
mcp_oauth_credentials_store = "file"
```

This is Codex's supported OAuth file backend, not a timeout or a Keychain grant.
It stores future MCP OAuth credentials in `CODEX_HOME/.credentials.json`.
Protect that file and its directory with owner-only access. Bearer-token and
stdio MCP configurations do not need to be removed. Provider subscription
authentication is a separate setting and should not be changed for this fix.

See the [official Codex configuration reference](https://developers.openai.com/codex/config-reference/).

## Existing gateway engines

The gateway copies client configuration into isolated executor homes. Shared
generations preserve their existing snapshots, including across service
restarts. Updating only the native configuration does not update those files.

1. Resolve account-home configuration symlinks and update their owned target
   once. Preserve all unrelated settings and keep a private backup.
2. Apply the same top-level setting to the host's existing executor snapshots,
   under `state/desktop-generations/*/desktop-engine/config.toml`, and the
   private `state/desktop-engine/config.toml` if present. Validate the parsed
   configuration before and after the edit and require owner-only permissions.
3. Through each live engine's administrative connection, check `config/read`,
   call `config/mcpServer/reload`, and repeat `mcpServerStatus/list`. Keep
   replies in memory; report only the credential backend, server names,
   authentication statuses and tool counts.
4. Reconnect existing desktop adapters normally when their work is settled.
   An adapter caches its startup settings and can otherwise supply an older
   credential-store preference when a new executor generation is created.
   Do not force a service restart to clear those clients.

File mode does not migrate OAuth tokens out of Keychain. An MCP that actually
uses Keychain-only OAuth credentials may need a new login using the file
backend. Never read a token into logs or delete the old entry as a diagnostic.
Successful repeated inventories prove the checked live operations; they do
not establish that every MCP is authenticated or exposes tools.

This is a machine configuration repair, so it needs no gateway release. Report
any independent pending release adoption separately using
`gateway rollout --verify --json` and its existing idle guards.
