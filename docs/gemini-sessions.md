---
summary: 'Google AI Ultra subscription inference through the official Gemini CLI: one live ACP session per conversation, a private Gemini home, managed settings, tool handoff and the fail-closed checks around each.'
read_when:
  - Changing the gemini-subscription provider, its live sessions or its Gemini home
  - Turning geminiSessions on or off, or investigating a refused Gemini conversation
  - Signing the gateway in to Google, or investigating a failed Gemini request
---

# Gemini subscription

A `gemini-subscription` provider spends a Google AI Ultra subscription through the
official Gemini CLI (`gemini`). API keys are never used: every `GEMINI_*`, `GOOGLE_*`,
`VERTEX*` and `OTEL_*` variable is removed from the CLI's environment before it starts,
and the CLI signs in once into the gateway's own private home. Model choices are never
changed automatically.

The session mechanics are shared with [Grok sessions](grok-sessions.md): one long-lived
CLI process per conversation, ACP over stdio, caller tools as held calls on a loopback
MCP endpoint, and refusal rather than replay. This page covers what is specific to the
Gemini CLI, and the two places where it is stricter than Grok.

```
Codex ──request──▶ gateway ──ACP (ndjson over stdio)──▶ gemini --acp -m <model>
                      │  ▲                                    │ MCP over loopback HTTP
                      │  └── tools/call held open ◀───────────┘ http://127.0.0.1:<port>/mcp/<token>
                      └─ yields {tool call, done}; next request answers the held call
```

## Why the environment is the first line of defence

Two findings from probing CLI 0.70.0 drive most of this provider's design:

- **An ambient `GEMINI_API_KEY` silently wins.** With the inherited environment the CLI
  answered a `session/new` using API-key billing; with a clean environment the same call
  failed with "Gemini API key is missing or not configured." ADC
  (`GOOGLE_APPLICATION_CREDENTIALS`), `GOOGLE_GENAI_USE_*`, `GOOGLE_GEMINI_BASE_URL`,
  `GOOGLE_CLOUD_ACCESS_TOKEN`, `GEMINI_CLI_AUTH_OVERRIDE` and `GEMINI_MODEL` do the same
  kind of silent substitution. So `geminiEnv` deletes every `GEMINI_*`, `GOOGLE_*`,
  `VERTEX*` and `OTEL_*` variable and the few outside those families that still change
  what the CLI is (`CLOUD_SHELL`, `SANDBOX`, `VITEST`, `NO_BROWSER`, and the variables that make
  it skip the browser: `CI`, `DEBIAN_FRONTEND`, `BROWSER`, `SSH_CONNECTION`), then sets only the
  five it owns.
- **Credentials go to the macOS keychain unless told otherwise.** `GEMINI_FORCE_FILE_STORAGE=true`
  keeps the sign-in in `<home>/.gemini/oauth_creds.json` (mode 0600) instead of the
  keychain. `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` must stay **unset**: when set, the CLI
  imports and deletes `oauth_creds.json` and moves the credential to the keychain.

`GEMINI_CLI_SYSTEM_SETTINGS_PATH` and `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` both point at
names **the gateway never creates** inside the home, which closes the machine-wide scope
rather than competing with it. System settings outrank the home's own `settings.json` and
system defaults outrank those, so a `/Library/Application Support/GeminiCli` document could
reopen anything the managed document closes; each variable replaces its path outright, so
naming an absent file leaves that scope with nothing to load. (A file that *does* exist is
also refused unless root owns it, which nothing inside this home can be.) What remains is
`<home>/.gemini/settings.json` — the user scope, rewritten before every spawn — as the only
settings document the CLI acts on. `GEMINI_CLI_NO_RELAUNCH=true` keeps one process, so one SIGKILL to the
process group ends the CLI and anything it started.

## Live sessions

`geminiSessions` is optional and validated exactly like `grokSessions`:

