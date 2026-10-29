---
summary: 'Live agent task checks for availability consumption, local workers and subscription fallback.'
read_when:
  - Testing whether an agent consults availability before choosing a worker
  - Changing availability client policy, worker roles or the live delegation check
  - Deciding whether a change is covered by these live checks or by the managed routing suites
---

# Availability and agent tasks

The gateway reports provider facts. For fixed aliases and explicit model
requests the client owns delegation and model choice; opt-in
[managed worker aliases](managed-routing.md) are the separate code-enforced
route documented there.
The retained fixed-alias client policy reads Manager's `scripts/macos/model-availability-context.py`
before the first worker and again before a fallback. That helper joins exact role
aliases to configured providers and reports freshness separately for health,
quota and balance. An `available` route with no quota observation has unknown
subscription headroom. Missing data never authorizes paid API escalation.

These are historical fixed-alias scenarios. Reproducing their original
instruction behavior requires the retained policy from the corresponding
evidence revision. The current Manager policy delegates managed admission to
Gateway code and does not require a manual availability query before every
managed worker.

`scripts/e2e-availability-agents.mjs` checks the complete client path with real
model inference and a verified installed gateway SDK. It creates private homes,
gateway state and a random proof file under `/tmp`; the installed service and
configuration are not changed. Provider credentials remain in their existing
locations. The parent uses a private workspace sandbox with networking enabled;
the assigned task is read only. A sandbox that denies networking cannot reach
the loopback endpoint and must receive unknown availability. Spendwatch alone
runs with the normal home directory so it can discover the real accounts;
the SDK and chat state retain their private homes. The normal task prompt does not name the expected model or tell the
parent which availability command to run.

```sh
node scripts/e2e-availability-agents.mjs \
  --package /absolute/installed/release/package \
  --code /absolute/harness-gateway \
  --config /absolute/private/gateway.json \
  --model codex/gpt-6-luna \
  --context /absolute/manager/scripts/macos/model-availability-context.py \
  --policy /absolute/retained/fixed-alias-routing-instructions.md \
  --root /tmp/availability-agent-evidence \
  --scenario healthy
```

Run each scenario separately:

| Scenario | Availability source | Expected task execution |
| --- | --- | --- |
| `healthy` | Real gateway collectors | Named local worker completes the task. |
| `local-unhealthy` | Injected fresh unhealthy local observation; other facts remain real | A subscription worker completes the task and the exhausted primary is avoided. |
| `unknown-source` | Only the availability endpoint returns an injected failure | The local default remains usable and paid APIs are not selected. |
| `worker-failure` | Real healthy facts, then an injected terminal authentication refusal before the local worker's upstream call | The parent observes the failed child, refreshes availability, and starts a new subscription worker that completes the task. |

The first two outage scenarios inject availability facts only. `worker-failure`
injects a transport failure before the local model is called; the gateway's
ordinary outcome tracker then reports that route unavailable. Parent decisions
and the successful worker's inference are real. Receipts distinguish injected
facts or failures from observed execution and contain only identifiers, counts
and verification booleans. Preserve runner and helper hashes in the run manifest;
the receipt also records the canonical policy hash.

A pass requires a completed parent availability command and an HTTP availability
request before child inference, the expected provider, a successful child command
that reads the unpredictable proof, and completed child and parent turns that
report the proof. A parent that reads the file itself fails the check.

The first three scenarios test one worker per task. `worker-failure` requires
two distinct children in order: failed local worker, then successful subscription
worker. A second completed helper command and availability request must occur
after the first child's terminal failure and before the replacement starts.
This checks a terminal startup failure; it does not prove recovery of partially
written files or continuation inside the failed child's conversation.

Native OpenAI parent delegation, Claude Code orchestration, shared DGX queue
visibility and desktop rendering require separate receipts.

## Coverage split with managed routing

These live checks exercise the legacy instruction-policy path: the runner
renders the supplied fixed-alias policy (historically Manager's
`configs/codex/routing-instructions.md`) into the parent's
`developer_instructions` and verifies that an instruction-following client
consults availability before delegating. They do not exercise managed aliases.
Managed alias admission is code-enforced and is covered by the unit, reload,
pin and HTTP suites instead: `src/tests/managed-routing.test.ts`,
`src/tests/managed-routing-config.test.ts`,
`src/tests/managed-routing-reload.test.ts`,
`src/tests/managed-route-pins.test.ts`,
`src/tests/managed-routing-http.test.ts` and
`src/tests/server-managed-routing.test.ts`, all run under `npm test`. Consult
[managed worker routing](managed-routing.md) for the admission rules those
tests enforce; a change to those rules needs those suites, not an additional
instruction-policy fixture.

