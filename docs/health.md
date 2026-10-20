---
summary: 'The watchdog: `gateway health` verdicts, alert pushes, scheduled runs, and the compatibility smoke.'
read_when:
  - Investigating a Discord alert from a gateway push monitor
  - Changing what the watchdog checks, when it pushes, or how it schedules
---

# Health watchdog

`gateway health` answers one question for a single Mac: did the ChatGPT app move
under the gateway, and did anything break when it did? It runs entirely on the
local machine. The only network calls are the loopback inference probe and, with
`--push`, the one heartbeat to the alert monitor. The compatibility smoke adds
none of its own: its mock upstream is on loopback, and its engine config sets
`features.plugins = false`, which stops the app engine from cloning
`github.com/openai/plugins` into its private home (checked against engine
0.163: without the key `git ls-remote` and `git fetch` run within seconds of
start, with it none do).

```sh
gateway health [--json] [--push] [--smoke]
```

Exit codes: `0` is `ok`, `1` is `warn`, `2` is `fail` (and the same `2` means the
monitor URL was refused or no gateway configuration could be read), and `3`
means the verdict was computed but the monitor never took it. `--json` prints
the same verdict as one machine-readable object.

## What it checks

| Section | Question | Verdict moves |
| --- | --- | --- |
| app | The bundled Codex engine (`--version` of the signed `CodexCLI.app` binary) and the app's `CFBundleShortVersionString`, compared with the last pair seen. | A change is recorded as info and triggers the smoke; a missing app is info, never a failure. |
| components | `gateway versions`: every role still running an older release. | A service still running any older release after one hour fails, including a patch update. Other components more than one minor behind for over 48 hours fail; a loaded chat engine can retain its original release. The clock starts when `current` was switched (the link's own mtime), not when the process started. A newer service during rollback does not count as older. |
| service | The unified service snapshot: component states, execution-host state, and host restarts in the last 15 minutes of telemetry. | A failed host fails; a non-running component warns, except a `paused` native relay, which is info. |
| inference | `GET http://127.0.0.1:<port>/health` from the configured port. | Anything not serving, a non-200 answer, or a release header that is not the installed one moves the verdict. A server that answers but holds back a change to `gateway.json` adds `configRejected` (one of `rebind`, `restart_required`, `invalid`, `unreadable`) to its answer, and the check warns "gateway.json change not applied (reason); fix it or restart the service" for as long as the file stays refused; any other value is ignored, see [live configuration](architecture.md#live-configuration). `clientOnly` configs report the section as remote. |
| errors | The local telemetry window (today's and yesterday's JSONL, fixed fields, counts only): session-method refusals, config retries followed by a refusal, and component exits. | A refusal fails only when three or more are each under 5 minutes old and after the last recovery; a refusal that has stopped warns with the time it stopped (UTC). A config retry that still ends in an ongoing refusal fails; exits warn unless a restart explains them. See [what is wrong now](#what-is-wrong-now). |
| desktop | The ChatGPT process tree, when `<state>/desktop-registration.json` names a wrapper. | ChatGPT running on its stock engine warns; ChatGPT not running is info. See [the stock engine](#the-stock-engine). |
| smoke | The packaged compatibility check against the installed release and the app's engine. | A failing check fails; a check that cannot run warns. |

Findings use a fixed vocabulary of phrases plus counts and versions. Reports
never carry paths, command arguments, or error text. Anything that reaches one
from outside — an `X-Gateway-Release` header, an inference body status, a phase
name from the check or from the state file — has to look like a version token or
a phase slug first, and is named `unknown` rather than quoted if it does not.

A section that cannot be read says so once, as a warning (`versions unreadable`,
`telemetry unreadable`, `inference unreadable`), and the rest of the run
continues, push included. A watchdog that could not run `ps` is degraded, not
broken, and it still has to answer.

## What is wrong now

The watchdog reports what is wrong now, not what was wrong somewhere in the last
15 minutes. A Mac that healed itself must not page for the rest of the window,
because `--push` turns a `fail` into a "down" on the alert monitor.

**Refusals.** A session refusal (`rpc_error` on `thread/start`, `thread/resume`,
`thread/fork` or `turn/start`) is *ongoing* when at least one happened in the
last 5 minutes and after the latest recovery marker. The markers are an
`execution_host_recovered` event, a `self_upgrade` of the `service` or the
`server`, and the start of the service process itself (read from the `service`
row of `gateway versions`, since the service logs no start event). Two guards
keep a marker from hiding a real outage: a recovered host is not a marker when
an `execution_host_failed` or `execution_host_restarted` follows it, so a host
that flaps cannot hold the verdict at warn; and the service's own start counts
only once the service has been up for 5 minutes, so a service that crashes and
restarts cannot keep resetting it. A refusal fails only when three or more are
each under 5 minutes old and after the marker; fewer warn. A refusal that is no
longer ongoing warns and says when it stopped:
`refused thread/resume 14x, none since 07:25 UTC`. A config retry followed by
a refusal fails only while the refusal is ongoing. Nothing about the counts in
`--json` changes: `errors.rpcErrors` and `errors.refusals` still cover the whole
window.

**Exits a restart explains.** A `component_exit` is not counted when it is within
15 seconds (either side) of a restart that explains it, matched by component:

| Event near the exit | Explains an exit of |
| --- | --- |
| `self_upgrade` of the `service` | any component (the whole service restarts) |
| `self_upgrade` of the `server` | `inference` |
| `server_drain` | `inference` |

An exit of the same kind far from any such event, or of a component the restart
does not touch (a tunnel next to a `server_drain`), still warns. Without this
every Mac warned `inference exited 1x` right after its own self-upgrade, which
was the idle restart itself.

### The stock engine

With an active desktop registration (the receipt has a `wrapper`) and ChatGPT
running, the watchdog reads `/bin/ps` (pid, ppid and command only) through the same
injectable command seam as the app check, and looks at ChatGPT's direct children:

| Child of `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT` | Meaning |
| --- | --- |
| `<install>/current/runtime/bin/node <install>/current/package/dist/cli.js codex-shim ...` | The app runs on the gateway. Nothing is reported. |
| `.../CodexCLI.app/Contents/MacOS/codex ... app-server` | The app runs on its own engine. Warns: "ChatGPT started before the gateway (for example right after a reboot); quit and reopen ChatGPT to use gateway chats". |
| `Codex (Service)`, `Codex (Renderer)`, `codex ... exec-server` | Ignored. |

ChatGPT not running is reported as info (`ChatGPT not running`), and a Mac with
no registration is not checked at all. No process's environment is ever read.

### Verdict mapping

| Situation | Finding | Verdict |
| --- | --- | --- |
| 3+ refusals, each under 5 minutes old and after the last marker | `refused <method> Nx` | fail (exit 2) |
| 1-2 refusals under 5 minutes old and after the last marker | `refused <method> Nx` | warn (exit 1) |
| Refusals that stopped, or that a marker ended | `refused <method> Nx, none since HH:MM UTC` | warn |
| Exit explained by a restart | none | no change |
| Any other component exit | `<kind> exited Nx` | warn |
| Registered ChatGPT on the stock engine | the sentence above | warn |
| Registered, ChatGPT not running | `ChatGPT not running` | ok (info) |

Exit codes are unchanged: `0` ok, `1` warn, `2` fail, `3` push not taken.

## The compatibility smoke

When the app pair changes (or `--smoke` forces it), the watchdog runs
`scripts/e2e-fast-mode.mjs --gateway <installed bin> --package <package root>
--codex <app engine> --transports stdio --root <private directory>`. The child
sees only `PATH`, `HOME`, `TMPDIR` and `LANG`, and its output is discarded apart
from the last JSON line's `failedPhase` name on failure.

The check keeps its own state out of the real home. Every child it starts (the
gateway, the executor host, the Codex shim and the engine) runs with `HOME` set
to a private `home` folder (0700) inside its `/tmp/gw-fast-*` run folder, so the
execution-host homes under `~/.local/state/gw-exec`, the relay and SSH control
homes (`gw-native`, `gw-ssh`) and the default `~/.codex` all resolve inside the
run folder and leave with it. The fixture still passes its own `CODEX_HOME` to
the children that take one. The one path it cannot move is the pinned engine's
socket folder, `/tmp/codex-daemon-<uid>`, which the engine fixes itself and the
live gateway shares. When the run ends, the check removes there only the sockets
and lock files whose names come from socket paths inside its own private home,
and only when nothing is listening on them.

Stopping it is a sequence, not a signal. The check starts its gateway, executor
and engine in process groups of their own, so after the 10-minute timeout the
watchdog sends SIGTERM to the check's group and gives it 15 seconds to take its
own children down; only a group that ignores the ask gets SIGKILL, and once the
check has closed the group is swept with SIGKILL for anything it left behind.
The check handles SIGTERM and SIGINT the same way it handles the end of its own
run: its handlers are installed before it creates anything, it spawns nothing
once teardown has begun, and it stops each child's whole process group (SIGTERM,
three seconds, then SIGKILL, and a sweep after the child closes) until none is
left, so the engine's own helpers and the `/tmp/gw-fast-*` folder leave with it.
A failure names the step it stopped in (`serve`, `catalog`, `stdio-host`,
`stdio-open`, `stdio-catalog`, or the check's own phases). Stopping the
service aborts a check that is still running through the same sequence, which is
why a shutdown does not wait for a ten-minute run.

The run folder lives under `<state>/health/smoke-<timestamp>` (0700) and is
removed afterwards. The answer is stored against the app pair, so a quiet tick
repeats the recorded answer instead of paying ten minutes again — including a
recorded failure, which stays in every report for that pair until the app moves
or `--smoke` runs the check again. A missing script or missing installed release
reads as `unavailable` and warns.

## State file

`<state>/health-state.json` (0600) holds exactly two records: the last app
bundle/engine pair seen, and the last smoke answer with the pair it was earned
against. Deleting it costs one re-run of the smoke; nothing else reads it.

## The alert push

`--push` sends the verdict to one Uptime Kuma push monitor (which routes to
Discord). The monitor URL lives only in `<state>/alert-push-url`. That file must
be a regular file owned by the current user with no group or other permission
bits (`0600`); anything wider is refused with exit `2` so a neighbour cannot
read or flip the alert switch. The URL is never printed, logged, or repeated in
an error: failures map to `timeout`, `http_<status>`, or `network`, and the
watchdog sends one heartbeat per run rather than retrying in a loop.

The request is `GET <url>?status=up|down&msg=<summary>&ping=` with a 10-second
timeout. The three keys are set on the URL that was read from the file, not
appended to it: a URL pasted out of Uptime Kuma already ends in
`?status=up&msg=OK&ping=`, and a second copy of each would leave the monitor
showing `OK` forever. `ok` and `warn` send `up` (the message names the warn), and
only `fail` sends `down`. The message is `gateway <verdict>` plus as many finding
phrases as 200 characters allow.

A file the watchdog will not read — wider than `0600`, not a regular file, owned
by someone else, a link, or a URL that is not http(s) with a host — is refused as
`insecure`: the finding `alert push url not private`, the same words once on
stderr, and exit `2`. The alert path being broken is a failure even when the Mac
itself is quiet, and neither message repeats the path or what was in it.

## Schedule

The unified service supervisor calls `startHealthSchedule` from
`src/health-schedule.ts`, which runs the health checks and their push in-process
every 10 minutes: the first tick waits a full interval, ticks never overlap, and
an unref'd timer keeps the service free to exit. The schedule stands down while
`alert-push-url` does not exist, so a Mac without a monitor URL never pays for
the checks. Its stop function also aborts the tick it started: a compatibility
check that is still running is stopped, with its process group, rather than
being left to finish. No LaunchAgent alternative is provided.

Related: [diagnostics](diagnostics.md) for the telemetry the error rates read,
and [RELEASING.md](RELEASING.md) for the post-install gate.
