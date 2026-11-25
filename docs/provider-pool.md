---
summary: 'One local model served by several self-hosted machines: sticky conversations, failover and draining inside GateFox, without a separate router.'
read_when:
  - Serving one local model from several machines, or replacing a model router with GateFox
  - Changing which machine a local conversation uses, or how it moves
  - Investigating a local conversation that moved, waits, or lost its prompt cache
---

# Provider pools

A pool serves one model name from several interchangeable machines. Each machine
is an ordinary provider with its own picker row; the pool is a provider whose
`pool` field lists them.

```text
qwen/qwen3.8-flash-next (pool) ─┬─ qwen-1 → machine one
                                └─ qwen-2 → machine two
```

## Configuration

```json
[
  { "id": "qwen", "type": "chat-completions-api", "pool": ["qwen-1", "qwen-2"],
    "baseUrl": "http://former-router.example/v1", "tailnet": true, "selfHosted": true,
    "credentialFile": "/private/qwen.key", "models": { "qwen/flash": "flash" } },
  { "id": "qwen-1", "type": "chat-completions-api", "baseUrl": "http://100.64.0.1:4001/v1",
    "tailnet": true, "selfHosted": true, "capacityDiscovery": true,
    "credentialFile": "/private/qwen.key", "models": { "qwen-1/flash": "flash" } },
  { "id": "qwen-2", "type": "chat-completions-api", "baseUrl": "http://100.64.0.2:4001/v1",
    "tailnet": true, "selfHosted": true, "capacityDiscovery": true,
    "credentialFile": "/private/qwen.key", "models": { "qwen-2/flash": "flash" } }
]
```

The pool and its 2 to 8 members must be `chat-completions-api` providers on
loopback or the tailnet with `selfHosted: true`, so a pool can never move a
conversation to a subscription or a paid API. Every member must serve each pooled
model with at least the context window, effort levels and modalities the pool
advertises. Members need different base URLs, and each address must reach only
its own machine: an address that fronts the whole farm counts every slot twice.

The pool keeps its own `baseUrl` but never dials it. A release that ignores
`pool` uses that address, so a rollback keeps working while it is served. Adding,
removing or changing `pool` applies live and keeps the model name of saved chats.

## Where a request goes

| Situation | Result |
| --- | --- |
| New conversation | The member with the most free room on this Mac; a tie is settled by a hash of the conversation. |
| Known conversation | Its own member, which holds its prompt cache. It waits there when the member is full. |
| New conversation waiting for a full member | Moves to another member as soon as one has a free slot. |
| Member advertises 0 slots (drained) | Running work finishes. Waiting requests and conversations move to another member. |
| Connection refused or dropped, or HTTP 502/503, before any output | The request runs on another member. A warm conversation first retries a dropped connection once, after about a second. |
| Member accepts connections but answers nothing | After three unanswered probes in a row, while another member answers, its conversations and silent requests move (45 to 70 seconds). |
| Request waiting for a member that stops answering | Moves without entering it, even while the request ahead keeps its place. |
| A member just refused or dropped a request | It gets no new conversations for 30 seconds, also when it returns sooner. |
| This Mac loses its network | Nobody is lost; conversations return to their own member. |
| Failure after output began | Returned to the client, never replayed. Its retry goes to the same member first. |
| The model server's own answer (400, 401, 429, 500, empty) | Returned unchanged, never moved. |
| Every member drained | Requests wait until one returns or they time out. |
| Every member unreachable | The ordinary retryable `upstream_unavailable`. |

A conversation that moved stays where it moved when the first member returns, so
it pays for one cold prefill, not two. Choosing `qwen-1/...` or `qwen-2/...`
directly always uses that machine, never fails over, and shares its slots with
the pool.

A conversation is its thread ID, else its session ID, else its
`prompt_cache_key`. Its member is kept for seven days (at most 4,096
conversations) in the owner-only `stateDirectory/provider-pool-ID.json`, which
holds hashes and member IDs only. A missing or damaged file means the next
request chooses again.

## Observing

- `gateway availability --json`: the pool row lists its members, with their
  combined health and the sum of their slots. Members have their own rows.
- `gateway diagnostics`: `providerPools` counts requests per member and reason
  (`new`, `pinned`, `drained`, `failover`) and each failover.
- `/health` advertises `provider-pool-v1`.

## Limits

Each Mac sees its own requests and the slots each machine advertises, not other
Macs' load, so two Macs can queue on one machine while another has room.
A machine that stops answering in the middle of an answer ends that request
through the ordinary silence timeout. Moving a conversation always costs a cold
prefill on the new member.
