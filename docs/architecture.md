---
summary: 'Account routing, provider execution, live configuration, and desktop isolation.'
read_when:
  - Changing account routing or configuration reload
  - Changing provider execution or desktop backend isolation
---

# Architecture

The HTTP daemon accepts authenticated OpenAI Responses requests. Configuration
maps each public model alias to one provider, account, and upstream model.
Provider adapters own authentication and inference. The Responses translator
owns request compilation, replay, and streamed output. Codex executes file and
command tools; providers receive their results through replay.

An inference keeps the configuration snapshot with which it began. New requests
load atomically replaced configuration. Invalid configuration fails closed until
repaired. Existing aliases cannot change account, provider, credential source, or
upstream model live. Add another alias or restart after active work finishes.
Retiring an alias does not release its identity until the daemon restarts.
Labels and capability metadata can update live. Listener and state-directory
changes require a restart.

A macOS user LaunchAgent keeps the daemon alive across app and terminal exits.
Its environment contains PATH, not provider credentials. Credentials and gateway
client tokens are private files. Logs exclude request bodies, tool arguments,
provider tokens, and environment values.

## Desktop connections

The stdio adapter keeps one original native app-server connection. Account
requests and native chats use that connection. Gateway chats use separate
executors with private configuration homes. The adapter reads effective native
settings for a private snapshot, excludes native provider authentication settings,
and never copies the primary auth file. Automatic project-trust writes therefore
land in the gateway executor's private configuration.

Executors share native chat storage and SQLite metadata so saved gateway chats
remain discoverable through the desktop's normal thread list. User instructions,
skills, and plugins keep one source through links. The global AGENTS.md link
also follows a file created after an executor starts. Native configuration is never
linked. All model preferences are saved in gateway-owned state.

The adapter fetches authenticated public model metadata from the inference host.
A catalog change creates a fresh gateway executor for new chats. Loaded chats
retain their original executor, including active turns and terminal state.
At most four catalog generations can retain loaded gateway chats. Close an older
gateway chat before adding another generation at that limit. Idle generations
without loaded chats are stopped. A gateway executor failure does not stop the
native connection; saved gateway history can be resumed.
