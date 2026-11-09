---
summary: "Interpret the private usage ledger, real loaded release versions and scrubbed exception reports."
read_when:
  - Investigating usage ledger and loaded releases
---

# Usage ledger and loaded releases

Return to the [diagnostics overview](diagnostics.md).

## Usage ledger

The gateway also appends one content-free row per finished request to
`<state>/usage/usage-YYYY-MM.jsonl` (UTC month). The directory is mode 0700 and the
files 0600. The current month and the previous 12 are kept; older files are removed
on the first write and whenever the month changes. Set `GATEWAY_USAGE_LEDGER=off` to
disable it: nothing is created, imported or marked. It is independent of
`GATEWAY_TELEMETRY`.

A row holds only `v`, `at`, `host`, `requestId`, `responseId` (marked responses
only), `provider`, `providerType`, `model`, `status` (`completed`, `empty` or
`failed`), `origin` (`gateway`, or `telemetry` for imported rows), `session`
(imported rows only), `inputTokens` (gross, including cached), `cachedTokens`,
`cacheWriteTokens`, `outputTokens`, `reasoningTokens`, `nanoAiu` and `nanoAiuStatus`.
`nanoAiu` is Copilot's credit amount in billionths of a credit; `null` means none
was reported, which is not zero. `nanoAiuStatus` is present on every Copilot row that
has usage: `complete` when every model call of the request was priced, `partial` when
only some were priced or Copilot itself called a figure partial (the amount is then a
floor), and `unavailable` when none was. A request that fails after a provider reported
usage keeps that usage, and so does a request whose caller disconnected after the
provider reported it, so a Copilot call that is billed and then rejected or abandoned
still shows up. When a request stops early (the caller left, it was cancelled or timed
out, or the gateway is shutting down), even while the gateway waits for a slow client to
take earlier output, the server reads the provider on for up to 3 seconds, for usage
only, so usage the provider received before the stop is not lost. At shutdown the
server waits for those requests to write their rows before it flushes telemetry and the
ledger, but a stopping process leaves 1.5 seconds after the drain deadline at the
latest. Before it leaves, it records every request still running as `failed` (a ledger
row and a `request_failed` event with `abortCause` `shutdown`) with the usage received so
far, and then flushes both, so usage that arrives later than that is not recorded but
usage already received is.
A row with no tokens and no credit amount is not written.

Never stored: prompts, instructions, messages, tool names, arguments or outputs,
images, thread, session or turn ids, account ids, credentials, error text or
environment values.

**Marker.** For `copilot-subscription` and `claude-subscription` routes, while the
ledger is on, the Responses id is `resp_gl_<request id without dashes>` instead of a
random `resp_<hex>`. Codex records that id in its own rollout, so a spend tool counts
a gateway request once, from the ledger, and skips the matching Codex record. A
Messages request on those routes gets the message id `msg_gl_<request id without
dashes>` instead of a random `msg_<hex>`, and its row records that id. Claude Code
records that `msg_gl_` id in its transcripts, so a spend tool that dedupes transcript
records by id sees the same id the ledger holds. A consumer must accept both
prefixes (`resp_gl_` and `msg_gl_`; the `gatewayMarkerPrefixes` list in
`src/usage-ledger.ts`), not only `resp_gl_`, or it counts Messages requests twice.

**Telemetry import.** The first time the ledger is prepared, and
`<state>/usage/telemetry-import.json` is absent, each `request_*` telemetry event with
input or output tokens becomes one `origin: "telemetry"` row (no response id), and the
marker file records the count. This keeps request history that telemetry would drop
after its 14 days. An imported row keeps the cache-write, reasoning and credit figures
its event carries (`cacheWriteTokens`, `reasoningTokens`, `nanoAiu`, `nanoAiuStatus`);
an event from before those fields existed has none, so its row reads 0 for the token
figures and `null` for `nanoAiu`.
`providerType` is set only for providers in the current configuration. The import skips
every request this process records and any request already in the ledger, and writes in
one append per month, so a request is never counted twice; a reader also keeps one row
per request id and prefers the gateway's own row over an imported one.

`gateway diagnostics` also sums Copilot credits per model from `nanoAiu`.

## Running component releases

An install only moves the `current` link, so a process that started earlier
keeps running the release it loaded. Its command line can still say
`.../current/...`, which no longer identifies that code after an install.
Managed releases keep a read-only descriptor for their immutable CLI entrypoint
and release marker, so `lsof` can preserve that release during installer
cleanup even when the app-owned Node itself only names `current`. A hot-swapped
server retains each old marker only until that generation's requests drain.
`gateway versions [--json] [--check]` answers that question: it lists this
user's gateway processes, names each one's role (`service`, `inference`,
`desktop-adapter`, `ssh-listener`, `ssh-proxy`, `executor-host`,
`gateway-engine`, `native-relay`, `tunnel` or `other`) and reads the release
from mapped files found with `lsof`. For CLI roles, it reads all descriptors
for that same PID and accepts only one open immutable
`releases/V/package/dist/cli.js` entry beneath this install root. A floating
`current` launch path is never evidence: if the immutable CLI descriptor cannot
be read, the release is `unknown` unless the process was launched directly from
one unambiguous immutable release path. A release marker alone does not prove
the bootstrap release, because an older CLI can hot-load a newer server
generation and retain its marker. It rechecks the PID and its start time after
reading descriptors, dropping a row if that process exited or its PID was
reused during the scan. The report skips this process itself, so
running the command never adds a row.

