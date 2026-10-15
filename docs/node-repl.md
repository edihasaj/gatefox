---
summary: 'node_repl (browser, Chrome and computer use) on gateway rows: native evidence, how auto review runs in gateway executors, rules, model switching and the check script.'
read_when:
  - Changing node_repl, auto review or guardian fields on gateway or native catalog rows
  - Changing the reviewer route, the `auto_review` catalog field or `autoReview` telemetry
  - Investigating why browser, Chrome or computer use is on or off in a gateway chat
  - Investigating a rejected model switch during a running turn
---

# node_repl on gateway rows

node_repl runs the browser, Chrome and computer-use tools. Gateway chats get the
same node_repl capability and the same safety policy as native rows, and never a
weaker one. This guide owns the details, because `app-server.md` was already over
500 lines on main; the [Codex 2 rows section](app-server.md#codex-2-rows-and-the-native-catalog)
of that guide summarizes them. The code is in `src/auto-review.ts`,
`src/codex-native-rows.ts`, `src/desktop-catalog.ts` and `src/server.ts`.

## Evidence

The SDK reads the policy from the ModelInfo fields `node_repl_disabled`,
`node_repl_auto_review_required`, `guardian` and `auto_review_model_override`.
The runtime source is the client's own `~/.codex/models_cache.json` (client
0.162.0, fetched 2026-10-15), which the adapter loads as the native catalog. It
was read-only observed, together with the bundled plugins, `~/.codex/config.toml`
and the Codex source (`ModelInfo` in `codex-rs/protocol`, pinned revision 740e5af):

- node_repl does not depend on code mode. The bundled `unified-computer-use` plugin
  declares `cua_repl` with `omit_tools_from: ["code_mode", "deferred"]`, and
  `~/.codex/config.toml` runs `[mcp_servers.node_repl]` from the app. Only
  `tool_mode` follows code mode.
- Every native row has `node_repl_disabled: false`. `gpt-6-astra`, `gpt-6.1-sol` and
  `gpt-6-sol` set `node_repl_auto_review_required: true`; `gpt-6-luna`, `gpt-reserve`,
  the 5.6 rows and `gpt-daybreak-blue-latest` set it to false. `guardian`,
  `auto_review_model_override` and `requires_sandboxed_review` are absent on every
  row in that file, and the SDK reads an absent field as null. The catalog embedded
  in the ChatGPT.app `codex` binary states them instead: `guardian` and
  `auto_review_model_override` are `null` and `requires_sandboxed_review` is `false`
  on its rows. The two sources mean the same.
- In the SDK, `ModelInfo::computer_use_review_required` lets a `guardian` policy,
  when one is set, decide review instead of the flag: computer use is reviewed
  unless `guardian.computer_use` is absent, null or `disabled`. A null `guardian`
  leaves the flag in charge. A missing node_repl field means `false`.
- The hidden row `codex-auto-review` is the reviewer: `visibility: hide`,
  `supported_in_api: true`, `use_responses_lite: true`, and its
  `model_messages.auto_review` holds `policy`, `policy_template` and
  `node_repl_policy`, which is the node_repl review text. The 6.x rows carry
  `auto_review` fields that are null, the same as absent.
- The four 6.x rows share one `confirmation_policies` and one `guardian_v2` (identical
  across the rows). Rows such as `gpt-5.6-luna` have neither. Claude, Copilot and
  Qwen rows are published by the gateway and have neither either.

## How review runs in gateway executors

An action that needs review goes to a reviewer model. The SDK chooses it as follows
(`core/src/guardian/reviewer_config.rs`, `ext/guardian-reviewer/src/model.rs`):

1. The default reviewer is `approval_review_preferred_model()` of the turn provider:
   `gpt-5.6-luna` only when the provider has cached API-key auth, otherwise
   `codex-auto-review`.
2. A gateway executor's provider authenticates with `auth.command`, so the SDK builds
   a fresh external-bearer `AuthManager` for it whose cache starts empty. Nothing
   reads auth through the turn provider (the model client and the extensions build
   their own providers), so the cache stays empty and the default is
   `codex-auto-review`. `gpt-5.6-luna` is never selected from an executor.
3. The row's own `auto_review_model_override`, when set, replaces the default.
4. The chosen reviewer is used only if its row is in the executor's model list. That
   list is filtered for API-key auth, so the row needs `supported_in_api: true`.
   Otherwise the SDK falls back to the parent model, with the parent's own messages.
   That is not the native review, so the catalog must never allow it: a reviewer row
   that is missing or not `supported_in_api: true` keeps node_repl off.
