---
summary: 'Speed (service tier) handling for gateway and native rows in the Codex desktop adapter: session start versus mid-chat, Flex, unknown tiers and the private tier store.'
read_when:
  - Changing service tier handling in the desktop adapter or the Responses providers
  - Investigating a Fast, Flex or Standard mismatch in a gateway chat
  - Changing the private thread tier store or its 0.4.0 compatibility
---

# Speed controls

Part of the [Codex app-server adapter](app-server.md).

Gateway discovery retains the provider's public `service_tiers`,
`additional_speed_tiers`, and `default_service_tier` fields. The adapter validates
them through live discovery and its private offline cache, then exposes the same
capabilities in local and connected-machine `model/list` responses. Native rows
retain their original capabilities. No speed tier is inferred from a model name.

Standard remains the default in this installation. Choose Fast only for a model
that advertises it; the pinned SDK identifies Fast as `priority`. Gateway-only
preferences restore a saved new-chat default for the exact selected model. An explicit
`serviceTier` or `config.service_tier` takes precedence, including explicit null
for Standard. A model-only preference change clears the preceding model's tier.
Resume and fork inherit their chat's tier; new-chat preferences never replace it.
A tier the selected gateway row does not offer is handled as the pinned SDK handles it,
and the SDK treats opening a session differently from running inside one. Flex is the
exception: the SDK keeps and sends it for every model, so the gateway never drops it.

| Request | What the gateway sends | What happens |
| --- | --- | --- |
| `thread/start`, `thread/resume`, `thread/fork` naming a tier the row lacks (`serviceTier` or `config.service_tier`), or inheriting a chat tier the row lacks | `serviceTier: null` and no `config.service_tier` | The chat starts as Standard, as the SDK does when it builds a session. |
| `thread/resume`, `thread/fork` for a chat whose tier the gateway never read | No tier | The SDK applies its own default and drops what the model lacks. |
| `turn/start`, `thread/settings/update`, `turn/settings/update` | The request as the caller sent it, whatever the tier | The SDK accepts any tier string, keeps it as the chat's chosen tier, and leaves it off the outgoing request while the model lacks it. |

