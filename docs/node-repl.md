---
summary: 'node_repl (browser, Chrome and computer use) on gateway rows: native evidence, policy rules and the check script.'
read_when:
  - Changing node_repl, auto review or guardian fields on gateway or native catalog rows
  - Investigating why browser, Chrome or computer use is on or off in a gateway chat
---

# node_repl on gateway rows

node_repl runs the browser, Chrome and computer-use tools. Gateway chats get the
same node_repl capability and the same safety policy as native rows, and never a
weaker one. The [Codex 2 rows section](app-server.md#codex-2-rows-and-the-native-catalog)
of the app-server guide summarizes these rules; the code is in
`src/codex-native-rows.ts` and `src/desktop-catalog.ts`.

## Evidence

The SDK reads the policy from the ModelInfo fields `node_repl_disabled`,
`node_repl_auto_review_required`, `guardian` and `auto_review_model_override`. The
native catalog also has `requires_sandboxed_review`, which the gateway SDK ignores.
The following was observed read-only on ChatGPT 26.1007 (the native catalog
embedded in the bundled `codex`, the bundled plugins and `~/.codex/config.toml`) and
in the Codex source (`ModelInfo` in `codex-rs/protocol`):

- node_repl does not depend on code mode. The bundled `unified-computer-use` plugin
  declares `cua_repl` with `omit_tools_from: ["code_mode", "deferred"]`, and
  `~/.codex/config.toml` runs `[mcp_servers.node_repl]` from the app.
  `codex-code-mode-host` contains no node_repl strings, and `gpt-5.5` has no tool
  mode but enables node_repl. Only `tool_mode` follows code mode.
- Every native row has `node_repl_disabled: false`. `gpt-6-astra`, `gpt-6.1-sol` and
  `gpt-6-sol` set `node_repl_auto_review_required: true`, and the other rows set it
  to false. Every row with `visibility: list` has `guardian: null`,
  `auto_review_model_override: null` and `requires_sandboxed_review: false`.
- The rows that require review carry only `auto_review.rejection_instructions`. The
  node_repl review text (`node_repl_policy`) is on the hidden reviewer row
  `codex-auto-review`, which the executor catalog carries as a native row. The four
  6.x rows share `confirmation_policies` and `guardian_v2`, which a Codex 2 row gets
  with its copied `model_messages`. Claude, Copilot and API rows have neither.
- In the SDK, `ModelInfo::computer_use_review_required` lets a `guardian` policy,
  when one is set, decide review instead of the flag: computer use is reviewed
  unless `guardian.computer_use` is absent, null or `disabled`. A null `guardian`
  leaves the flag in charge. A missing node_repl field means `false`.

## Why review cannot run in gateway executors

The SDK reviews node_repl actions with a reviewer model, `codex-auto-review` (the
preferred reviewer in the native catalog), through the executor's own provider,
which is the gateway. The gateway answers that name with 404 `model_not_found`
unless exactly one Codex subscription alias serves it, and the live configuration
has none. Review errors fail closed, so every node_repl action that needs review
would be rejected. This comes from source and configuration, not from a live run.
Routing that slug would send a Claude or Copilot chat's actions to an OpenAI
reviewer, so it stays off (`executorRunsAutoReview = false`) unless Edi approves it.

## Rules

- A Codex 2 row copies `node_repl_disabled`, `node_repl_auto_review_required`,
  `guardian`, `auto_review_model_override` and `requires_sandboxed_review` from its
  native row, with code mode on or off. A value that is not plainly typed is not
  copied, and a node_repl field that is not a boolean becomes `true`.
- A row that needs auto review has node_repl off in gateway executors, because the
  review cannot run there. A row needs review when its `guardian` reviews computer
  use, or when it has no `guardian` and its flag is not plainly `false`. A
  `guardian` that is not an object counts as needing review. Today this covers
  `gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-sol`; rows such as `gpt-6-luna` keep
  node_repl on.
- The native rows that the executor catalog carries for sub-agents naming a model
  directly follow the same rule as the Codex 2 row for that model, so one upstream
  model has one policy in an executor. A native row that states no node_repl policy
  gets node_repl off there, not the SDK default. The native engine's own catalog is
  unchanged.
- A row with no native counterpart (Claude, Copilot, API, or a Codex row whose
  upstream is missing) takes the strictest native policy. It carries no `guardian`,
  so its flag alone decides review. The flag is `true` when any native row needs
  review or has a flag that is not plainly `false`, even when that row's `guardian`
  skips computer-use review, because this row cannot carry that `guardian`.
  node_repl is off when any native row's policy turns it off, or when review is
  required and cannot run. A sandboxed-review requirement carries over. With no
  native catalog both fields are `true`. With node_repl off, these rows have nothing
  to review, so they get neither the confirmation and classifier texts nor
  `guardian`. The plain catalog (CLI and remote clients) publishes `true` for both.
- Executors start on the machine with the native catalog and settings. Their
  `config.toml` is written from the native `config/read` settings, and the gateway
  drops only provider, login, API key and catalog keys, not `mcp_servers`, so the
  node_repl server resolves as it does natively. No executor was found that cannot
  start it.

## Check script

`node scripts/check-node-repl.mjs catalog.json` reads a copy of an executor home's
combined catalog. It prints both node_repl fields for every row as JSON, and
`guardian` when one is set. It then counts the rows that keep node_repl off and the
rows that enable it without review, as the SDK reads them: a missing
`node_repl_disabled` means enabled, and a set `guardian` decides review. A
`guardian` that is not an object, or a `computer_use` mode that is not a string,
counts as without review. The script is advisory and exits 0, also for unreadable or
malformed input. Pass it a copy, never the installed app's live state.
