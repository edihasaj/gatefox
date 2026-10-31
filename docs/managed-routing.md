---
summary: Opt-in code-enforced worker routes with fresh capacity checks, durable provider affinity and explicit context budgets.
read_when:
  - Configuring automatic worker model selection or fallback.
  - Investigating managed worker context budgets or provider affinity.
---

# Managed worker routing

Managed aliases opt into provider selection in Gateway code. Ordinary aliases,
explicit model choices, native reviewer routes and existing worker models retain
their exact bindings. The client still owns task scope, permissions, delegation,
tool execution and context compaction.

```text
new managed worker
  -> enforce caller context byte budget
  -> local model with fresh health, when suitable
  -> suitable subscription with fresh quota above its reserve
  -> explicitly enabled DeepSeek V4 Flash only when every configured
     subscription candidate has a confirmed blocker
  -> persist the chosen provider/account/model binding before inference

later requests -> the same binding, including across Gateway restarts
```

Busy queues and unknown or stale quota never authorize paid escalation. Pro,
GLM and other paid models are excluded from managed candidate chains. An explicit
ordinary model request remains an explicit selection; these rules do not turn
an unrelated fixed alias into an automatic route. Independent review remains an
explicit separate model choice.

## Configuration

Add `managedRouting.routes` to the existing Gateway configuration. Candidate
aliases must already exist under `providers`, and their declared context windows
must support the managed route's advertised window. For example:

```json
{
  "managedRouting": {
    "routes": {
      "managed/routine": {
        "purpose": "routine",
        "candidates": ["qwen/qwen3.8-flash-next", "claude-primary/claude-sonnet-5-5", "codex/gpt-6.1-sol", "or-deepseek"],
        "contextWindow": 32768,
        "maxContextBytes": 262144,
        "minRemainingPercent": 2,
        "allowPaid": true
      }
    }
  }
}
```

Candidate order is local models, subscriptions, then paid Flash. A `strong`
route starts with subscriptions and cannot contain local candidates. Paid
routing defaults off. Missing subscription quota is unknown capacity, even when
an availability row otherwise says `available`. A cold managed request starts
the existing collectors and waits at most 2.5 seconds; it refuses if no eligible
route is known after that wait. No provider call occurs on a refusal.

The HTTP request uses the managed alias as its `model` and supplies a stable
`thread-id` or `session-id`. Managed aliases are internal worker policies, omitted
from `/v1/models` and the normal desktop model picker. `/v1/model-catalog` retains
them with `visibility: "hide"` so configured worker roles and existing managed
chats remain routable. An explicit hidden-model listing can inspect them.
The catalog advertises common reasoning capabilities,
a text-only input surface and the configured context window. Managed aliases
advertise Gateway's V2 client collaboration contract independently of an
upstream's model-discovery metadata; fixed model rows keep their existing
metadata. This version does
not change account setup or the native app's connection-management UI.

## Context and cache behavior

An optional `candidateReasoningEfforts` map explicitly selects a provider-specific
effort for that internal policy. Each key must name one of its candidates and
the value must be an effort that candidate supports. This is an opt-in profile,
not an automatic increase for all models: an implementation policy can map only
Qwen to `xhigh` while its subscription and Flash candidates retain the caller's
`medium`. The map applies to managed requests only; fixed model requests bypass
it. The response includes `X-Gateway-Managed-Reasoning-Effort` when a map entry
was applied. Use a new policy alias for this change so existing pinned workers
keep their original policy and reasoning behavior.

Start a fresh worker with a bounded task, selected evidence, allowed files,
acceptance checks and a compact handoff. A client role may select a managed alias
for future workers; this does not rewrite roles or restart an existing worker.
The byte budget includes the serialized caller request, including instructions,
tool definitions, metadata and history. It is an exact payload limit, not an
exact tokenizer or a promise about the provider's hidden framing.

Over-budget requests fail before inference with the existing
`context_length_exceeded` code, so clients can enter their normal compaction
recovery. Gateway never silently drops,
summarizes or changes caller messages, tool results, instructions or permissions.
The client must compact its own context or start a fresh bounded worker.

A request marked `compaction` has a separate recovery allowance of four times
`maxContextBytes`, capped at 4 MiB. It requires an existing durable worker pin
and uses that same provider with the same capacity checks. It cannot establish a
new binding or bypass an unavailable provider. Requests beyond the recovery
allowance still fail before inference; subsequent ordinary turns retain the
original byte limit. This makes room for the client to summarize accumulated
history without increasing its normal worker context budget.

The persisted pin avoids model/account churn and preserves the opportunity to
reuse the same provider's prefix cache. For a local Chat Completions model,
configure the existing `sessionAffinity: true` option so the worker's identifier
also reaches its upstream router. A pin does not by itself guarantee a cache hit;
cache availability and eviction remain upstream behavior.

An unavailable pinned provider produces a refusal. It is never silently
replayed onto another provider after a partial stream, tool call or missing
usage. The caller may retry that provider, or start a new worker ID with a
plaintext handoff. A paid pin also refuses when its prerequisite subscription
blockers no longer hold. Provider-specific opaque state cannot start an unbound
managed worker. A changed policy or provider binding requires a fresh worker.

## Rollout

Release the reviewed Gateway change before enabling managed aliases. On each
target machine, require `gateway rollout --verify --json` to report ready and
the authenticated `/health` response to advertise `managed-worker-routing-v1`.
Then add the explicit route configuration and verify `/v1/model-catalog` retains
the hidden worker aliases while `/v1/models` offers only named models. Do not add another daemon or
force-restart active chats to enable this feature.

For future client workers, select `managed/routine` in the implementation/test
role's model setting. Preserve that role's instructions, sandbox, tool access
and permissions. Existing workers keep their loaded model; a new worker or
engine picks up the managed alias and its bounded context metadata. Keep main
chat models and independent reviewer roles explicit. Selecting a fixed alias
continues to bypass managed selection deliberately.

Pins bind the configured provider, credential source and model. They do not
inspect login or API-key file contents to audit an account replacement in
place; an operator replacing an account must start fresh managed workers.
Pins contain only configured route identities and fingerprints under the
owner-only `stateDirectory/managed-route-pins` directory. Raw prompts, tool
arguments and thread IDs are not persisted there. Unsafe or corrupted pins fail
closed; they never trigger a fresh provider selection. There is no automatic
pin eviction that could silently move an old conversation after restart.

## Limits

The offline real-SDK check for hidden worker roles is
`node scripts/e2e-subagent-sidebar.mjs --package VERIFIED_PACKAGE --code CHECKOUT
--root TASK_DIRECTORY --v2 --role-fork --managed`. It requires a configured role
to spawn a hidden managed worker, execute a real fixture command, retain its
model across resume and follow-up, and expose the pinned model in Activity.
All inference uses local mocks and private homes.

This is provider admission before inference, not an agent scheduler or automatic
semantic task classifier. Candidate suitability comes from the explicit managed
alias and its configured capabilities. It does not retry another model after
inference starts, invent task summaries, or override a provider refusal.

OpenRouter's balance check is a fresh capacity fact, not a durable financial
reservation. Wieldr's separate OpenAI credit guard continues to own its 2% dollar
reserve and charge ledger. Managed worker routing does not extend that financial
guarantee to other API callers or providers.