At session start the gateway applies a saved new-chat default first and then checks it
against the row, so a saved Fast default for a row that no longer offers Fast starts
Standard instead of failing. Inside a chat the gateway never sends `serviceTier: null`
for a tier, never clears the chosen tier, and adds no inherited tier. A Fast chat that
runs a turn on a Claude row therefore runs that turn as Standard, and the next turn on a
Fast row runs Fast again. `serviceTierForTurn` changes one turn only and never the chat's
tier; the gateway maps its legacy value `fast` to `priority`. A tier that is not a string
is passed through unchanged, and the SDK answers it as invalid parameters. The
`serviceTierForTurn` field exists only on `turn/start`, so a session start passes it
through untouched. Saving a gateway default tier that the chosen row does not offer is
the one tier check left: that configuration write fails with error `-32002` and asks
the user to choose Standard or another model. That check has no Flex exemption: a Flex
default can be saved only for a row that declares Flex, as in 0.4.0 (see
[Rollback and mixed versions](#rollback-and-mixed-versions)). Flex is passed to the
provider at session start and inside a chat, as native Codex sends it. The Codex
subscription provider forwards it without checking the row's tier list. The Claude and
Copilot providers treat Flex as Standard; that handling ships in the same release.

The SDK accepts any tier string inside a chat, including values such as `auto`, `Fast`
or a very long id. The gateway's private tier record holds only lowercase ids of up to
128 characters that are not `auto`. For any other tier the gateway records the chat's
tier as unknown. It writes this through the same locked, timestamp-ordered path as a
known tier: a marker row holding the source time stays under a separate key derived
from a hash of the chat id, and the chat's own record becomes a Standard row with the
marker's stamp. This build reads a row no newer than its marker as unknown, so a later
resume or fork adds no inherited tier, on this connection and on any fresh one, and an
older notification that arrives late cannot bring a tier back. Both are ordinary rows
in the existing file format, so a 0.4.0 build still reads the whole file. It never
looks the marker up and finds the Standard row, so after a rollback a fresh 0.4.0
process can fork the chat and change its model; with no record it would refuse both
with `-32002`. The row and the marker are evicted together and count as two rows. A
marker also wins over a non-Standard row that falls inside its
uncertainty window, because a 0.4.0 build wrote that row without knowing the watermark.
A newer Standard row from a 0.4.0 build is trusted over the marker, and it keeps the
marker's window, so a late non-Standard notification is still rejected. A marker that
outvotes a 0.4.0 row keeps that row's window too. A tier the store can hold
that is chosen later replaces the marker. Such a tier never fails a settings notification
or a resume, and recording it makes room like any other write. When a peer connection
has marked the chat unknown, this connection also stops forwarding the tier it held,
whether its own notification was rejected as older or its resume was in flight.

Each dropped tier is recorded as a `service_tier_dropped` telemetry event, only after
the SDK accepted the request and only when its answer shows the chat started as Standard.
A loaded chat with another subscriber ignores the override on a resume and answers with
the tier it kept, and no drop is recorded then. See
[diagnostics](diagnostics.md#local-telemetry) for its fields.

The pinned SDK does not restore speed from saved history. The gateway therefore
keeps public per-chat model/tier metadata in its own private state, scoped to the
original native home. Fresh connections reread this record. Runtime settings are
recorded from the SDK's applied settings notification, not its queued update ACK.
SDK source timestamps reject delayed settings events. Private revisions prevent
an older resume reply from replacing a newer choice. Conflicting events stamped
in the same millisecond resolve conservatively to Standard; an explicit confirmed
SDK snapshot can establish the current choice again. Clock uncertainty never
restores Fast from an uncertain older notification.
The adapter passes the known parent tier explicitly when forking because the SDK
otherwise uses executor defaults. If the gateway never read the parent's tier, the
fork carries no tier and the SDK chooses its own default.
The SDK's returned tier is authoritative. Resuming an already-loaded chat keeps
its loaded settings even when resume parameters request another tier; change it
through `thread/settings/update`. A cold resume can apply an explicit override.
Temporary active-turn tiers remain separate from the chat default.
Gateway executors enable the SDK's Fast feature when their validated catalog
offers priority. Native feature flags and configuration files retain their values;
enabling that private capability does not select Fast automatically.

A loaded Fast chat that switches to a model without Fast keeps its Fast tier, and the
SDK runs the new model's requests as Standard. The private record of that chat holds
Standard from the switch on, because its row does not declare Fast; the SDK's Fast
returns to the record when the chat is on a Fast row again. A connection that cannot
determine the saved tier sends none, so a model change never clears or invents it.
Reasoning effort is independent of speed.

## Rollback and mixed versions

The 0.4.0 adapter checks a chat's saved tier against the tiers its row declares and
refuses with `-32002` when the row lacks it. During an upgrade, 0.4.0 adapter processes
keep running beside this build on the same state files until the desktop restarts its
CLI, and a rollback leaves 0.4.0 in charge of every saved chat. The rule that keeps
both safe:

| What is written | What this build writes |
| --- | --- |
| A chat's tier in the private tier store (session-start answer, applied settings notification) | The tier only if the chat's row declares it in its catalog metadata, with no Flex exemption. Any other storable tier is recorded as Standard. A tier the store cannot hold stays the unknown marker described above. |
| A saved new-chat default (`config/value/write`, `config/batchWrite`) | Only a tier the selected row declares, or Standard. Anything else fails with `-32002`. |

A Flex chat, a Fast chat that moved to a row without Fast and a saved default therefore
resume and run turns under 0.4.0 without an error, provided the chat is not loaded in
an SDK that a 0.4.0 client shares with this build. A loaded chat keeps its Flex, or the
Fast it had before moving to a row without Fast, inside the SDK, and the 0.4.0 client
checks that tier against the row and can refuse with `-32002`. To recover, choose
Standard in the 0.4.0 client, or reopen the chat from 0.4.1. The cost is that a chat on a row
without Flex declared does not carry Flex across a resume or fork: the SDK still keeps
and sends Flex while the chat is loaded, but the next session start inherits Standard
from the record. Nothing else changes: the record is read only at session start, where a
tier the row lacks already starts the chat as Standard (Flex was the one exemption), and
inside a chat the gateway forwards tiers untouched and never applies the record. The test `app-server-0-4-0-rollback.test.ts`
runs every row and saved default this build writes through the 0.4.0 checks, which
`app-server-0-4-0-tier-check.ts` copies verbatim from release commit `4a8bb9e`,
including the chats on a tier the store cannot hold (`auto`, `Fast`).

The compaction recovery file is bounded differently. This build keeps 4096 chats and
evicts the oldest instead of failing. After a rollback with a full 4096-row file, 0.4.0
still updates the chats already in it, but it refuses a row for a new chat and warns that
compaction recovery metadata is unavailable for it.

Claude rows offer Fast when Claude's own model list marks the model as supporting
fast mode (currently the Opus models). Fast turns on Claude Code's fast mode for
that request, which Claude bills to the account's usage credits. Discovery
refreshes this capability with the rest of the catalog, so every connected
machine sees the same option.

The current Copilot CLI does not offer a selected-model Fast tier. Its four
configured models expose no speed options. A direct Fast request is rejected
before starting the CLI. The integrator-only Auto Fast API is a different route
and is not enabled by this installation.

Installing updated adapter code preserves open apps and running services.
Already-loaded older adapters need their next normal launch to expose these new
fields. Catalog updates use the usual live discovery path after activation.

The circular arrow in the model control is **Reset to default**. It chooses a
default power preset; it does not fetch a fresh model catalog. That preset can
belong to the native account, so a gateway chat cannot always apply it. Provider
switch refusals use an application error code rather than the app's configuration
validation code, avoiding a false warning that `config.toml` is broken. Explicit
saved model defaults are also reflected in the catalog's default flag. The app's
power presets can still exclude custom aliases, so this flag does not permit a
loaded chat to change providers.

The adapter fetches the inference host's public catalog when listing models and
starting gateway work. A changed catalog starts a fresh gateway executor for new
chats. Loaded native and gateway chats keep their connections. To select a newly
added model in an older loaded gateway chat, close and resume that saved chat, or
start a new one. Ephemeral chats cannot be resumed after their executor exits.

Gateway model names remain listed during a connection outage, including after
an adapter restarts. A private cache stores the last valid public model rows,
scoped to the local gateway port and a hash of its client token. Selecting a
gateway model still requires fresh discovery. An unavailable gateway returns
application error `-32001` before creating a chat or using the native account.
When the connection recovers, normal discovery reloads the catalog without an
app restart. Invalid or differently scoped caches leave native models usable.

The desktop query itself has a five-minute cache and refetches on focus in the
installed build. Catalog changes require no app restart after initial activation,
but immediate visible picker updates are not guaranteed. There is no fabricated
account-change notification to force a refresh.

Gateway executors use a private configuration home and share native chat storage.
They do not copy the primary auth file. See [architecture](architecture.md) for
configuration isolation, catalog generations, and failure recovery.
