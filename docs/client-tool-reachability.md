---
summary: 'Client tool discovery on gateway models, deferred-tool fallback, and the desktop scheduling boundary.'
read_when:
  - Investigating a missing desktop tool or unavailable automation tool
  - Changing gateway SDK dynamic tool registration, tool search, or Code Mode
  - Testing client tool visibility after resume or model switching
---

# Client tool reachability

The client registers tools and executes them. Harness Gateway translates inference
requests and transports calls and results; it does not supply an automation service
or change client permissions.

```text
Client registers a tool
        ↓
Gateway SDK selects exposure for the current model
        ├─ Search supported → preserve deferred discovery
        ├─ No search, direct mode → expose the declared tool directly
        └─ Code Mode → retain namespace and exec exposure rules
        ↓
Model requests a call → client executes or declines → result returns to model
```

## Deferred dynamic tools

The pinned SDK previously hid a caller-declared `deferLoading: true` dynamic
function in direct mode when the model had `supports_search_tool: false`. There
was no search tool to discover it. An isolated check reproduced this with both
the signed native app engine and the installed gateway SDK. Code Mode already
made the same declared tool callable through `ALL_TOOLS` and `tools`.

`scripts/patches/gateway-dynamic-tools.patch` changes registration in the gateway
SDK only. When the selected model lacks search, a declared `Deferred` dynamic
tool receives `Direct` exposure, just as MCP tools already fall back. Both flat
functions and namespaced functions use this path. The registry is built using
the current model, including after a cold resume or model change between turns.
Saved declarations are not rewritten.

Search-capable models keep deferred discovery. Existing schema conversion, tool
policy, reserved-name checks, namespace exclusions, direct-only namespaces and
client dispatch remain in force. This does not enable hosted tool search on
unsupported providers, add undeclared tools, or modify the signed native engine.
Direct fallback sends more tool declarations in the model context; search-capable
models retain their smaller initial catalog.

## Scheduling is a separate client boundary

Read-only inspection of the installed ChatGPT desktop bundle on 2026-10-24 found:

| Path | Client behavior |
| --- | --- |
| Local legacy automation tool | Registers `automation_update` only for desktop, local hosts, and when hosted automations are not enabled. |
| Desktop MCP | Carries app-managed tools; thread-start filtering deliberately removes automation and thread-management tools from the plain dynamic-tool path. |
| SSH hosts | The MCP allow-list omits `automation_update`; execution also rejects non-local hosts. |
| Hosted automations migration | Local automation changes are rejected after migration consent and must use the Automations app. |

The local scheduler registration condition is not provider-specific. These are
observed bundle conditions, not proof of the active feature flags in a particular
chat. A missing tool can therefore mean either hidden discovery or no client
registration. The SDK fallback fixes only the former. Never manufacture a
scheduler declaration, bypass a client allow-list, or add a second background job.
Tool availability also does not prove a schedule will execute while its owning
client or host is unavailable.

### Native scheduled runs on gateway models

The desktop scheduler runs a saved automation through the same adapter. A
projectless automation saves `cwds = ["~"]` and sends the exact `~` sentinel in
`runtimeWorkspaceRoots` and `sandboxPolicy.writableRoots` on `thread/start` and
`turn/start`. The native engine expands that sentinel to the user's home. The
pinned gateway SDK accepts only absolute roots, so on 2026-10-24 a gateway-model
QA automation created its thread and then failed `turn/start` with
`rpc_error` `-32600` (`rejection: "relative_path"`), and its run stayed
`IN_PROGRESS`. A native-model control run in the same minute completed.

For gateway chats only, `src/app-server-scheduler-roots.ts` replaces an entry
that is exactly `~` with the user's home directory (`os.homedir()`, not
`CODEX_HOME`) in those two lists on `thread/start` and `turn/start`. Every other
entry, including `~/child` and relative paths, `cwd`, the sandbox type, network
access, approvals and the model choice are forwarded unchanged, so the SDK still
refuses what it refused before. Native chats and other methods are untouched.
The scheduler itself, its schedule store, run history and inbox remain the
app's; the gateway adds no scheduler or background job.

### Independent background coding jobs

A client can separately register an existing Mission Runtime companion as an
MCP server. `mission_submit`, `mission_status`, `mission_cancel`, and
`mission_overview` address durable coding work owned by that authority, rather
than by the inference gateway or the submitting chat connection. This is an
explicit client integration, not something the gateway installs automatically.
It must preserve the client's permissions and the runtime's configured project,
provider, node and verification policy. Immediate background delivery is not
native scheduled-task parity: these tools do not add cron, reminders, recurring
follow-ups, or automatic wakeups of a Codex chat.

## Verification

Build first, then run the real SDK against a loopback mock with private homes:

```sh
npm run build
node scripts/e2e-client-tool-exposure.mjs \
  --gateway /absolute/path/to/gateway-codex \
  --native /absolute/path/to/native/codex \
  --catalog /absolute/path/to/models_cache.json \
  --root /tmp/harness-client-tools-evidence
```

`--native` is optional and remains an unpatched negative control. `--baseline`
expects the old gateway visibility bug. The script checks direct and deferred
tools, local search discovery, Code Mode nested calls, cold resume, model changes
between turns, and client refusal status. It uses a synthetic tool named
`automation_update`, not the app's real scheduler. It creates no schedules,
performs no subscription inference, and copies no authentication. Its JSON receipt
contains only fixture names, counts and capability/status facts.

The verified SDK build also runs seven Rust regressions for flat/namespaced
fallback, schema equivalence, unchanged caller declarations, preserved discovery,
direct declarations, policy filtering and Code Mode namespace rules. A release
must rebuild the SDK: changing the patch changes the authenticated source hashes,
so old SDK artifacts cannot be reused.

### Executable evidence, 2026-10-24

The patched development SDK and its companion Code Mode host built from revision
`83086188ae0614bd882818ff1aa23f3194962012`. All nine mock scenarios passed,
including an independent rerun. The installed SDK reproduced the hidden-tool
baseline, and the signed native negative control stayed unchanged.
The final verified gate passed all 19 identity, compaction, queue, client-tool and
existing deferred-filtering regressions with the documented 32 MiB development-test
thread stack. This was a development build, not a published release.

| Scenario | Installed SDK baseline | Patched SDK |
| --- | --- | --- |
| Deferred tool, direct mode without search | Hidden | Client called; result returned |
| Already-direct tool | Working | Unchanged |
| Deferred tool with search | Discovered and called | Unchanged |
| Code Mode nested invocation | Working | Unchanged |
| Deferred tool after cold resume | Hidden | Client called; result returned |
| Search model changed to no-search model between turns | Hidden | Client called; result returned |
| Client refuses an already-direct call | Failed status preserved | Unchanged |
| Client refuses a deferred no-search call | Never reached client | Failed status and `success: false` preserved |

This proves SDK exposure and callback transport under controlled model responses,
not live provider inference, real automation delivery, release readiness or fleet
deployment. The native no-search negative control is the ninth scenario.

See [Responses tools](responses.md), [node_repl](node-repl.md),
[harness identity](harness-identity.md), and [rollout readiness](rollout.md).
