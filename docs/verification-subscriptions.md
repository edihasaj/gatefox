---
summary: "Real subscription checks and recorded provider-specific verification limits."
read_when:
  - Reading historical subscription verification evidence or choosing a matching verification script
---

# Subscription verification evidence

These are version-specific evidence records and procedures, not a claim that every later build was tested. For current installed readiness, run `gateway rollout --verify --json`. Return to the [verification overview](verification.md).

## Real subscription checks

On October 13 a development gateway on the native-spend build forwarded the Codex 2
turn-state through a real two-turn Codex CLI 0.160 run (GPT-5.6-Luna, low effort).
With a 2-second cap on the deferred response head, the second turn lost its
turn-state: upstream heads took 1.5 to 4.7 seconds, and 6 of 10 eligible requests
opened their head without the header. With the head waiting up to one heartbeat
interval, all four head probes (1.9 to 3.2 seconds) carried the header, and each
turn returned a turn-state on its first request and echoed it on the next. The
probe recorded only timings, booleans and token counts.

MacBook Pro 2 passed a real Claude Sonnet 5.5 and Codex 2 GPT-6.1-Sol loop over an
authenticated SSH forward. It streamed text and reasoning, read a random file
proof, applied a dedicated patch, retained follow-up history, switched providers,
acknowledged cancellation, released its worker, and completed a recovery turn.
Only the gateway client token crossed SSH. Provider credentials stayed on the
inference host.

Copilot CLI 1.0.95 passed the real bundled Codex loop on MacBook Pro 2 through
SDK protocol 3: incremental text, file proof, custom patch and verification,
follow-up replay, provider-exposed reasoning, interruption, worker cleanup, and
recovery. Interruption was acknowledged in 3 ms. Earlier discovery returned 13
explicitly selectable models after removing Auto. The current catalog exposes
only the four requested Copilot models. This test proves one model's full loop,
not every discovered model's inference access. Rendered Copilot selection remains
unverified.

Copilot live sessions (`copilotSessions.mode: "live"`) passed a real check on CLI
1.0.97 in October 2026, through an isolated test gateway with its own state folder and
`TMPDIR`, on `gpt-6-luna`. A three-round tool loop stayed in one CLI process. Rounds 2
and 3 read 98% of their input from the cache, wrote under 60 tokens and cost 4.8 to 6.0
million nano-AIU each. An effort change between turns continued the same session with
98.6% read from the cache. Stop while a tool waited reseeded the thread
(`unexpected_tail`), and a request without a thread id ran one-shot. Every request wrote
one content-free ledger row with complete credit figures. `~/.copilot` gained no session
rows or session folders. A normal shutdown removed the parked session's process and
folder. After the gateway was killed outright, its CLIs exited when their input closed,
and the next gateway's startup sweep removed their folders. The check found that the CLI
sends `session.idle` right after `assistant.idle`; the gateway first treated it as
unrequested output, and now accepts it between requests. That check did not cover a
one-shot request that ends in tool calls on the external-tool setup, which the gateway
closes with `session.abort` and SIGKILL as a live session ends; only the scripted CLI
fixture tests cover it, so repeat it against the installed CLI after upgrading.

A real text sweep passed all 20 loaded Claude/Codex 2 routes. It found and verified
a fix for the unsupported upstream `summary: "none"` value. Copilot passed 12 of
13 routes in that earlier catalog. Its Opus 5 request returned Opus 4.8, so the
gateway rejected the substitution. That route is not verified as usable. The Copilot Sol 6.1
catalog also advertised `none`, which its endpoint rejected; discovery now omits
that unsupported effort. These sweeps do not prove images or every model's tool
loop. Run `node scripts/e2e-models.mjs --config PATH --output PATH` to repeat them.

All 20 Claude/Codex 2 routes passed a real PNG check whose random eight-digit code
appeared only in pixels. Sonnet 5.5 and Codex 2 Sol also passed JPEG, WebP, and GIF
checks with follow-ups and image tool-result replay. Copilot Sonnet 5.5 and Luna
passed PNG input, follow-up, and tool-result checks.

The bundled Codex engine on MacBook Pro 2 passed four operations for each of the
20 Claude/Codex 2 models: local image attachment, turn interruption, saved-chat
resume after restarting the engine, and real `view_image` execution. Each model
read the correct picture code. This verifies the engine and transport, not the
rendered attachment UI. Codex's tested pause behavior interrupts a turn and starts
a new turn from saved history; it does not suspend and continue the same token stream.

`scripts/e2e-images.mjs` runs direct image checks. Its fixture directory contains
`fixture.png` and any selected `fixture.jpg`, `fixture.gif`, or `fixture.webp`, plus
`expected.json` with `code`, `colors`, and `shapes`. `scripts/e2e-agent-images.mjs`
runs attachment, stop/resume, and viewer checks through the real bundled engine.
`scripts/e2e-all-tools.mjs` repeats the file-read/edit, follow-up, reasoning,
cancellation, and recovery loop for every configured alias. Models without a
reasoning capability report that case unsupported rather than inventing reasoning.

The complete file/tool sweep passed all 20 Claude/Codex 2 aliases: streamed text,
random file proof, native patch and verification, follow-up replay, supported
reasoning, interruption, worker cleanup, and recovery. Daybreak added a final
period to the recovery marker; the checker now accepts terminal punctuation and
its full loop passed again. Copilot CLI 1.0.91 repeated its entire model catalog.
Discovery removes identical repetitions and rejects conflicting metadata for the
same ID. The account is not switched and its CLI is not updated automatically.
That CLI also omits the optional assistant `providerId`. The adapter accepts its
response only after subscription usage reports `isByok: false` and the returned
model matches the request. Explicit provider changes and BYOK still fail closed.

Earlier bundled-engine checks on the inference host verified the primary account
and the then-current 28-model catalog. A separate Haiku 4.5 request verified its
no-reasoning route. Listing a model does not prove inference access or inclusion
without usage credits. Native inference has not been tested for every native
account model.
