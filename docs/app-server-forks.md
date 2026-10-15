---
summary: 'How the desktop adapter forwards process requests and composer prediction forks on connected machines, and how throwaway chats stay memory-only.'
read_when:
  - Changing how the adapter forwards process/*, thread/fork or ephemeral chats
  - Investigating rpc_error rejections from remote hosts
---

# Processes and prediction forks

Part of the [Codex app-server adapter](app-server.md).

The desktop runs git commands (the branch and pull request chips) and terminals on a
connected machine through the app-server's process API: `process/spawn`,
`process/writeStdin`, `process/resizePty` and `process/kill`. A process handle belongs to
one connection, and output arrives as `process/outputDelta` and `process/exited`
notifications on that connection. The adapter sends these requests unchanged to that
machine's native engine and returns its answer unchanged, as the native app-server does,
for the relay and SSH paths alike. Nothing runs in the adapter or in a gateway executor.

Some refusals come from the engine itself and also occur natively. The signed SDK
(0.162.0-alpha.17.2) rejects a working directory that is not absolute with `-32600`
"AbsolutePathBuf deserialized without a base path"; the desktop sends its projectless
`~` placeholder when a remote composer has no project. The SDK answers `-32603` "failed
to spawn process" for a directory that does not exist on that machine, and `-32600` "no
active process for process handle" when the desktop stops a git command that has
already exited. Deleting a chat that never wrote a rollout returns "no rollout found for
thread id", which the desktop recognizes.

The desktop's composer suggestions resume a chat and then fork it with
`experimentalPredictionMode: true`, `ephemeral: true` and `excludeTurns: true`. Such a
fork starts from the loaded parent's effective settings, and the SDK refuses it with
`-32600` when the request carries any override, even a single `config` key. The adapter
forwards a prediction fork exactly as the desktop sent it to the engine that owns the
chat. It adds no restored reasoning, gateway model, provider, catalog or speed tier,
applies no hooks-alias correction, and never refuses it over an unknown tier. Before
this, the adapter added a native chat's saved reasoning effort to the fork, so every
suggestion fork failed. Ordinary forks keep the reasoning and tier handling described
above. The change applies to the next adapter connection after an update.

Any ephemeral chat (prediction forks included) is memory-only. Its result writes no
reasoning record and no service-tier row, and a later turn or applied settings change
on it writes none either. The adapter keeps only an in-memory route, so a turn started
on the chat reaches the owning engine without a service-tier or reasoning write. The
newest 256 such chats stay tracked this way, and each one counts toward that cap
whether it was started, resumed, forked, or first seen when a turn probed its owner.
`thread/closed` or `thread/unsubscribe` for one of them forgets its route and chat
snapshot at once; a later turn on a chat that is still loaded in the engine is
recognized as ephemeral again from the engine's own chat read and stays memory-only.

When the 256 cap pushes a chat out, its route and snapshot go but its id is kept in a
second set of the newest 4096 evicted ids, because the engine may still have the chat
subscribed. A settings notification for one of those ids writes nothing durable, and
neither does the result of a resume of one. A turn that is already running when its chat
is closed, unsubscribed or evicted writes no reasoning record when the engine answers.

The private stores have different bounds. The service-tier store holds at most 16384
chats and its file at most 4 MiB (long model names reach that limit first). When a write
would pass either limit, it evicts other chats instead of failing: rows that were never
stamped with a record time first, then the rows stamped longest ago, and never the chat
being written. A chat's row and its unknown-tier marker (below) count as rows, each by its
exact size, and leave together: chats go oldest first by the newest stamp of either, so an
older row never outlives a newer marker. The reasoning store also holds at most 16384 chats and evicts the chat
observed longest ago when it is full, but its 4 MiB file limit is a hard one: a write
that would pass it is refused rather than making room.

The per-chat compaction overrides that a gateway executor remembers are forgotten when
the chat closes or is unsubscribed, deleted or archived. If 4096 chats are still held,
remembering another drops the one set longest ago instead of refusing the new chat.

Each `rpc_error` event records a fixed `rejection` name for the refusal, so these cases
can be told apart without storing error text; see [diagnostics](diagnostics.md).
