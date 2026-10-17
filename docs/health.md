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
| components | `gateway versions`: every role still running an older release. | A lag is a warning; the same component more than one minor behind for over 48 hours fails. The clock starts when `current` was switched (the link's own mtime), not when the process started, and a different major always counts as more than one minor behind. |
| service | The unified service snapshot: component states, execution-host state, and host restarts in the last 15 minutes of telemetry. | A failed host fails; a non-running component warns, except a `paused` native relay, which is info. |
| inference | `GET http://127.0.0.1:<port>/health` from the configured port. | Anything not serving, a non-200 answer, or a release header that is not the installed one moves the verdict. `clientOnly` configs report the section as remote. |
| errors | The local telemetry window (today's and yesterday's JSONL, fixed fields, counts only): session-method refusals, config retries followed by a refusal, and component exits. | One or two refusals in fifteen minutes warn; three or more fail. A config retry that still ends in a refusal fails; exits warn. |
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
