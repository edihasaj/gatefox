---
summary: "Live controller updates, safe release adoption, retained components and release-skew recovery."
read_when:
  - Changing service updates and release adoption
---

# Service updates and release adoption

Return to the [managed service overview](services.md).

## Live supervisor controller updates

After one service start on a release with supervisor runtime ABI 1, compatible
installed releases can replace supervisor control in the existing process.
The minute watcher stages the new immutable module and waits for two checks.
It verifies the selected release and exact canonical service plan again before
committing. A changed plan or incompatible ABI stays pending for a natural start;
it never activates staged sharing or consolidation as a side effect.

```text
One signed app-owned root: same PID, lock and signal handlers
  → new supervisor controller
  → same child handles, exit observers, retries and paused slots
  → same live execution host, Claude requests, relays and SSH connections
```

Controller retirement stops only its recurring control schedules. It does not
send a stop signal, close a transport or replay an inference. A failed activation
restores the old controller and schedules. Release leases retain code still used
by inherited callbacks until this root eventually stops. There is no additional
LaunchAgent, Login Item or maintenance job.

A swap is refused while a host probe, start or restart check is in progress
(`canHandover`). Both run on one-minute timers started together, so before 1.5.8 a host
probed every minute (for example one marked `sdk_changed`) could refuse every swap, with
nothing logged. Since 1.5.8 a swap refused only for that brief work is tried again every
2 s, up to 15 times, and a release still refused that way is logged once as
`self_upgrade_waiting` with `reason: handover_busy`. Like every controller change, this
applies to moves made by a 1.5.8 or later controller. A 1.5.8 or later service publishes `liveUpdates: true`
in its status when it swaps controllers live; health then reports a controller that has
not swapped yet as such, since Claude Desktop components never block the swap. Only a
service without live updates is held by the Claude restart rule, and an older service
that does not say gets both ways out.

`gateway service status --json` reports `runtime.controllerRelease` separately
from `runtime.runningRelease`, the root's immutable bootstrap release. Retained
host and native components keep their actual provenance. A live controller
change is not proof of complete rollout readiness, and the strict rollout gate
continues to report those pending components.

The retained host is offered the new implementation through its strict idle gate
without restarting the supervisor or its other children. Once that gate accepts,
the host closes and starts under the new implementation.

Adapter leases and loaded chats keep the strict gate closed for as long as an app
stays connected. So since 1.5.4, once the release move has waited the 15 minute
grace (`upgradeGraceMs`), the host also moves when its chats drain. That uses the
same quiet check the whole-service move uses: no turn running or waiting for an
approval or input in any engine, no background terminal, and no turn ended in the
last 5 minutes. The check runs at most once a minute, from the host probe. Only the
execution host restarts. Inference, tunnels, the relay and Claude Desktop components
keep running, so the Claude restart guard does not apply. Loaded chats re-attach on
their next request, as after any host restart. As with the quiet service move, a turn
that starts in the few milliseconds between the final check and the close is cut and
continues from saved history. A restart for an unhealthy host or a relay registration
still needs the strict gate. The move is logged as `execution_host_quiet_upgrade`
with `loadedChats`, and each reason it waited is logged once per move as
`execution_host_upgrade_waiting`. This policy lives in the retained host keeper, so a
service that started before 1.5.4 gets it at its next natural start.

Older already-running supervisors cannot acquire this loader by moving the
`current` link. They need one initial natural login/reboot or an explicitly
authorized controlled restart. Installation alone does not remove that bootstrap
requirement. ABI 1 retains the original host-keeper object and child observer
closures as the stable ownership layer; future changes to that layer can require
a new ABI and one natural root restart. The new controller and host factory do
not relabel that older code as fully replaced. Use normal lifecycle guards; never force-stop active work to make
a version receipt current.

## Moving to a new release

Installing a release only switches the `current` link. The supervisor checks once a
minute and, when `current` names another release, restarts itself; launchd starts it
again on the installed release. It waits for one of three moments:

1. **Idle**, tried first at every attempt: the execution host has no adapter lease and
   no loaded chat, then inference accepts its own idle guard.
