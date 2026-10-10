---
summary: 'Verified subscription operations and remaining desktop checks.'
read_when:
  - Testing subscriptions or remote clients
  - Assessing desktop readiness
---

# Verification

Run the development gate:

```sh
npm run build && npm run check && npm test
```

Tests cover authentication, account isolation, Responses parsing and replay,
stream termination, cancellation, live route guards, private model preferences,
public catalog validation, approval correlation, and executor lifecycle.
Catalog-generation tests use a controlled app-server fixture. They do not prove
the rendered desktop picker or provider entitlement.

## Real subscription checks

MacBook Pro 2 passed a real Claude Sonnet 5.5 and Codex 2 GPT-6.1-Sol loop over an
authenticated SSH forward. It streamed text and reasoning, read a random file
proof, applied a dedicated patch, retained follow-up history, switched providers,
acknowledged cancellation, released its worker, and completed a recovery turn.
Only the gateway client token crossed SSH. Provider credentials stayed on the
inference host.

Earlier bundled-engine checks on the inference host verified the primary account
and the combined 28-model catalog. A separate Haiku 4.5 request verified its
no-reasoning route. Listing a model does not prove inference access or inclusion
without usage credits. The remaining catalog models have not all been inferred.

## Desktop and configuration limits

The signed desktop app is installed on MacBook Pro 2 and onboarding is complete.
The separate-executor version passed the full bundled-engine Claude/Codex 2 loop
there, including the unchanged isolated native-config check. Native inference was
explicitly omitted because that test home has no native subscription login.

The first rendered picker showed only native models. Process inspection confirmed
that the running app lacked the adapter environment variables. The direct launcher
now records its process PID; rendered gateway selection remains unverified. Live
catalog addition has passed controlled executor tests and still needs a real
bundled-engine addition check. The working Mac's app has not been relaunched.

The installed desktop model query has a five-minute cache and refetches on focus.
The adapter cannot promise immediate visible updates. Its initial launch hook is
an implementation detail, not an established public desktop extension API.

Native Codex may add project-trust settings when executing tools in a new Git
workspace. Use an isolated native home on the test Mac. If a native-home check is
necessary elsewhere, use an already-trusted workspace and `--workspace PATH`.
Do not create new test Git projects in the working machine's native configuration.
