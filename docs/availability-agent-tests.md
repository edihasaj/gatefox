---
summary: 'Live agent task checks for availability consumption, local workers and subscription fallback.'
read_when:
  - Testing whether an agent consults availability before choosing a worker
  - Changing availability client policy, worker roles or the live delegation check
---

# Availability and agent tasks

The gateway reports provider facts. The client owns delegation and model choice.
The managed client policy reads Manager's `scripts/macos/model-availability-context.py`
before the first worker and again before a fallback. That helper joins exact role
aliases to configured providers and reports freshness separately for health,
quota and balance. An `available` route with no quota observation has unknown
subscription headroom. Missing data never authorizes paid API escalation.

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
  --policy /absolute/manager/configs/codex/routing-instructions.md \
  --root /tmp/availability-agent-evidence \
  --scenario healthy
```

Run each scenario separately:

| Scenario | Availability source | Expected task execution |
| --- | --- | --- |
| `healthy` | Real gateway collectors | Named local worker completes the task. |
| `local-unhealthy` | Injected fresh unhealthy local observation; other facts remain real | A subscription worker completes the task and the exhausted primary is avoided. |
| `unknown-source` | Only the availability endpoint returns an injected failure | The local default remains usable and paid APIs are not selected. |

Injection changes availability facts only. Parent decisions and worker inference
are real in every scenario. Receipts distinguish injected facts from observed
execution and contain only identifiers, counts and verification booleans.

A pass requires a completed parent availability command and an HTTP availability
request before child inference, the expected provider, a successful child command
that reads the unpredictable proof, and completed child and parent turns that
report the proof. A parent that reads the file itself fails the check.

These scenarios test one worker per task, including choosing a subscription
worker before starting it. They do not establish recovery after an already-running
child fails, native OpenAI parent delegation, Claude Code orchestration, shared
DGX queue visibility, or desktop rendering. Those require separate receipts.
