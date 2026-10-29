---
summary: 'Opt-in runtime admission discovery from authenticated local inference capacity snapshots.'
read_when:
  - Changing local worker concurrency or Gateway admission limits
  - Investigating Local AI busy status or stale capacity discovery
  - Adding or draining a local inference worker without editing every Gateway
---

# Upstream capacity discovery

Enable `capacityDiscovery: true` on a local inference provider once. Gateway
then follows its authenticated upstream capacity in memory, without rewriting
`gateway.json` or maintaining a worker count on every Mac.

```text
Workers: actual scheduler slots and health
  → existing router registrar: distinct healthy, registered, unfenced workers
  → authenticated GET /v1/capacity: one farm snapshot
  → existing Gateway handler: bounded refresh every 15 seconds
  → provider admission queue and availability.load.limit
```

Two ten-slot workers advertise twenty. Draining one lowers capacity to ten;
restoring it returns to twenty. Changing a worker's actual scheduler setting
changes its next observation automatically. A decrease never cancels running
requests; new requests wait until the queue has room. The waiting queue stays
bounded at 32 requests per provider.

## Configuration

```json
{
  "id": "local-inference",
  "type": "chat-completions-api",
  "baseUrl": "http://inference.example/v1",
  "tailnet": true,
  "credentialFile": "/private/local-inference.key",
  "capacityDiscovery": true,
  "models": { "local-workhorse": "workhorse" }
}
```

The opt-in is restricted to loopback or checked Tailscale inference providers.
The endpoint is always `{baseUrl}/capacity`, with the provider's existing
credential. There is no extra URL or credential to maintain. An explicit
provider `maxConcurrent` remains a ceiling; without one, fresh discovery can
exceed the gateway-wide fallback. Discovered admission is capped at 64.

Missing, invalid, stale or failed discovery restores the configured provider
limit, gateway-wide limit, or default four. A complete snapshot with no slots
for a configured model gives zero: new work waits until capacity returns or
normal request timeout/cancellation applies. Other providers remain independent.

Numeric settings in the file stay unchanged. Older bundled app and supervisor
validators that preserve unknown provider fields can keep reading this boolean
while a compatible inference handler discovers capacity. Verify compatibility
before activation; an older inference handler may reject the opt-in as a route
change until it adopts the new code.

Admission state is shared across compatible handler generations so an update
does not create another full queue budget. During a one-time upgrade from an
older handler that cannot expose its counters, opted-in providers wait for that
generation to finish before using a discovered budget. Active requests finish.
Retired handlers stop polling and cannot reapply older configuration snapshots.

Discovery does not choose models, change routes, instructions, tools, caller
permissions or queue order, or restart workers. Collection belongs to the
existing inference handler. There is no new macOS background job.

## Capacity contract

The read-only endpoint uses the inference bearer and returns a complete
snapshot. `observed_at` is Unix seconds, including fractional seconds.

```json
{
  "object": "inference_capacity",
  "version": 1,
  "complete": true,
  "observed_at": 1800000000.25,
  "models": [
    { "id": "workhorse", "max_concurrent_requests": 20 }
  ]
}
```

The router sums distinct healthy, registered, unfenced workers. Aliases on one
worker share its scheduler. Opaque worker identities prevent counting one
worker reached through several URLs. An answering worker whose capacity cannot
be read makes the snapshot incomplete; incomplete snapshots cannot raise limits.

Router addresses are replicas of the same farm. Gateway takes the minimum from
successful complete replicas, never their sum. A provider with several upstream
models uses the minimum capacity available to any of them; missing models count
as zero in a complete snapshot.

Responses are limited to 64 KiB and 128 unique model rows. Source counts must be
integers from zero through 4,096. Snapshots expire after 30 seconds and cannot be
more than five seconds in the future. Redirects are refused. The whole probe,
including DNS and body reading, has a three-second deadline. Tailscale addresses
are checked and pinned before sending the credential. Raw worker configuration,
environment, requests, tool arguments and keys are never published.

## Verification and rollback

`gateway availability --json` reports the effective local limit. Compare it with
both authenticated router snapshots using the existing private credential
reader; never print the key or put it in a shell argument. Drain and restore a
worker and observe the limits change. Failed discovery must restore fallback.

This remains local admission, not a global reservation across Gateways. The
upstream scheduler enforces actual running slots. Availability reports this
Gateway's running and waiting requests; ordinary health, quota and failure
precedence still applies.

Disable `capacityDiscovery` to return to static admission. Keep numeric settings
compatible with retained older releases. A worker rollback without the endpoint
safely restores static fallback. See the private deployment runbook for worker
and router rollout receipts and the source of the qualified worker images.
