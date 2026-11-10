---
summary: 'Opt-in native Claude Desktop model metadata, saved-chat migration, and verified controls.'
read_when:
  - Enabling native effort controls with behavesAs on a stock Claude Desktop app
  - Changing Claude Desktop metadata or migrating old model-ID mappings
  - Running the isolated native metadata proof
---

# Native model metadata

On a Claude Desktop version that supports `behavesAs` in its inference model
profile, prepare a candidate with:

```sh
gateway claude-desktop configure --gateway-config /absolute/claude-gateway.json \
  --native-model-metadata
```

This mode keeps the stable opaque `claude-hg-route-<decimal>` ID for each
secondary model and adds `behavesAs: "claude-opus-5"` to rows that advertise
reasoning levels. Claude uses its native client handling for that declared
model, including effort controls. The visible label and adapter route still
identify the actual provider and account. This does not modify or re-sign
Claude.app, enable Fast or Ultracode, or establish the provider's context window.
The adapter still bounds the requested effort to the route's advertised levels.

The flag is configure-only and off by default. Older clients retain the existing
model-ID mapping unless the operator explicitly opts in. Review the generated
candidate before applying with the same flag and `--apply`, after quitting
Claude. Both earlier opaque IDs and the `claude-opus-5[hg-route-<decimal>]`
IDs remain accepted by the adapter for saved chats. Explicit effort caps survive
regeneration and migration between the two modes.

On 10 November 2026, unmodified signed Claude Desktop 4.23118.1 passed an
isolated synthetic check with native CLI 2.1.299. The opaque reasoning row showed
Low, Medium, High, Extra and Max; a second row capped at High omitted Extra and
Max. The actual adapter received Max for the first route and Low for the second.
After quitting and relaunching the fixture app, its chat, selected model and Low
effort survived, and a new turn completed. This used no provider account or paid
inference, and does not qualify real-provider cache behavior or long compaction.
The CLI control without `behavesAs` also passed explicit effort flags: the new
benefit verified here is the Desktop control, not a different effort transport.
See the [picker capture](evidence/claude-native-metadata-2026-11-10/effort-menu.png)
and [sanitized receipt](evidence/claude-native-metadata-2026-11-10/verification.json).

Run the native CLI proof after building:

```sh
node scripts/e2e-claude-native-metadata.mjs --claude /absolute/path/to/claude
```

`--serve` creates a separate profile library containing only the two fixture
models, plus `gui-cli` and `gui-workspace`, and keeps the loopback adapter alive
for a manual GUI check. Set `fixture_root` to the actual root printed by the
runner, then launch the unmodified signed app:

```sh
CLAUDE_CONFIG_DIR="$fixture_root/gui-cli" \
  /Applications/Claude.app/Contents/MacOS/Claude \
  --user-data-dir="$fixture_root/desktop-3p" --use-mock-keychain
```

Use only these fresh directories. Never use mock encryption with a real profile
or account. Choose `gui-workspace` in the test app before sending a prompt.
Stop the fixture after closing its test app; copy its compact receipts before
cleaning its task directory.

Return to the [Claude Desktop guide](claude-desktop.md).
