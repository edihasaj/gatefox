---
summary: "Focused CLI, provider and desktop checks required before publishing a GateFox release."
read_when:
  - Preparing a release or choosing protocol and desktop verification scripts
---

# Release validation checks

These are the detailed checks for step 4 of the [release workflow](RELEASING.md#macos-app-distribution).

Run real model tool loops against the installed command on the test Mac. Use
isolated native and gateway state directories. Record configuration digests,
provider registration, client-requested chat names, and resume results.

## SSH proxy transport

For SSH proxy changes, run `scripts/e2e-ssh-proxy.mjs --package INSTALLED_PACKAGE
--codex SIGNED_NATIVE_CLI --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`. It uses the
real native byte proxy, a real WebSocket upgrade, and an isolated Unix listener
to verify that device identification precedes the initialize request only
inside the upgraded session. No account or provider inference is used.

## Subagent routing and payloads

For gateway sub-agent routing, run `scripts/e2e-subagent-sidebar.mjs --package
INSTALLED_PACKAGE --code CHECKOUT --root FRESH_EVIDENCE_DIRECTORY`.
Repeat with `--private`, `--openai`, `--cold --mixed-identity`, and
`--cold --config-override`. The real SDK spawns a child against a local mock
provider, opens it using the desktop's resume shapes, and continues it while
checking its saved identity and reasoning. These checks use private homes and
no paid inference. `--baseline` reproduces the pre-fix alias rejection.
Add `--v2` to verify that the delegated task and a follow-up reach the child,
that it executes a real command, and that its history includes that command
and the resulting answer. `--v2 --expect-payload-loss` reproduces the
missing-task failure in 0.5.1.

## Live collaboration transport

Before shipping collaboration transport changes, also run
`scripts/e2e-subagent-live.mjs --package INSTALLED_PACKAGE --code CHECKOUT
--config PRIVATE_GATEWAY_CONFIG --model CONFIGURED_CODEX_ALIAS --root
FRESH_EVIDENCE_DIRECTORY`. This opt-in check uses real subscription inference
and isolated chat homes. It requires an actual child command and an answer
containing a proof available only in the child's read-only fixture file.

## Chat lists and disconnected execution

For chat-list status changes, run `scripts/e2e-chat-state.mjs --package
INSTALLED_PACKAGE --root FRESH_EVIDENCE_DIRECTORY`, then repeat with `--native`
and a second evidence directory. Repeat with `--private` for per-connection
gateway executors. Two clients of the real SDK must expose an
already-running chat and receive its actual idle event without resuming it or
starting another inference. The fixture uses a local mock provider and private
state. By default it checks the checkout's compiled adapter with the package's
verified SDK; pass `--code INSTALLED_PACKAGE` to check the packaged adapter too.
These checks do not prove the phone's unread rendering.
For Gateway-owned execution reporting, also run the fixture with `--activity`.
Require the same running turn, a saved completion and a provider failure after
both application clients disconnect, with no repeated inference or native
configuration changes. Verify the Gateway Activity screen separately; neither
this fixture nor this screen establishes Codex unread-dot behavior.

## Shared execution

For shared execution changes, run `scripts/e2e-shared-execution.mjs` with the
installed command, isolated native home, and isolated client configuration.
Start without `--inference`, then enable real provider turns and image history.
The zero-inference run proves process ownership rather than durable chat resume.
Every host it starts, including the restart phase's replacement, is stopped at the
end, and a detached reaper (`scripts/e2e-reaper.mjs`) cleans up after a SIGKILL of
the check: its process groups, the SDK sockets its links name that nothing serves
(with their `.lock` files) and its private home. It kills only groups it saw
alive: a group that emptied or answers no probe is never signalled again, so a
reused process ID cannot be hit.
The check starts its host from the `dist` of an installed package: pass
`--package INSTALLED_PACKAGE`, or leave it out and the script uses the package
that `--gateway`'s launcher runs (its `current/package`). Only when neither has
`dist/execution-host.js` and `dist/config.js` does it fall back to the checkout's
`../dist`, and a package that ships `gateway-sdk` then refuses with "requires a
matching installed gateway SDK". The first JSON line printed names the `dist`
used, so confirm it is the installed package. Give the isolated native home a fixture
`models.json` named by `model_catalog_json`, as the other end-to-end scripts do,
and start the SDK once on it before the check, so the two adapters do not run
the first catalog preflight at the same moment.

## Speed controls

For speed controls, run `scripts/e2e-fast-mode.mjs --gateway INSTALLED_COMMAND
--package INSTALLED_PACKAGE --root PRIVATE_EVIDENCE_DIRECTORY`. It uses the
real signed SDK with a mock upstream through stdio and a private Unix socket.
It proves requested and returned tiers, settings changes, saved-history resume,
and native isolation; it sends no subscription inference and does not prove
rendered desktop controls or the built-in cloud transport.

## Named worker context

For named Qwen role context changes, run `scripts/e2e-subagent-sidebar.mjs
--package INSTALLED_PACKAGE --code CHECKOUT --root TASK_DIRECTORY --v2
--role-fork --named-worker --cold`. Repeat in a fresh directory with
`--worker-stale-catalog --worker-compact`. Require the actual named Qwen child
to report its bounded context, retain its model and effort, execute tools,
resume after the cold host restart and compact exactly once in the second
run. These checks use synthetic inference and do not spend provider credit.

## Chat Completions translation

For Chat Completions translation changes (local Qwen or another
`chat-completions-api` provider), run `scripts/e2e-chat-compaction.mjs --package
INSTALLED_PACKAGE --config PRIVATE_GATEWAY_CONFIG [--provider qwen]`. It sends the
compaction shape (no tools, `tool_choice`, an undeclared historical tool), a turn
with declared tools and an undeclared historical tool, and an oversized prompt to
the real provider, and requires an answer, an answer, and `context_length_exceeded`.
1.2.2 fails all three. It prints only PASS/FAIL lines and fixed error codes. When
the model's metadata lists image input, or with `--vision`, it also sends a user
image and a tool-result image and requires the model to name their colors.
For Chat Completions failure handling, run `E2E_ROOT=FRESH_DIRECTORY node
scripts/e2e-chat-tool-retry.mjs LABEL GATEWAY_COMMAND`. A real Codex client must
retry a garbled tool call and finish. It uses a local mock and spends no credit.

## Chat identity

For chat identity changes, run `scripts/e2e-identity.mjs --package
INSTALLED_PACKAGE --root PRIVATE_EVIDENCE_DIRECTORY`. With the package's own
gateway SDK and a mock upstream it proves that new chats are recorded as
`gatefox` by default (a chat saved as `subscription_gateway` before 1.8.0 keeps its id), and that with the `openai` opt-in a new gateway
chat is recorded as `openai` (thread, rollout and SQLite), is in the registry when its start returns,
compacts locally on the selected model, routes to the gateway when a new connection
resumes it, sends nothing with the gateway token to the ChatGPT backend, and is
listed by a default `thread/list`; and that a legacy chat stays
`subscription_gateway` and is listed through the router but not by a stock engine.

## Compaction and recovery

For compaction changes, run `scripts/e2e-compaction-switch.mjs --gateway
INSTALLED_COMMAND --package INSTALLED_PACKAGE --root PRIVATE_EVIDENCE_DIRECTORY
--expect selected-turn --shared`. This is the release step. A package that
ships `gateway-sdk` (0.4.3 and later) compacts inside the user turn, so the
run verifies the package's own gateway SDK receipt and selected-model recovery,
Stop, failures, and reconnect through stdio and Unix with a mock upstream and
the signed SDK. The script detects `gateway-sdk` in the package (through its
`dist/gateway-sdk-runtime.js`, else the same file layout). When the package
has it, `selected-turn` is the default and `automatic` and `baseline` are
refused; when it does not, `selected-turn` is refused. `--expect automatic`
and `--expect baseline` are for legacy packages without `gateway-sdk` only
(baseline reproduces the previous-model failure of the stock SDK). `--codex`
does not change the SDK of the gateway executor, which always runs the
package's own `gateway-sdk`; it only replaces the SDK the script itself
starts and checks. The script uses `gateway-sdk/gateway-codex` in the package
and says so if it is missing.
Every child runs under a private HOME inside the run folder, so no execution
host home or receipt reaches `~/.local/state`. Only the pinned SDK's fixed
socket folder, `/tmp/codex-daemon-UID`, stays outside, because the SDK
hard-codes it; the script removes its own stale sockets there. A passing run
removes its `/tmp/gw-compact-switch-*` run folder; a failing run keeps it, and
`--keep-fixture` keeps it on request. With `--shared`, the
`selected-turn` run also checks the shared execution host over stdio; a legacy
`automatic` run only checks the safe refusal of automatic compaction, not
seamless recovery.

## Managed worker context

For managed worker context changes, also run `scripts/e2e-managed-routing.mjs
--package INSTALLED_PACKAGE --code CHECKOUT --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`.
It uses the verified bundled SDK with a mock provider to prove compaction
exceeds the ordinary byte budget within its bounded recovery allowance,
preserves a proof from the original history, and resumes an ordinary turn
below the original limit. It uses private state and no paid inference.

## Responses continuation

For Responses continuation changes, run
`scripts/e2e-responses-continuation.mjs --package INSTALLED_PACKAGE --codex
SIGNED_CODEX_MACH_O --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`. It verifies actual
continuation flags, message phases, nested text, and one dispatched tool with
the pinned signed SDK and a mock upstream. Pass the signed Mach-O under
`CodexCLI.app/Contents/MacOS/codex`, not its unsigned `bin/codex` shell launcher.
The fixture requires fresh isolated state, rejects native homes, and uses no
copied authentication or paid inference.

## Interrupted Responses terminals

For interrupted Responses terminals and missing-terminal recovery, run
`scripts/e2e-responses-terminals.mjs --package INSTALLED_PACKAGE --codex
SIGNED_CODEX_MACH_O --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`. It verifies the
original acknowledged SDK turn, actual incomplete terminals, minimal
completed terminals, once-only tool execution, safe pre-output EOF retries,
and partial-output failure. It uses localhost mocks and isolated state, with
no native authentication or paid inference.

## Reasoning levels

For reasoning levels, run `scripts/e2e-reasoning-levels.mjs` with the same
`--gateway`, `--config`, `--codex` and `--catalog` options plus a fresh
`--fixture` and `--output`. Pass the native model cache
(`~/.codex/models_cache.json`) as `--catalog`, never the gateway catalog, or
gateway aliases are routed as native models. It checks Max and Ultra on Claude
Opus and Codex Sol: the effort Codex sends, Ultra's `collaboration` tools, and,
for Claude, the CLI's actual `--effort` and `--thinking-display` flags.

## Goals and model changes

For goal durability, run `scripts/e2e-goal-outage.mjs` with the same options.
It starts an active goal on a gateway model, SIGKILLs the adapter and every
SDK child mid-turn like a power cut, then resumes and requires the goal to
survive and finish. Both use real inference in an isolated native home.
For model switches during a goal, run `scripts/e2e-goal-switch.mjs` with the
same options. It starts an active goal on `--from`, switches the chat to `--to`
with `thread/settings/update` as the picker does, and requires the next turn to
start by itself and send its requests on the new model. It also uses real
inference in an isolated native home.
A first real turn is required before the SDK can resume an empty chat.

## Execution sandbox

Run `scripts/e2e-execution-sandbox.mjs` to confirm the live control socket is
unreachable inside the actual macOS sandbox, including through its alias.

## Native resume and forks

For native resume, fork or reasoning changes, run `scripts/e2e-native-model.mjs
--gateway INSTALLED_COMMAND --root FRESH_PRIVATE_EVIDENCE_DIRECTORY`. It sends the
desktop's own resume and fork shapes after an engine restart to the signed SDK
directly and through the adapter, and requires the adapter to give each the same
model and effort. It uses isolated homes and a localhost mock upstream, with no
authentication or paid inference.
