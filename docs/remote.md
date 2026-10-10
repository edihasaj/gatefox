---
summary: 'Share one gateway catalog across trusted SSH-connected machines.'
read_when:
  - Connecting a MacBook or remote Codex client to a gateway on another host
---

# Remote gateway

Run `gateway serve` on the inference host. Keep its provider registrations and
native Claude account directories there. Use one authoritative host when you
want every client to see the same configured models.

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
ssh user@host 'cd /path/to/subscription-gateway && node dist/cli.js token' \
  > .state/remote-client-token
```

Fetch the host's catalog and generate client settings:

```sh
node dist/cli.js codex-config --model claude-sonnet-4-6 \
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
has not yet registered a separate gateway Codex OAuth account. No launchd service
or automatic tunnel restart is installed.