2. **Quiet**, once the newer release has been installed for 15 minutes and the idle
   restart still refuses: no turn is running in any engine, gateway or native, no chat
   keeps a background terminal, and no turn ended in the last 5 minutes. A turn waiting
   for an approval or for user input counts as running. Leases and loaded chats do not
   block it. Inference must still accept its idle guard, so a running inference request
   still refuses, and the next attempt asks again.
3. **Urgent**, when a newer adapter is waiting beside this older host (see
   [release skew](services-releases.md#release-skew-a-newer-adapter-beside-an-older-host)): no 15 minute
   grace, and the quiet check ignores recently ended turns. Only a running turn, a
   background terminal or busy inference holds it back.

The 15 minutes count from when the running service first saw the release, on the
monotonic clock, which stops while the Mac sleeps: they are 15 minutes of awake time,
so a Mac that sleeps right after an install waits that much longer after it wakes.

The idle rule alone can wait forever: a ChatGPT on another Mac stays connected over
SSH for days, holds a lease, and its SDK keeps its chats loaded. On 2026-10-17 a Mac
stayed on the previous release for this reason until an operator stopped the
service.

The host never sees turn notifications: adapters talk to engine sockets directly, and
a client the host kept open would be subscribed to new chats by the SDK and keep them
loaded. So each quiet check opens one short admin connection per engine and asks the
engine itself (the pinned gateway SDK, or for native chats the app's own signed codex)
about every loaded chat:

- its live `thread/read` status;
- its background terminals (`thread/backgroundTerminals/list`). They are on by
  default, outlive the turn that started them and end only when the engine closes the
  chat's session, so a dev server an agent left running would die with the restart. A
  chat that keeps one is never quiet, and the upgrade waits until the terminal ends or
  is closed;
- its newest turn (`thread/turns/list`, with the running turn merged in), which ended
  at its `completedAt`, or, when it has none, at the later of its start and the chat's
  `updatedAt`. Reading it replays the chat's whole saved history, so a saved chat whose
  `updatedAt` is more than the quiet time plus a minute old is judged by its read
  alone: the SDK touches `updatedAt` whenever it appends to that history, at most 5
  seconds apart. A chat with no turns has nothing that ended.

A throwaway chat, and one that has saved nothing yet, cannot list its turns, and its
`updatedAt` is the time of the read, so neither tells when a turn ended. Only such
chats are judged by the host's own watch: one is quiet once the host has seen it
settled (not running, no terminal) at every check for 5 minutes; a check that sees it
running, or that cannot read an engine, starts that watch again. The watch cannot see a
throwaway chat's turn that starts and ends entirely between two checks, which run about
every 2 minutes. A saved chat with a real `updatedAt` whose turn list fails is not
watched: it ended its newest turn no later than its `updatedAt`. A chat or a status the
check cannot read, or more than 256 loaded chats in one engine, counts as not quiet. A
chat that was running at the previous check and is not now (its turn ended, the chat was
unloaded, or its engine exited) counts as having ended at this check. Each reason a
quiet attempt waited is logged once per pending release as `self_upgrade_waiting`
([diagnostics](diagnostics.md)).

The check runs in the host's control queue like the idle check and closes the gate the
same way: once it passes, `execution/acquire`, `execution/find` and `native/acquire`
are refused as quiescing until the service stops or the attempt is refused and the gate
reopens, which takes up to 3 seconds when inference refuses its idle guard. An adapter
asks again every 100 ms for up to 5 seconds before it reports that refusal.

The service then stops as it does for any restart, and connected clients see the host
go away as they do after a host restart. An adapter's engine connections close: when
native chats are shared too, the adapter closes the app's connection and the app
reconnects; otherwise, since 0.4.7, the adapter re-attaches a gateway chat on its next
request: it kicks the service, waits up to 20 seconds for the new host, resumes the chat
there and then sends the request ([re-attaching gateway chats](app-server.md#re-attaching-a-gateway-chat)).
Only when the host stays down does the request still report that the executor
connection was lost. Turns start on engine sockets, not through the host, so the
check cannot hold one back: a turn started in the second or two between the quiet check
and the host's close (inference exits first) is cut, as at any service restart, and
continues from saved history after a resume. `gateway service restart` keeps the idle
rule and its maintenance window. Each move is logged as `self_upgrade` with `mode`
`idle`, `quiet` or `skew`, and for `quiet` and `skew` the number of chats still loaded.

## The host waits while an app is attached

The quiet host move (above) restarts the execution host, which closes every attached
app's control connection: the adapter then ends its session, and ChatGPT 26.1029 restarts
with "hit a snag" (MacBook Pro, 4 Nov 2026, at the 1.6.1 install). Since 1.6.2 the
controller holds that move while an app is attached, meaning a desktop adapter or an SSH
listener is running (one `ps` scan every 15 s; an unreadable list counts as attached). It
does this by making the keeper's quiet grace never elapse, which keepers older than the
controller already read, so it takes effect at the live controller swap without a
restart. A new controller starts held and releases the hold only once its first scan
finds no app attached, because a release can have outwaited the grace long before the
swap. Until 1.7.1 the hold was open in those moments: installing 1.7.1 moved the host
of a Mac with 14 loaded chats 2 seconds after the swap (6 Nov 2026). The host still moves when no app is attached (the strict idle move), at the next
natural start, and at once when it refuses a newer adapter (the urgent skew move is never
held). A held host is logged once per release as `execution_host_upgrade_waiting` with
`reason: app_attached`, and the service status carries `hostMoveHeld: true`.
`gateway rollout` then verifies the host against the release it runs, and counts it ready
only while that release ships the installed release's gateway SDK. Host-side fixes in a
release therefore reach a Mac when its apps disconnect or the Mac restarts.

An attached app also survives a host restart that does happen (an unhealthy-host
restart, a service restart, a crash) while none of its native turns is running: the
adapter rejoins the restarted host's engine as the same session. See "Surviving a host
restart" in `docs/engine-exits.md`.

## Desktop adapters wait for the app's next launch

A desktop adapter is the process ChatGPT starts for its app-server connection. Before
1.6.1 it moved to a newly installed release by exiting after 30 s without traffic, even
though ChatGPT stayed connected. ChatGPT 26.1029 does not survive that: it restarts its
engine and shows "ChatGPT hit a snag" (MacBook Pro, 4 Nov 2026, at every install). Since
1.6.1 the adapter exits for a release only when that release ships another gateway SDK,
which an older adapter would need because a moved host refuses its SDK. Otherwise it keeps
serving the open app, logs `self_upgrade_waiting` with `reason: same_gateway_sdk` once, and
the app runs the new release from its next launch. `gateway rollout` counts such an adapter
as `retained` and `gateway health` does not report it as lagging. An adapter that cannot
read either release's SDK receipt keeps the earlier exit. This is decided by the running
adapter's own code, so the release after 1.6.1 is the first install that leaves ChatGPT
alone.

## Release skew: a newer adapter beside an older host

Since 1.5.2 an older host normally serves a newer adapter on the installed release's
SDK instead ([per-chat rollout](services-releases.md#per-chat-rollout-newer-adapters-run-on-the-installed-releases-sdk)).
The refusal below remains for an installed release whose own verifier is unavailable or
does not confirm its SDK.

On 2026-10-18 an operator installed 0.4.7 while Studio's service ran 0.4.6. Agents kept
turns running, so neither the idle rule nor the quiet rule (no turn ended in the last 5
minutes) ever fired. Studio's ChatGPT restarted and its adapter came up on 0.4.7, the
installed release. Every request from it failed for hours: the 0.4.6 host refuses a
generation whose `gatewaySdkSha256` is not its own gateway SDK, and the host masked that
refusal as "Execution operation failed; managed chat ownership was preserved", which the
app showed as "Failed to resume chat".

The host now says what is happening, and the service moves promptly:

1. **The message.** The host answers a generation request that names another release's
   gateway SDK with a fixed text for the direction (item 2), which it passes through
   unchanged and the adapter shows for the request: starting or resuming a chat, and a
   chat re-attaching after its executor went away. For `adapter_newer`: "This Mac's
   gateway service is moving to the newer release; this chat continues as soon as no
   turn is running". For `adapter_older`, or a direction that could not be told: "This app
   and this Mac's gateway service run different gateway releases; quit and reopen ChatGPT
   to load the installed release". The refusal is the chat's own failure, not a lost
   host, so it opens no fail-fast window. The host records `release_skew_refused` with a
   `direction` and a `count`, at most once a minute per direction
   ([diagnostics](diagnostics.md)). A host with no gateway SDK of its own cannot tell the
   sides apart and keeps the generic refusal.
2. **The direction.** The adapter is `adapter_newer` when its SDK checksum is the
   installed (pending) release's, read from `gateway-sdk/build.json` in that release's
   package; otherwise `adapter_older`. That receipt is not held to the running release's
   pins (patch, capabilities, revision, codex version, lockfiles): a release changes its
   SDK exactly when those change, so holding it to them would never find the new one. The
   reader checks the file as the runtime does (a regular file this user owns, not
   writable by others, at most 16 KiB, schema 1, this platform), takes `binarySha256` and
   does not hash the binary: the service that starts on that release verifies its SDK
   fully. A positive answer is kept per release; a receipt that cannot be read is read
   again at the next refusal.
3. **Urgent move.** A refused `adapter_newer` marks the pending release urgent. The
   supervisor then drops the 15 minute grace, tries the move every 10 seconds, and uses
   the quiet check with a quiet time of zero: no turn running in any engine and no
   background terminal, while a turn that ended seconds ago does not block it. Inference
   must still accept its own idle guard. A running turn is never stopped. The move is
   logged as `self_upgrade` with `mode: "skew"`. A refused SDK that is not the pending
   release's marks nothing urgent.
   Agents that run turns back to back may never be caught idle by a look every 10
   seconds, so while a release is urgent the host also looks at its engines, once a
   second, and tells the supervisor the moment no turn is running, no approval or input
   is pending and no chat keeps a background terminal, once per such gap. The supervisor
   then tries the move at once, through the same quiet check and inference guard. The
   look is cheap by design: one short admin connection per engine, a `thread/read` status
   per loaded chat (an `active` status covers a running turn and one waiting for an
   approval or input) and, only when no chat is active, its background terminals. It never
   asks for a turn list, so it never replays a chat's saved history, and it ends at the
   first chat that is busy. A look blocked by a background terminal, an unreadable chat or
   more than 256 chats backs off (1 s, doubling up to the 10 second tick) and returns to
   one second when a gap appears. Each look first checks that the release is still the
   pending one: after a rollback or a newer install the urgency is dropped, and the look
   stops until another refusal. The 10 second tick stays as the backstop.
   The host also does not stop a turn: it cannot hold one back, because turns start on
   engine sockets, not through the host. The quiet check reads every chat, then looks
   once more at every engine's chat statuses right before it closes the gate, which
   leaves a window of a few milliseconds. A turn that starts inside it can still be cut
   when the service stops, as at any service restart, and continues from saved history
   after a resume.
4. **The reverse case.** Once the service has moved, an adapter of the older release
   that asks for a generation gets the `adapter_older` message above, recorded as
   `adapter_older`. Nothing else changes: that adapter moves when the app restarts.

## Per-chat rollout: newer adapters run on the installed release's SDK

Since 1.5.2 an older service no longer refuses an adapter of the installed release.
When a generation request names the installed (pending) release's gateway SDK, as
read from that release's `gateway-sdk/build.json`, the host imports that release's own
`dist/gateway-sdk-runtime.js` and lets it verify its SDK. The rules match the live
supervisor loader: only a regular, owned file inside the release `current` names. The
host spawns the generation on that SDK only when the verified checksum equals both the
receipt and the descriptor. It holds a retention lease on that release for as long as
the engine runs, so the installer cannot prune it. The move is logged as
`execution_generation_forward` with `to`, the release. A verifier that is missing,
fails or answers with another SDK leaves the release skew refusal below unchanged.

Forwarding also requires that both releases prepare an engine compatibly. From 1.5.7 a
release ships a **forward contract** module (`dist/forward-preparation.js`, source
`src/forward-preparation.ts`): its engine-home writer and spawn-argument trim, cut to its
own feature schema. An older host imports that module from the installed release and uses
it whenever its `forwardContract` number equals the host's own, so a release can change any
preparation code or schema without an older host refusing it. Everything imported from the installed
release (the SDK verifier, the contract module and all they import, in any syntax,
including JSON, `.mjs`, CommonJS and packages) passes through Node's resolver hook
(`src/foreign-release-loader.ts`) before it runs: it may resolve only to a builtin or to a
regular file inside that release's `package/` that you own, with one link, no symlink and
no folder others can write. Anything else fails the import, and forwarding falls back as
for a release without the module. Bump `forwardContract` only
when the shape or meaning of `forwardPreparation` changes. An installed release without
the module, or with another number, is forwarded only under the earlier rule: its
preparation code (`preparationFiles` in `src/installed-release-runtime.ts`) must be
byte-identical to the host's; the schema data may differ (since 1.5.7) and its own modules
read it. Its SDK must also match the host's Code Mode support, because the descriptor's
tools were normalized against it. A release that fails these keeps the refusal and moves
under the rules above.

Before 1.5.7 any schema data change, which every Codex SDK update brings, kept newer
adapters refused, and on a Mac whose agents never leave a second with no turn running
unloaded chats stayed unopenable until a forced restart (3 Nov 2026, 1.5.4 to 1.5.6).
Three guards keep that from recurring: the pre-publish forward check
([releasing](RELEASING.md)) refuses to publish a release the deployed one would refuse;
`gateway rollout` reports `blocked: release_skew` and `gateway health` fails while chats
are being refused ([rollout](rollout.md), [health](health.md)); and
`gateway service restart --interrupt` restarts at once, ending running turns, when nothing
else can. These checks only work once 1.5.7 is the release that is already running,
because the older host's own code decides whether to forward. Trim counts of a forwarded
engine are not recorded, because the imported modules run without this host's telemetry.
A forwarded generation keeps its engine home in
`desktop-generations/shared-v1-<revision>-forward-<release>`. The service that later
moves to that release starts the same revision in the ordinary folder, with a
configuration it writes itself.

Chats then move one at a time, without a restart:

```text
service on release N (unchanged, keeps running)
 ├─ generation on SDK N     chats already loaded here stay until they unload
 └─ generation on SDK N+1   new chats, and chats resumed after unloading
 old generation with no loaded chat and no adapter lease → retired by maintenance
```

`execution/find` still attaches a loaded chat to the engine that holds it, whatever
its release, so a running or viewed chat is never moved or cut. The service moves to
the new release later, under the idle and quiet rules above; until then nothing waits
on it. Code Mode normalization still follows the host's own SDK, so a release that
changes Code Mode availability takes effect for new generations only after the
service moves.

## An app update while the service runs

The service selects its gateway SDK once, at start. When the installed GateFox.app carries a signed derivative of the release's SDK, the service selects that
signed executable; otherwise it selects the release's own `gateway-sdk/gateway-codex`.
Every new generation re-verifies that selection and accepts either form of the same SDK:
the same release hash, and the signed executable's receipt naming the executable the
service started on (or the reverse).

On 2026-11-03 a service started while the app was one release behind, so it selected the
plain SDK. The app then updated and brought a signed derivative of that very SDK. The
re-verification accepted only a move from signed to plain, not from plain to signed, so
every new chat and every chat needing a new generation failed with the masked refusal
below until the service restarted, while chats on generations already running kept
working. Both directions are accepted now; a signed SDK built from another original is
still refused.

## Masked execution failures

The host passes a fixed list of its own refusals through unchanged (release skew, a
quiescing or closing host, generation limits, native ownership). Any other error may
carry a path or a value, so the adapter is told only "Execution operation failed
(`reason`); managed chat ownership was preserved", where `reason` is the fixed class
`execution_host_failed` also uses (`sdk_invalid`, `identity_changed`, `io_error`, …).
The host records the same class with the method as `execution_request_failed`
([diagnostics](diagnostics.md)). Earlier releases showed the text without a class
and recorded nothing, so the cause was visible nowhere.

## Automatic model selection maintenance

The optional [automatic latest models](auto-latest-models.md) setting runs a
five-minute metadata timer inside the existing app-owned service tree. There is
still exactly one gateway LaunchAgent and one signed app identity with its icon.
The inference runtime owns the timer, or the existing supervisor owns it for a
client-only plan with no inference child. Stopping or replacing that runtime
cancels its maintenance. A fresh PID/start-identity heartbeat, not a historical
successful check, proves that automatic checks are available.

Migration removes only a verified legacy
`com.edihasaj.harness-gateway.models-<path-hash>` job from 0.8.7. Toggling the
policy never registers another job, changes the parent app registration or
restarts active chats. macOS may temporarily retain a historical Login Items row;
do not reset the global background-task database to hide it.