5. The review text is the SDK's own: the instructions and node_repl policy come from
   the reviewer row's `model_messages.auto_review`, plus the SDK's output contract.
   The gateway adds, removes and rewrites no review text.

The reviewer is a normal thread on the same gateway provider. It never executes
anything for the client: its tools (`exec_command`, `write_stdin`, `view_image`, `exec`
and `wait`) run read-only inside the SDK's sandbox, so the reviewer may inspect state
with read-only commands. Full Access approves the empty-schema node_repl elicitations
without any review, as natively.

A live check of the pinned gateway SDK, with a fake gateway and no paid inference,
saw the reviewer request as `POST /v1/responses` with `model: "codex-auto-review"`,
`reasoning.effort: "low"`, `text.format.type: "json_schema"`, `store: false`,
`stream: true`, `include`, `prompt_cache_key`, `client_metadata` and `tool_choice`;
input items `additional_tools`, two developer messages and user messages; and no
`service_tier`. With the reviewer row removed from the catalog, the same action sent
the reviewer request under the parent model instead.

### The reviewer route

The gateway serves exactly one reviewer slug, `codex-auto-review`
(`src/auto-review.ts`), through the Codex subscription provider, and never
`gpt-5.6-luna`.

- Resolution is: an alias with that exact name, then the existing bare-model alias
  rule (`nativeModelAlias`), then the only `codex-subscription` provider. With no
  Codex provider or with two or more, and no alias, the request gets 404
  `model_not_found` and no other provider is called.
- The request reaches the same adapter instance as that provider's own rows, so the
  credential, turn state and reasoning scope match. The body is passed on unchanged
  apart from the model, as for any Codex route. `/v1/models` does not list it.
- `GET /v1/model-catalog` adds `auto_review: { "models": ["codex-auto-review"] }` only
  when that route resolves to a Codex subscription provider with a stored plan login
  (`hasPlanLogin`: scopes present; no refresh, no network, no write). Any error omits
  the field. Older adapters ignore the extra key, and so does Codex's `ModelsResponse`.
- The upstream accepting the slug on the subscription endpoint was not verified live:
  the only stored login was expired, and refreshing it would rotate the installed
  credential. Until a call is checked, a rejected slug shows as failed reviews
  (below), not as a wrong answer.

### The desktop adapter

The adapter turns node_repl on for a row that needs review only when all of these hold:
the last successful live read of the catalog advertised the row's reviewer slug (its
`auto_review_model_override`, or `codex-auto-review` when none), and the native catalog
carries that reviewer row with `supported_in_api: true`. A restored cache, a start
without a read, a source change or an older gateway means no advertisement, so those
rows have node_repl off until a read succeeds. A failed refresh keeps the last
snapshot. The reviewers are part of the catalog revision, so a change starts a new
executor generation.

### Data and decision

Reviewed actions and their context are sent to OpenAI's reviewer through the Codex
subscription. For Claude, Copilot and Qwen chats this means the actions and context
of a chat leave that chat's own provider. Edi accepted this on 2026-10-15 ("Add the
reviewer"). The reviewer review text is never logged: telemetry records fixed
fields only, and no token, prompt, request body, tool argument or environment value
is logged.

### Telemetry

Requests whose model is the reviewer slug carry `autoReview: true`, with `model` set to
that slug, on `request_completed`, `request_empty` and `request_failed`, including the
404. `gateway diagnostics` adds an `autoReview` bucket: `completed`, `empty` and
`failed:<code>`. Other model names are never recorded for a request without a route.

## Rules

- A Codex 2 row copies `node_repl_disabled`, `node_repl_auto_review_required`,
  `guardian`, `auto_review_model_override` and `requires_sandboxed_review` from its
  native row, with code mode on or off. A value that is not plainly typed is not
  copied, and a node_repl field that is not a boolean becomes `true`.
- A row needs review when its `guardian` reviews computer use, or when it has no
  `guardian` and its flag is not plainly `false`. A `guardian` that is not an object
  counts as needing review. Such a row has node_repl on only if its reviewer runs
  (see above); otherwise node_repl is off, so no action waits on a reviewer that
  fails. With the live config and the route advertised, `gpt-6.1-sol`, `gpt-6-astra`
  and `gpt-6-sol` keep it on with review, and rows such as `gpt-6-luna` and the 5.6
  rows keep it on without review.
