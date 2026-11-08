---
summary: 'Next steps for GateFox and where contributors can help: the Claude apps, DeepSeek, and more harnesses.'
read_when:
  - Looking for something to work on in GateFox
  - Planning work on Claude Desktop or Claude Code support, DeepSeek, or a new client harness
---

# Roadmap

GateFox already serves Claude, ChatGPT, Copilot, OpenRouter, xAI, OpenCode and
local models to Codex, Claude Code and Claude Desktop. The next steps make the
Claude apps feel native, add direct DeepSeek support, and open the gateway to
any harness that accepts an API endpoint, and bring it to Linux and Windows.

Each item links to its GitHub issue; all of them carry the
[`roadmap` label](https://github.com/edihasaj/gatefox/issues?q=is%3Aopen+label%3Aroadmap). Comment there before you start, so two
people do not build the same thing. Items marked **good first issue** need no
deep knowledge of the gateway. Read [CONTRIBUTING.md](../CONTRIBUTING.md) first.

```
            today                                  next
 Codex (Mac + phone)┐                  ┌──────────── Cline · Aider · Zed · Continue
 Claude Code ───────┼─► GateFox ◄──────┤             (Chat Completions ingress)
 Claude Desktop ────┘   │  macOS       └──────────── Linux · Windows
                        ▼
   Claude · ChatGPT · Copilot · OpenRouter · xAI · local    + DeepSeek direct
```

## 1. A better Claude app experience

| Work | Why | Start in |
| --- | --- | --- |
| Report each route's real context window to Claude Desktop ([#73](https://github.com/edihasaj/gatefox/issues/73)) | Routes show Claude's generic 200K or 1M estimate, so compaction can start too late or too early | [Claude Desktop](claude-desktop.md#verified-coverage-and-limits), `src/claude-desktop-*.ts` |
| Set up Claude Desktop from the GateFox app ([#74](https://github.com/edihasaj/gatefox/issues/74)) | Today it needs commands and a manual quit and apply | [Claude Desktop](claude-desktop.md#apply-and-run), [app management](app-management.md) |
| Native reasoning and Fast controls without patching Claude ([#75](https://github.com/edihasaj/gatefox/issues/75)) | The [native picker trial](claude-native-trial.md) works only on a patched copy of one Claude version | `scripts/claude-native-trial/` |
| Long-session checks for Claude Code ([#76](https://github.com/edihasaj/gatefox/issues/76)) | Short checks do not cover long compaction or every MCP schema | [Messages](messages.md), `scripts/e2e-*.mjs` |
| Clearer errors for unsupported Claude features ([#77](https://github.com/edihasaj/gatefox/issues/77)) | A route that cannot honour a feature should say so in the client, not fail later | [Known request rejections](messages.md#known-request-rejections) |

## 2. DeepSeek

DeepSeek works today through [OpenRouter](api-providers.md). A direct
connection was built and later removed on 6 November 2026; it can come back as a
plain API preset.

| Work | Why | Start in |
| --- | --- | --- |
| Direct DeepSeek API preset ([#78](https://github.com/edihasaj/gatefox/issues/78)) | Lower cost and latency than going through OpenRouter, with DeepSeek's own prefix caching | [API providers](api-providers.md), `src/providers/` |
| Reasoning replay and cache usage for DeepSeek ([#79](https://github.com/edihasaj/gatefox/issues/79)) | Keep reasoning across tool calls and report cache hits in the [usage ledger](diagnostics.md#usage-ledger) | [Cache safety](cache-safety.md) |
| DeepSeek in the app's **Add connection** wizard (**good first issue**) ([#80](https://github.com/edihasaj/gatefox/issues/80)) | Today it needs a JSON edit | [App management](app-management.md) |

## 3. Any harness that takes an API endpoint

GateFox accepts the OpenAI **Responses** and Anthropic **Messages** APIs. Many
coding harnesses only speak **Chat Completions**.

| Work | Why | Start in |
| --- | --- | --- |
| `/v1/chat/completions` ingress, with streaming and tool calls ([#81](https://github.com/edihasaj/gatefox/issues/81)) | Unlocks Cline, Aider, Zed, Continue, Goose and most other harnesses | `src/server.ts`, `src/protocol/`, [architecture](architecture.md) |
| `/v1/models` listing for that ingress (**good first issue**) ([#82](https://github.com/edihasaj/gatefox/issues/82)) | Harnesses fill their model picker from it | `src/catalog.ts` |
| Setup recipes per harness (**good first issue**) ([#83](https://github.com/edihasaj/gatefox/issues/83)) | One short, tested page each: OpenCode, Cline, Aider, Zed, Continue, Goose | new `docs/clients/<name>.md` |
| A harness checklist | What to verify before calling a harness supported | [Checklist for a new harness](harness-identity.md#checklist-for-a-new-harness) |

The gateway translates and transports; the harness keeps its tools,
permissions and model choices. New ingress must keep that rule
([architecture](architecture.md)).

## 4. More platforms

GateFox runs on macOS (Apple silicon). Its core is Node, so most of it can move.

| Platform | Today | Help wanted |
| --- | --- | --- |
| macOS | Full support: app, background service, updater, Codex and Claude desktop apps | — |
| Linux | The command-line gateway runs; no published package | Linux archive and install guide ([#84](https://github.com/edihasaj/gatefox/issues/84)) |
| Windows | Not supported yet | Paths, private credential files, a Windows service, and desktop app registration ([#86](https://github.com/edihasaj/gatefox/issues/86)) |
| Phone | Codex in the ChatGPT app lists and continues gateway chats through your Mac's [native relay](native-remote.md) | Claude's mobile Remote Control does not accept custom gateways yet |

## 5. Easier to start

| Work | Why |
| --- | --- |
| A short demo video or GIF in the README (**good first issue**, [#85](https://github.com/edihasaj/gatefox/issues/85)) | Shows the model picker with added models in a few seconds |

## Proposing something else

Open an issue that says who it helps and what you would change. Larger changes
are easier to review when we agree on the approach first.
