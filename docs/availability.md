---
summary: 'Read-only availability facts per provider: local model health, load, subscription quota and paid balance.'
read_when:
  - Changing /v1/availability, gateway availability or the availability settings
  - Connecting Spendwatch quota or a local model server to availability reports
  - Investigating why a provider reports unknown, busy, limited or unavailable
---

# Availability

`GET /v1/availability` reports what this gateway can serve right now, so an agent
or script can keep working when one account or server is used up or down. It
reports facts only. The gateway never picks a model, changes a route or reorders
the catalog because of these facts; the caller makes every choice.

The endpoint needs the gateway client token, like every other non-health route.
`gateway availability [--json] [--wait MS]` prints the same report for this Mac.
It exits 0 whenever it prints a report. When the gateway cannot answer, it prints
`status: "unknown"` with a fixed reason, so a caller can carry on as before.

## What each provider row contains

| Field | Source | Notes |
|---|---|---|
| `status` | derived | `available`, `busy`, `unknown`, `limited` or `unavailable`, with fixed `reasons` |
| `load` | the provider's admission queue | `running`, `queued` and `limit` on this Mac only |
| `health` | local probe | Only for self-hosted servers (loopback or `tailnet: true`) |
| `quota` | Spendwatch or the gateway's own usage rows | Windows, `remainingPercent`, account email |
| `balance` | OpenRouter `GET /credits` | Remaining and total USD |
| `lastFailure`, `lastSuccessAt` | this gateway's request outcomes | Fixed failure class and code only |

Every observation carries `observedAt` and `fresh`. A source that fails keeps its
last observation, which stops being `fresh` on its own; one failing source never
removes the others.

## Status rules

- `unavailable`: a fresh probe says the local server is unhealthy, the last
  request failed with an authentication error within a day, or a connection
  failure within two minutes that no newer healthy probe has cleared.
- `limited`: a live quota window is at 100% (until its reset, however old the
  reading), a quota failure within six hours with no later success or newer quota
  reading, a throttle until its `Retry-After` (two minutes without one), or a fresh
  zero balance.
- `unknown`: a local server without a probe in the last 90 seconds.
- `busy`: running requests reached the provider's limit, or requests are queued.
- `available`: none of the above.

A later successful request clears every failure-based reason. Missing quota is
not a reason: no data means no claim, never "has headroom".

## Collection

Collection starts with the first availability request and stops after 30 minutes
without one, so a gateway nobody asks makes no extra calls. Requests read the
in-memory snapshot only. `?wait=MS` (at most 5000) lets a cold request wait for the
first round; the CLI waits 2500 ms by default.

| Source | Every | Bound |
|---|---|---|
| Local probe, `GET {baseUrl}/models` per resolved address | 20 s | 3 s per address |
| Spendwatch `capacity-current --provider codex\|claude --json` | 2 min | 15 s, 512 KiB |
| Account emails from the Codex credential record and Claude `.claude.json` | 5 min | read only |
| OpenRouter balance | 5 min | 5 s |

A tailnet provider's probe uses the inference transport: the key is sent only to
Tailscale addresses, and each address is checked separately, so one router down
out of two reports `degraded`. Router-side load (running and waiting requests on
the model servers) is not reachable from the Macs, so `load` covers this Mac's
queue only.

## Settings

```json
{ "availability": { "spendwatch": "/Users/me/.local/bin/spendwatch" } }
```

`spendwatch` is an absolute path. Without it, quota comes only from the gateway's
own Codex usage counters and refused Claude windows. Spendwatch rows join a
provider by the account email of its own local login; no credential or token is
read into the report. The report contains no tokens, request bodies or file paths.