- The native rows that the executor catalog carries for sub-agents naming a model
  directly follow the same rule as the Codex 2 row for that model, so one upstream
  model has one policy in an executor. A native row that states no node_repl policy
  gets node_repl off there. The reviewer row is carried unchanged, and the native
  engine's own catalog is unchanged. No row's messages are rewritten.
- A row with no native counterpart (Claude, Copilot, Qwen, API, or a Codex row whose
  upstream is missing) always requires review, the strictest policy, and carries no
  `guardian`. Its `confirmation_policies` and `guardian_v2` come from the native rows:
  when a text is on several native rows and all values are equal (as JSON), it is
  copied; when a text is on none, it is left out; when the values differ, nothing is
  shared and node_repl is off. Without these texts node_repl would read an empty
  `openai/confirmation_policies`, which clears the connector defaults. node_repl is
  off if the reviewer does not run, any native row turns it off or states no policy,
  or there is no native catalog. A sandboxed-review requirement carries over.
- The plain catalog (CLI and remote clients) publishes `true` for both fields on
  every row.
- Executors start on the machine with the native catalog and settings. Their
  `config.toml` is written from the native `config/read` settings, and the gateway
  drops only provider, login, API key and catalog keys, not `mcp_servers`, so the
  node_repl server resolves as it does natively.

### Fails closed

Any one of these turns node_repl off for the rows that need review, and for
fallback rows:

- no live catalog read yet, or a gateway too old to send the field;
- no Codex subscription route, or two or more without an alias;
- no ChatGPT plan login on the reviewer provider;
- the reviewer row missing from the native catalog, or `supported_in_api` not exactly `true`;
- an override that names a slug the gateway does not advertise, or is not a string;
- native rows that disagree on a shared review text, or any native row that turns
  node_repl off (fallback rows only).

At run time any reviewer failure (401, 404, 5xx, timeout) makes the SDK decline the
action. In a mixed deployment an inference host older than this release sends no
`auto_review`, so those rows stay off until the host is updated.

## Switching models during a running turn

This is the SDK's behaviour, not the gateway's. `check_legacy_model_safety`
(`core/src/session/step_activation.rs`) rejects `turn/settings/update` with a model
when the destination differs from the running turn in `node_repl_disabled`,
`computer_use_review_required`, `guardian`, `auto_review_model_override`, the cyber
specialty, the `guardian_v2` settings (with the feature or a guardian), or the
parent-fallback review texts. App-server maps the rejection to JSON-RPC `-32600`
with the SDK's reason. The router forwards it unchanged and records the new model
only for an `applied` result, so the turn keeps its model.

On the live configuration the rows fall in two groups: review required (`gpt-6.1-sol`,
`gpt-6-astra`, `gpt-6-sol`, every Claude, Copilot and Qwen row) and review not required
(`gpt-6-luna`, `gpt-reserve`, the 5.6 rows, `gpt-daybreak-blue-latest`). Claude to `gpt-6.1-sol` still
switches mid-turn; Claude to `gpt-6-luna` is rejected, like native `gpt-6.1-sol` to
`gpt-6-luna`. The groups are the same with or without the reviewer. `thread/settings/update`
changes the next turn and is never checked.

ChatGPT desktop 26.1007 changes the model only through `thread/settings/update` and
sends `turn/settings/update` only with `approvalsReviewer`. The picker therefore
never hits the rejection: it shows the new model, the running turn finishes on the
old one, and the next turn uses the new one. A CLI or script gets the error.

## What the desktop shows

- Browser, Chrome and computer-use tools appear on a gateway row when its reviewer is
  advertised, and for rows that need no review.
- Reviews appear as the native Auto-review items (`item/autoApprovalReview/started`
  and `completed`), forwarded from the executor.
- A failed review declines the action and is counted under `autoReview` in
  `gateway diagnostics`.
- If the route is unavailable, review-required rows have no browser for that executor
  generation.

## Check script

`node scripts/check-node-repl.mjs catalog.json` reads a copy of an executor home's
combined catalog. It prints both node_repl fields for every row as JSON, and
`guardian` when one is set. It then counts the rows that keep node_repl off and the
rows that enable it without review, as the SDK reads them: a missing
`node_repl_disabled` means enabled, and a set `guardian` decides review. A
`guardian` that is not an object, or a `computer_use` mode that is not a string,
counts as without review. The last line reports the reviewer row `codex-auto-review`:
missing, or its `supported_in_api` and whether its `node_repl_policy` is present. The
script is advisory and exits 0, also for unreadable or malformed input. Pass it a
copy, never the installed app's live state.
