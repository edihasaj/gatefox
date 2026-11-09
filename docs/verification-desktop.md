---
summary: "Desktop settings and configuration checks, with their tested versions and remaining limits."
read_when:
  - Reading historical desktop verification evidence or choosing a matching verification script
---

# Desktop verification evidence

These are version-specific evidence records and procedures, not a claim that every later build was tested. For current installed readiness, run `gateway rollout --verify --json`. Return to the [verification overview](verification.md).

## Development and desktop settings checks

The v0.2.11 development gate passed all 222 tests, including request deadlines,
silent streams, cancellation, context errors, account-email verification, and
blocked terminal-output cleanup. The isolated installer passed initial and
repeat installation using its bundled runtime. These checks complement the
signed SDK evidence above; they do not replace the remaining desktop checks.

Run the development gate:

```sh
npm run build && npm run check && npm test
```

The current v0.2.10 development gate passed 186 tests. The installed v0.2.8 release's
earlier gate passed 109 tests. Neither count proves the remaining desktop checks.

### Shared gateway execution in v0.2.10 development

The real signed Codex SDK, `0.162.0-alpha.17.2`, passed the shared gateway
execution checks in `scripts/e2e-shared-execution.mjs`. Two adapters reached the
same loaded chat in one engine process. A replacement adapter resumed that chat
after the first disconnected. A third connected adapter also reached the original
owner after the catalog changed. The loaded engine's PID stayed unchanged.
Separate unit tests verified that different native settings key orders reuse
the same generation rather than create another writer.
The mode without inference verifies metadata and live ownership, but does not
claim saved-chat resume. The SDK writes durable history after a real first turn;
the inference mode supplied that turn before its resume checks.

The fixture filled its four-generation limit and refused a fifth generation
without replacing the original loaded owner. After a chat unsubscribed, the
gateway waited for the SDK to unload it naturally. The SDK retained it for about
60 seconds. Only then did the gateway retire that unused generation and accept
its replacement. This check did not force an unload or rewrite saved history.

Claude Sonnet 5.5, Codex 2 GPT-6.1-Sol, and Qwen passed the final real inference
run through these shared clients. Repository `AGENTS.md` supplied a hidden marker
absent from the user prompt; each provider read a seed file and wrote the required proof. A fresh
adapter resumed the chat and edited the proof while retaining its contents.
One adapter then interrupted a stream started by another, and a recovery turn
completed with the proof intact. Claude and Codex 2 also read a code supplied only
in an image and recalled that code after another adapter reconnect. The completed
run made 28 inference calls and confirmed unchanged isolated native configuration
and no copied native authentication.

Qwen's first file/tool check in the combined run failed because its existing
managed SSH tunnel had been unloaded. Restoring that LaunchAgent restored the
transport. A focused Qwen run then passed hidden `AGENTS.md` instructions, file
reads and edits, history across adapter reconnects, cross-adapter interruption,
and recovery. Its final checks confirmed unchanged isolated native configuration
and no copied native authentication, with 11 inference calls. The investigation
recorded transport status and check results, without inference bodies.
The earlier combined run ended before its final invariants. The focused Qwen
result and the later completed three-provider run each supply that evidence for
their own runs.

### Model discovery during an outage

The development adapter keeps a private cache of sanitized public metadata for
the 25 added routes. Its source identity includes the loopback port and a hash
derived from the client token. Provider credentials are excluded, and a cache
from a different source is refused.

The signed SDK check deliberately made discovery return HTTP 503, then opened a
fresh adapter. It retained all 33 names in that isolated SDK catalog. Starting
the explicitly selected cached gateway alias returned application error
`-32001`; the test recorded no inference requests, no new executor, and no native
fallback. After discovery recovered, the same adapter started a gateway chat in
the original engine process without an app restart. This proves the backend
recovery path. The v0.2.10 cache behavior still needs the matching desktop check
after activation; the existing adapter's transport recovery was user-confirmed.

### Control socket isolation

The macOS sandbox check in `scripts/e2e-execution-sandbox.mjs` passed against the
signed SDK. The control socket was reachable outside the sandbox. Inside it,
both the socket alias and its physical path were denied, even with an explicit
Unix socket grant for `/`. This check sent no inference requests.

These results cover the gateway's shared engine and private Unix control socket.
They do not prove shared native executor ownership or the built-in cloud
transport. The primary Mac's reasoning display is user-confirmed, without a
matching menu capture. The original connected-machine checks in the table above
remain pending.

### Installed v0.2.8 desktop settings

The installed v0.2.8 preflight passed the real signed Codex app-server's desktop
settings protocol on MacBook Pro 2. Six display efforts, including Max and Ultra,
were saved before choosing any model. They survived a fresh adapter connection.
Concurrent theme and font edits merged, and a batch mixing a display change with
native sandbox configuration was rejected without partial writes. Native desktop
defaults and the isolated native configuration digest stayed unchanged. These
checks prove persistence through the backend. The rendered Claude picker on
MacBook Pro 2 later showed Max; the corresponding client-side refresh check
remains separate.

Run `scripts/e2e-desktop-settings.mjs` against an installed command with a fresh
client-only fixture, isolated native home, workspace, and gateway state. The
fixture must contain public native model metadata and an unrelated native desktop
setting. The script refuses copied account authentication and existing private
preferences, and sends no inference requests.

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

## Desktop and configuration limits

Live checks through the permanent SSH forward passed attachment reading,
interruption, saved-image history after engine restart, and native `view_image` for Claude,
Codex 2, and Copilot Luna. The main native configuration digest and client token
were unchanged during activation. Temporary verification listeners and their
extra SSH forward were stopped afterward.

The ordinary Anthropic API adapter has a real local HTTP/SSE wire test for
credential selection, effort, hidden summaries, custom calls, image tool replay,
stop reasons, invalid/duplicate tools, truncated streams, disconnect, and recovery.
This fixture proves the gateway contract, not access to a paid Anthropic account.

The signed desktop app is installed on MacBook Pro 2 and onboarding is complete.
The separate-executor version passed the full bundled-engine Claude/Codex 2 loop
there, including the unchanged isolated native-config check. Native inference was
explicitly omitted because that test home has no native subscription login.

The direct launcher has been verified on the test Mac. Process inspection
confirmed the override environment and wrapper children. The rendered desktop
then completed real Claude Opus 5.5 and Codex 2 GPT-6-Luna conversations and a
provider switch. The primary Mac has since relaunched with the installed v0.2.8
desktop adapter. Its rendered refresh behavior still needs verification.

On 11 October 2026, the updated adapter launched on MacBook Pro 2. The rendered
Claude Opus 5.5 chat accepted a PNG attachment and correctly described its red
circle, green square, and blue triangle. The picture code was also supplied as
text, so this desktop check does not prove image-only code reading. The separate
bundled-engine tests above provide that proof. At that point, the desktop label
still showed Extra High. The later v0.2.8 local picker check showed Max; it does
not prove effort persistence in a remote chat on the primary Mac.

That investigation reproduced a separate preference bug: two adapter connections
cached their own defaults, so one could return High after the other saved Max.
The fix rereads preferences and locks updates across processes. Regression checks
cover stale reads, new-chat effort, concurrent edits from separate processes,
abandoned locks, and cleanup after a failed update. v0.2.8 also fixes display-only
settings that were lost before a model preference existed. The current release
evidence above separates these backend checks from the remaining rendered checks.

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