For the service, `gateway health` instead uses the optional `runningRelease`
published by that service at startup. It accepts the release only when the status
names the live service PID and was published after that process started. This
keeps an older JavaScript service visible after an install even with an app-owned
Node. Older services without the field retain the inventory fallback until they
restart on a release that publishes it.

A command line is only read where the program sits: at argv[0], or at argv[1]
behind a node interpreter for the CLI script. A wrapper that merely mentions
one of our paths inside a quoted string
(`zsh -c node .../current/package/dist/cli.js serve`), a wrapper program such as
`/usr/bin/time` that starts node, another product's `releases/` folder, or one
of our paths used as an argument, runs none of ours and is left out. Short-lived
helper scripts a request starts (such as the Claude tool helper) are not listed. The install root is matched
both as written and with its links resolved, so a tree reached through a
symlink is still recognized.

The one exception is the inference process. A release that replaced itself in
place keeps the node runtime it started with mapped, so `lsof` names the
release it started from rather than the code it serves. There the health
endpoint answers instead, and its `X-Gateway-Release` header wins: the command
asks `lsof` which loopback ports the process listens on, and sends one
`GET http://127.0.0.1:PORT/health` with a two second timeout to each in turn,
lowest port first, until one answers. The port comes from the process's own listening socket,
never from its arguments, so a server started with a quoted configuration path
and no `--port` is still found. When nothing answers, the report falls back to
the mapped release. Those requests are the only thing here that leaves the
process, and they never leave the machine.

What is printed is limited to roles, pids, start times and release versions;
command arguments, paths and environment values are never shown. A release
that neither `lsof` nor the command line can name reads `unknown`, and a
process started from a source checkout reads `checkout`. The human form
prints the installed release, one row per process with its start time on the
local clock, then a summary: `all on RELEASE` or `N lagging: role@release`,
one mention per distinct pair.
`--json` prints the same data as
`{ installed, processes: [{ role, pid, startedAt, release }], lagging }`,
where `installed` is the release the `current` link points at and `startedAt`
is that start time as a UTC instant. A run from a checkout or worktree, which
has no `current` of its own, names the release the default install's link
points at, `~/.local/share/subscription-gateway`, and still calls its own
processes `checkout`. When neither link resolves, `installed` is null, which
`--json` always prints.

`--check` exits 1 when a process runs another release than the installed one,
or `unknown`, and 0 when none does. It exits 2 when there is no installed
release to compare against, because a run that names none cannot tell a lagging
process from an up to date one; the report itself is still printed. A flag
outside `--json` and `--check`, and a process list `ps` cannot read, exit 2
too; `--help` or `-h` prints the usage line and exits 0. See
[release](RELEASING.md#updating-without-quitting-the-app) for how long a
lagging process may legitimately take to move.

## Exception reports

Staged native executor adoption records `native_sharing_staged`,
`native_sharing_activated`, and `native_sharing_deferred`. Records carry only
fixed mode or reason codes. A deferral means the staged change was not applied
and the current service plan remains authoritative, for example because an old writer remained, the plan changed, or the
SDK could not be verified. It does not report a failed chat or authorize
replaying a turn. See [travel recovery](travel-recovery.md).

Only exceptions go to `errors.applifyer.com`, project `harness-gateway`. The DSN
is the 1Password item `GlitchTip DSN - harness-gateway` (vault `applifyer`) and
lives on each Mac in `<state>/glitchtip.dsn` (mode 0600, owned by the user); a
file other users can read is ignored. Without it nothing is sent.

| Source | Sent as |
| --- | --- |
| Uncaught exception or rejection in the server, adapter or service | `fatal`, written synchronously to `<state>/error-spool/` and sent by the next process start |
| Untyped provider failure (`provider_failed`), internal adapter RPC failure, adapter start failure, execution host start failure | `error`, sent in the background with a five-second timeout |
| A live Copilot session's own bookkeeping failing: `copilot_live_attach` (placing a request in its session raised something other than a provider failure; the request is served one-shot), `copilot_live_close` (closing a session or reporting its end failed), `copilot_live_abort` (ending a cancelled request failed) | `error`, sent in the background like the row above |

Typed provider and protocol failures (including malformed stream frames and
invalid historical tool arguments), cancellations and turn anomalies stay in the
local log. JSON parser messages are replaced with "JSON parse failed", because
they quote the text they failed on. Crash reports are written to a temporary file
and renamed, and a spool file that cannot be read is discarded. Events carry the exception type, a scrubbed message (credentials, long
secrets, home paths and URL paths removed) and file, function and line frames.
The machine is a hashed label; no user, request, environment, device or local
variables are sent. Repeats of one failure within ten minutes are dropped, and a
process sends at most 30 reports an hour. Set `GATEWAY_ERROR_REPORTS=off` to
disable reporting.
