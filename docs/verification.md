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

The idle-restart regression covers active inference, partial request uploads,
and catalog reads that have not created an inference controller. The real
LaunchAgent check passed on MacBook Pro 2: both busy restarts were refused,
the idle restart changed its PID, and recovery completed with the same token
and exactly two upstream calls.
On an unused macOS test host, run the real LaunchAgent lifecycle check:

```sh
node scripts/e2e-service.mjs --install-test-service
```

It refuses an existing gateway service or plist. It installs a temporary service,
checks both busy restart refusals, restarts while idle, then verifies inference,
the unchanged client token, and two upstream calls. The upstream is a local
Responses fixture; this check does not prove provider authentication. Cleanup
uninstalls the service. Only the temporary plist receives a dummy fixture key;
no provider credentials or global launchd environment values are changed.

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

The direct launcher has been verified on the test Mac. Process inspection
confirmed the override environment and wrapper children. The rendered desktop
then completed real Claude Opus 5.5 and Codex 2 GPT-6-Luna conversations and a
provider switch. The working Mac's app has not been relaunched.

A separate staging daemon passed a live catalog addition while an older gateway
chat ran a command. The new chat used the new context-window metadata. The
original native and gateway executor PIDs remained alive. Cancellation completed
in 109 ms. Shared thread discovery, saved-history resume, and public Codex reasoning
also passed. The test alias pointed to an existing Sonnet model, not a newly
entitled model. It was removed after verification.

Instruction-only checks proved that global and repository AGENTS.md rules reached
Claude Sonnet 5.5 at `max` and Codex 2 GPT-6.1-Sol at `ultra`. Each rule contained
a random value absent from the user prompt; each response returned it without
calling a tool. Changed global and repository rules reached subsequent Claude
chats through the same connection. The isolated native config remained unchanged.

The gateway advertises the provider's reasoning levels. Desktop display has a
separate filter under Model features, Available reasoning efforts. Max is omitted
from the installed default list; Ultra display also depends on the app's feature
availability. The API tests prove the requested effort values reached successful
turns, not that every level is visible in the rendered picker.

The installed desktop model query has a five-minute cache and refetches on focus.
The adapter cannot promise immediate visible updates. Its initial launch hook is
an implementation detail, not an established public desktop extension API.

Native Codex may add project-trust settings when executing tools in a new Git
workspace. Use an isolated native home on the test Mac. If a native-home check is
necessary elsewhere, use an already-trusted workspace and `--workspace PATH`.
Do not create new test Git projects in the working machine's native configuration.