```json
{ "id": "gemini", "type": "gemini-subscription", "geminiSessions": { "mode": "live", "max": 4, "parkMinutes": 30, "toolWaitMinutes": 25 } }
```

| Field | Range | Default | Meaning |
|---|---|---|---|
| `mode` | `live`, `oneshot` | `live` | `oneshot` is refused: the Gemini CLI has no standalone transport here |
| `max` | 1–16 | 4 | Live conversations at once. A newcomer past the cap is refused (`capacity`); no session is evicted |
| `parkMinutes` | 5–240 | 30 | A session idle after a finished turn is closed |
| `toolWaitMinutes` | 1–25 | 25 | A session waiting for tool outputs is closed (never longer than `parkMinutes`) |

**Process.** `gemini --acp -m <model>`, started in a private 0700 scratch folder which is
also the `session/new` `cwd` — the CLI creates storage for both its boot `cwd` and the
session `cwd`, so a mismatch would make the gateway's own repository a "project" in that
home. Each process also gets its own disposable `GEMINI_CLI_HOME` inside that folder (see
[Transcripts](#transcripts-never-reach-the-persistent-home)). The gateway speaks ACP: `initialize` (advertising `clientCapabilities` fs/terminal
off), `session/new` with exactly one `http` MCP server named `gateway`, `session/prompt`,
and it answers every agent request itself; anything but a permission request gets
JSON-RPC `-32601`. `notifications/initialized` is never sent (the CLI rejects it), and the
CLI implements no ACP extension methods, so no method prefix has an excusable
`params: null`. No approval, yolo or auto-approve flag is ever passed. There is no
reasoning-effort flag, so effort travels in the caller's own instructions.

**Requests with no conversation id.** A request that carries neither a thread nor a
session id has no conversation to come back to, so it follows Grok's one-shot rule: it is
served by a fresh process, and that session is closed as soon as its turn completes. It is
never parked and never counts against `max` afterwards, so any number of anonymous text
requests in a row succeed. A turn that ends in tool calls still hands them to the client,
but the continuation (the same history plus the tool outputs, again with no id) cannot be
joined to anything: it is a new, unnamed conversation with history, and is refused before a
CLI starts as `session_continuity_unavailable` / `session_missing`. The alternative, refusing
anonymous requests that offer tools up front, was rejected because it would also refuse the
many requests that offer tools and never use them.

**System prompt.** The CLI has no system-prompt field on `session/new`. The gateway's
instructions — its own system text plus the caller's leading instructions — are written to
a 0600 file in the session folder and named by `GEMINI_SYSTEM_MD`. One process per
conversation means the file is written once and stays immutable, which is what the CLI
requires: it re-reads that file on every prompt turn.

**Models.** Selection comes from `-m`, which the gateway always passes; `GEMINI_MODEL` is
stripped and `model.name` is pinned in the managed settings, so the CLI never routes a pro
versus flash turn on its own. A text-only catalog for an Ultra subscription:

```json
{ "id": "gemini", "type": "gemini-subscription", "label": "Gemini",
  "models": { "gemini/gemini-3.8-flash": "gemini-3.8-flash" },
  "modelMetadata": { "gemini/gemini-3.8-flash": { "displayName": "Gemini 3.8 Flash", "contextWindow": 1048576, "inputModalities": ["text"] } } }
```

`gemini/gemini-3.1-pro-preview`, `gemini/gemini-3-pro-preview`, `gemini/gemini-2.5-pro`,
`gemini/gemini-3.8-flash`, `gemini/gemini-3.5-flash`, `gemini/gemini-3.5-flash-lite` and
`gemini/gemini-3-flash-preview` are the expected Ultra ids at 1,048,576 tokens. Do not
configure `gemini-3.1-pro-preview-customtools`: that id is offered only for API-key
auth. Availability is entitlement-gated, so re-check the list against the CLI after a real
Ultra login. Images are refused before any CLI starts (`promptCapabilities` advertises
them, but the gateway accepts text only).

## Tools: the CLI is an inference backend only

There is no single "disable all tools" switch, and two mechanisms are needed because they do
different jobs.

`geminiManagedPolicy()` writes `<home>/.gemini/policies/gateway.toml`, which the CLI loads at
its **user** tier — above workspace, extension and the bundled defaults. A rule's rank is
tier + `priority`/1000 and the highest matching rule decides, so this file is the only thing
that outranks the CLI's bundled default policies, which allow `read_file`, `glob`,
`grep_search`, `list_directory`, `google_web_search`, `codebase_investigator`, `cli_help`,
`get_internal_docs` and the tracker tools **with no permission request at all**, and let
`agents.toml` allow `invoke_agent`. It holds three rules: `mcp_gateway_*` → `ask_user`
(priority 999), the built-ins by name → `deny` (900), and `*` → `deny` (800). The ask rule
must outrank the denies, because a deny-all on its own would swallow the caller's tools too —
the CLI names one `mcp_gateway_<tool>`. Nothing here ever answers `allow`; the gateway's own
permission reply is the only thing that lets a tool run.

`tools.exclude` names the same built-ins (`geminiBuiltInTools`) and is not redundant: an
excluded tool is also dropped from the CLI's registry (`isActiveTool`), so the model is never
offered it, where a `deny` rule alone would still advertise it.

- `tools.core: []` is **not** usable as a shortcut: its wildcard `DENY` also matches
  `mcp_gateway_*` and would kill the caller's own tools.
- `mcpServers` is `{}` and `mcp.serverCommand` is absent — `session/new` **merges** the
  settings' servers with the caller's, and a stdio entry would let the CLI spawn a process.
- `mcp.allowed` and `--allowed-mcp-server-names` are deliberately **unset**. Both generate
  an `ALLOW` policy rule for `mcp_gateway_*`, which would run every caller tool with no
  `session/request_permission`; leaving them alone is what keeps Grok parity and defence in
  depth. Same for `mcpServers[*].trust`.
- `security.disableAlwaysAllow`, `disableYoloMode`, `enablePermanentToolApproval: false`
  and `admin.secureModeEnabled` remove always-allow and YOLO.
- Telemetry, usage statistics, auto-update, checkpointing, worktrees (a startup
  `git rev-parse`), extensions, skills, hooks, IDE, agents, memory and `discoveryMaxDirs`
  are all off, and `advanced.ignoreLocalEnv` is true.

### Transcripts never reach the persistent home

The CLI records every conversation: `ChatRecordingService` is constructed unconditionally and writes
`<home>/.gemini/tmp/<project>/chats/session-*.jsonl` with the full prompt text, plus
`<home>/.gemini/history/`, and 0.70.0 has no setting, flag or environment variable that turns
that off (`general.sessionRetention.enabled: false` only stops it *cleaning up* old files). So
the persistent Gemini home never runs the CLI. Each live process gets its own disposable home,
`<session folder>/home`, a 0700 directory holding only:

- the managed `settings.json` and `policies/gateway.toml` (0600), written fresh;
- a 0600 copy of `oauth_creds.json`, and `google_accounts.json` when it exists.

When the session ends the process is killed first, then the credential is carried back if it
changed (the CLI refreshes its access token while it runs) and the whole folder is deleted, so
the transcript dies with the session. The copy-back runs under the same cross-process lock as
the other private files (`withPrivateFileLock` on `oauth_creds.json`), writes atomically at
0600, and is deliberately cautious:

| Case | Result |
|---|---|
| Credential unchanged | Nothing is written |
| Credential refreshed and the persistent copy is still what was handed out | Copied back |
| Persistent copy changed meanwhile (a newer sign-in, another session's refresh) | The persistent copy wins |
| Disposable copy no longer has both tokens | Never replaces a good credential |

A gateway that exits (`process.exit`, including during startup or a sign-in) is covered by a
synchronous exit hook (`src/providers/exit-cleanup.ts`). Each session and each sign-in registers it the
moment it acquires something, not when startup finishes: first the scratch folder, then the CLI's
process group. At exit the group is killed and the folder (with the copied credential) is removed;
the copy-back is skipped, which only loses a refresh the next request repeats. A gateway that was
killed outright (SIGKILL, a crash) runs no hook, so every scratch root records its owner
(`owner.json`: pid, boot id, process start) and the first session or sign-in of the next gateway
run removes `gateway-gemini-live-*` and `gateway-gemini-login-*` roots whose owner is gone, from an
earlier boot, or a reused pid. The sweep never touches a root with no owner record or a live owner, and
removes folders only: an orphaned ACP CLI ends when its stdin closes, and a sign-in CLI gives up after its own five minutes.
The persistent home receives `tmp/` or `history/`
from no inference path; `src/tests/gemini-home-isolation.test.ts` fails if it ever does. The
persistent home's own `settings.json` and `policies/gateway.toml` are still written, but only as
a managed reference: the CLI reads the per-session copies.

### The CLI never opens a browser during inference

With `selectedType: oauth-personal` and a credential the CLI cannot refresh (revoked or
expired beyond use), the CLI's boot calls `refreshAuth` **before** it answers `initialize`,
falls into its browser sign-in and opens a tab. A missing `refresh_token` is caught before
anything starts (a 401, below), but a revoked one only fails inside the CLI. Findings from
0.70.0 that decide the mechanism:

- `NO_BROWSER` is unusable: ACP counts as interactive, so the CLI would print an alternate
  screen and a code prompt on stdout and **read the code from stdin, the protocol stream**
  (observed: it took our `initialize` request as the authorization code). The same happens
  with `CI`, `DEBIAN_FRONTEND`, `BROWSER=www-browser` or `SSH_CONNECTION` (on macOS), which
  `shouldAttemptBrowserLaunch` treats as "no browser". All of them are removed from the CLI's
  environment.
- The browser is opened by `childProcess.spawn("open", [url])` (`xdg-open` on Linux), by name.
  Each session folder therefore holds a `bin/` with stand-in `open` and `xdg-open` scripts, first
  on the CLI's `PATH`. A stand-in creates `browser-requested` in the session folder and exits 0;
  nothing is launched.
- While `initialize` and `session/new` are pending the gateway polls for that marker. When it
  appears the CLI is killed and the request fails at once with HTTP 401 `authentication` and a
  fixed message (`Gemini's saved Google sign-in can no longer be used. Run gateway login gemini
  or use Reconnect in the app.`); the CLI's text and the URL never reach the caller. The
  conversation's reservation is released, so signing in and repeating the request works.

Verified against the real binary with a bogus credential: `initialize` is never answered, `open`
is called with an `https://accounts.google.com/o/oauth2/v2/auth` URL, and the request is a 401 in
under two seconds (`GATEWAY_TEST_REAL_GEMINI=1`, `src/tests/gemini-real-cli.test.ts`). On Linux
the CLI only tries a browser when `DISPLAY`, `WAYLAND_DISPLAY` or `MIR_SOCKET` is set, so the
gateway sets `DISPLAY=:0` when none is; the stand-in makes the value harmless. That Linux path is
not verified against a real CLI.

### The policy file is loaded by the CLI

`<home>/.gemini/policies/gateway.toml` is read by the bundle's `loadPoliciesFromToml`, which
**silently drops a file it cannot parse**: the CLI then runs on its bundled defaults, which allow
`read_file`, `glob`, `google_web_search` and `invoke_agent` without a prompt. The loader returns
errors as data (`errorType` `toml_parse` or `schema_validation`; unknown tool names come back as
warnings) and the CLI only prints them, so stderr is not a reliable channel. `src/tests/gemini-real-cli.test.ts`
calls the real loader from the installed bundle: the gateway's file loads with **no error and no
warning**, every rule is present, and `PolicyEngine` answers `ask_user` for `mcp_gateway_*` and
`deny` for the built-ins, `run_shell_command` and any other server; a malformed or schema-invalid
copy reports its error and loads zero rules, after which `read_file` is `allow`. The same
check showed the bundle's real shell tool is `run_shell_command` (plus `tracker_visualize` and
`complete_task`), which the first list lacked; `geminiBuiltInTools` now names them.

**Announcement guard.** A `session/update` `tool_call` or `tool_call_update` that names a
native built-in, a tool kind such as `execute`, a server other than `gateway`, or a
*running or completed* tool that is not in the caller's catalog ends the session at once
(`invalid_tool_call`). Built-in or caller tool is decided from the CLI's structured
identities, never from ACP's `title`: a tool the CLI's own
`_meta["gemini-cli"].mcp` identifies as a call of the `gateway` server whose tool is in the
caller's catalog is the caller's tool **even when it is named `grep_search`, `read_file`,
`glob` or `list_directory`**, because a caller may choose those names and the CLI's `_meta`
block is not text the model shapes. The `title` names a tool only where the frame carries no
structured identity at all — there nothing else distinguishes one of the CLI's own tools, and
for the auto-allowed built-ins no permission request would ever arrive to refuse it. An
announcement that names nothing at all is left to the permission layer, because closing a
session throws away a conversation whose history cannot be replayed.

**MCP naming.** The CLI names MCP tools `mcp_<server>_<tool>` (`mcp_gateway_<tool>`) and
carries the real server and tool name for an MCP call under
`toolCall._meta["gemini-cli"].mcp`. Both spellings are consulted.

## Permissions

Every `session/request_permission` is answered by the gateway. What is judged is the tool the
CLI's own structured fields name — `toolCall._meta["gemini-cli"].mcp` first, then a structured
`name` or `rawInput.tool_name`, each also read with the `mcp_gateway_` prefix stripped. The
display `title` never authorizes a run: it is free text the model shaped, and one shaped to a
caller tool's name would otherwise make a native tool look like one of the caller's, so a
request with no structured identity in the catalog is refused. The request's own `optionId` is
echoed back verbatim.

| Request | Answer |
|---|---|
| A tool named by the CLI's structured fields as the `gateway` server's and in this session's caller catalog | `allow_once` (`ProceedOnce`) |
| Anything else (native tool, unknown tool, other server, titled only, unidentifiable) | `reject_once` (`Cancel`), else cancelled |

`allow_always` (`ProceedAlwaysServer`, `ProceedAlwaysTool`, `ProceedAlwaysAndSave`) is
never selected — the CLI persists a policy rule for such an answer — and
`security.disableAlwaysAllow` keeps those options from being offered at all. A session
denied 25 times is closed. The client, never the provider, executes tools.

## Prompt framing

A hazard Grok does not have: `Session.prompt` concatenates the leading text parts and, if
the result begins with `/` or `$`, runs it as one of the CLI's own **commands** instead of
answering it — `/extensions install <git url>` installs and runs code, and the turn comes
back as a believable zero-usage `end_turn`. Every prompt is therefore prefixed with a
fixed framing line that starts with an ordinary character, so a caller prompt that begins
with `/` stays data to answer. The continuation ledger is keyed on the caller's history,
not on this text, so framing cannot make a later request look like a different
conversation.

## Sign in

The gateway keeps its own home, `<stateDirectory>/gemini-home` unless `geminiHome` names
another directory, private at 0700, with `settings.json` and the managed system-settings
file at 0600. Sign it in once per Mac:

```sh
gateway login gemini
```

The desktop app's Reconnect runs the same flow (`src/providers/gemini-login.ts`). There is
**no `login` subcommand** and no device-code flow: run with nothing to do, the CLI starts the Google
browser flow, which the managed settings pin (`security.auth.selectedType`/`enforcedType` =
`oauth-personal`). What the real 0.70.0 binary does without a terminal, probed against it:

1. It prints `Opening authentication page in your browser. Do you want to continue? [Y/n]:` and
   reads the answer **from stdin**. With stdin closed (the old Reconnect) nothing is ever
   answered, the process exits **0 with no credential**, and no URL appears.
2. On `Y` it runs the browser opener by name with the sign-in URL. It prints no URL of its own.

So the helper (a Reconnect click or the `gateway login gemini` command is the consent) writes
`Y\n` when the question appears, captures the URL through the same stand-in `open` described
above, and opens it itself, once, only when it is an `https://accounts.google.com/` URL
(the command also prints it). It stops the CLI once the sign-in has finished, or after six
minutes, or on cancel. The CLI's callback handler saves the tokens first, then fetches and caches
the Google account (`google_accounts.json`), and only then redirects the browser to its success
page. So after the credential appears the helper waits until the account is cached plus one
second for the redirect, or the CLI exits, for at most 15 seconds. Stopping on the credential
alone left the account uncached and showed "127.0.0.1 refused to connect" in the browser although
the sign-in had worked. The callback is served on `127.0.0.1` of the computer that runs the
login, so approve the sign-in in a browser on that same computer. Two rules matter:

- **Success is the credential, never the exit code.** The file must exist in the CLI's home:
  `oauth_creds.json`, parsed, carrying both `access_token` and `refresh_token`. A clean exit
  without it fails; a failing exit after it succeeds.
- **The login CLI is isolated.** It runs with its working directory set to an empty private
  folder, never the caller's: a trusted workspace's `.gemini/settings.json` or `.env` must not
  reach a process that holds a Google sign-in. It also runs in a disposable home like a session,
  and the credential is installed into the persistent home only after it is verified. The
  gateway never creates `<home>/.env` or `<home>/.gemini/.env`, and refuses to start the CLI
  (login or inference, HTTP 400) while either exists, because the CLI would load it ahead of the
  managed settings and an auth variable in it would win.

Never answer ACP `authenticate` on a live session: for `oauth-personal` it refreshes the
sign-in and, on a mismatch, *deletes* the stored credential. The gateway never calls it, and
`initialize` also advertises a `gateway` auth method that could inject a custom base URL; that
is never used either.

A home that is not signed in (no credential, or no `refresh_token`) fails the request with HTTP
401 `authentication` **before the CLI starts**, and a credential that exists but cannot refresh is
caught at boot as described above, so inference can never open a browser or block before any
JSON-RPC.

## Continuation, usage and failures

Continuation, the ended-record store, refusal codes and cancellation follow
[Grok sessions](grok-sessions.md) unchanged — they are the shared implementation in
`src/providers/acp-*.ts`. A request continues its conversation's process only when its
history is exactly what the session holds plus the new items; anything else, and any
request for a conversation whose session already ended, is a final 400
`session_continuity_unavailable`, never a replay. `gemini_session` telemetry carries
`outcome`, a fixed `missReason` (`src/providers/gemini-reasons.ts`) and counts; no tokens,
request bodies, tool arguments or environment values are logged.

**Usage** arrives twice: a `usage_update` `session/update` per finished turn, and on the
prompt result as `{inputTokens, outputTokens, cachedReadTokens, thoughtTokens, totalTokens}`
plus per-model `_meta.quota.model_usage`. There is no cost field, unlike Grok's `costUsd`.

**Failures** are mapped to fixed classes and provider prose is never forwarded: a rejected
sign-in (the CLI's `-32000` on `session/new`, or a 401/403) is HTTP 401 `authentication`; a
429, a quota or an exhausted-allowance report is HTTP 429 `rate_limit_exceeded`; a billing
problem is `insufficient_quota`; overload is 503. A failure after the prompt was sent is
final (`session_dead`), not a retryable 502.

**Not yet verified against a real Ultra login:** the entitlement-gated model list, and
exactly how quota and rate-limit failures surface, so the 401-versus-502 mapping above is
built on fixed patterns rather than observed payloads. Re-check both after a real login.
