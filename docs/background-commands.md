---
summary: 'Opt-in command completion receipts resume gateway agents without Goal mode.'
read_when:
  - Running finite background commands or watching an existing tmux job
  - Investigating a command that finishes after the agent ends its turn
  - Changing executor background completion delivery or stop behavior
---

# Background command completion

The gateway executor's interactive `exec_command` tool accepts
`notify_on_exit: true`. An agent can select it when the user wants the result of
a finite background command later. It works with every inference provider served
by that executor, including Claude, and does not require Goal mode.

```text
exec_command(cmd, notify_on_exit: true)
  → running session ID returned
  → agent may finish its first reply
  → process exits and its output settles
  → executor queues a runtime completion receipt
  → current turn settles
  → ordinary follow-up turn on the chat's current model and permissions
```

The option defaults to false. A command that finishes during its initial call
returns its result normally and creates no completion turn. The receipt contains
the session ID, original tool call ID and exit code. It is hidden runtime context,
not a new user instruction or authorization. The agent can read retained output
with `write_stdin` and verify the requested result. A process exiting successfully
does not by itself prove that the user's entire objective is complete.

For existing tmux work, start a tracked command that waits for that specific job
to finish and request notification on that command. Detaching a tmux process
alone does not register it with the executor. Dev servers and other indefinite
processes should keep the default unless the user wants an exit notification.

## Lifecycle and permissions

The existing process watcher publishes at most one receipt after the initial
tool call returns a running session and the final command event is emitted.
Receipts use a bounded queue inside the existing executor. The input loop gives
caller operations priority and starts a follow-up only through the existing
automatic queued-turn admission. It waits while another turn is running or
finishing, and does not interrupt another task. It does not poll inference.

Stopping the chat cancels its outstanding registrations, including while idle.
Stopping a terminal, sending Ctrl-C, or clearing background terminals cancels
the affected pending notifications. Reading a terminal's completed result also
cancels a receipt that has not yet been delivered. A completion already admitted
as a turn follows the usual turn interruption behavior.

Plan mode, an interrupted or failed agent, and host drain prevent an automatic
start. Receipts do not change model selection, thread settings, sandbox policy,
approvals, tool policy or task scope. Turn-only permission grants are not copied
from the original command into the follow-up. Normal approval requests can still
pause further work.

This is an executor capability, implemented by
`scripts/patches/gateway-background-completion.patch`. The HTTP inference gateway
does not execute tools or schedule turns. No LaunchAgent, cron job, app scheduler,
provider-native tool execution or signed native-engine modification is added.
API mode and other clients retain their own runtime's background-task behavior.
Pending registrations live with the executor; they do not survive its shutdown
or machine reboot. The command must run on a host that remains available.

## Verification

The SDK build gate includes eight regressions for opt-in delivery, duplicate
suppression, stop generations, runtime provenance, Plan mode, interruption and
the finishing boundary. Run the real executor against isolated loopback mocks:

```sh
npm run build
node scripts/e2e-background-completion.mjs \
  --gateway /absolute/path/to/patched/gateway-codex \
  --control /absolute/path/to/unpatched/gateway-codex \
  --catalog /absolute/path/to/models_cache.json \
  --root /tmp/task-specific-background-evidence
```

The fixture checks a successful exit, a nonzero exit, default behavior, a short
command, chat interruption, terminal cleanup, individual termination and an
unpatched control. It also checks stop followed by an explicit user continuation,
and a model change with updated sandbox and approval settings. Positive cases
traverse both Responses and Anthropic Messages
translation through the HTTP gateway and read the final command output. It uses
private homes and synthetic model responses, creates no goals and sends no
paid inference. A passing fixture proves executor delivery, not live provider
behavior, desktop notifications, or a managed release rollout. A release must
rebuild the SDK because the authenticated patch digest changes.

The [2026-11-02 development receipt](evidence/background-completion-2026-11-02.json)
records 33 passing SDK regressions and all 12 real-executor mock scenarios. The
full Gateway test suite, build and typecheck passed. Independent review found
and verified a fix for approval and conditional interruption paths. This was a
development executable; no release was published or installed.

See [client tools](client-tool-reachability.md), [activity](activity.md) and
[provider updates](provider-updates.md).
