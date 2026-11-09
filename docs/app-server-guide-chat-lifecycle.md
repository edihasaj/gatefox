---
summary: 'Sub-agent hydration, executor re-attach, shared acquires, chat notification order and queued messages for gateway chats.'
read_when:
  - A sub-agent fails to open or a gateway chat loses its executor
  - Many sidebar requests reach unloaded chats at once
  - A prewarmed chat shows empty or message order looks wrong
  - Queued messages (Cmd+Enter) pause, resume or fail on a gateway turn
---

# Chat and executor lifecycle

Part of the [Codex app-server adapter](app-server.md).

## Opening an unloaded subagent

Multi-Agent V2 children resume through their loaded immediate parent's SDK.
If a model catalog or role change created a newer executor generation, the
adapter must still open an unloaded child on the parent's existing generation.
Starting a current-generation executor instead can return `-32600`: “cannot
resume an unloaded multi-agent v2 sub-agent through its parent; resume the parent
first, or use thread/read to inspect it”. The desktop then fails hydration even
though the child's saved history remains readable. This affects local and API
models alike.

The adapter checks the saved child's identity and gateway classification, then
uses the immediate parent's existing binding or shared owner for `thread/resume`.
It does not load a parent, start a turn or change caller settings. If no parent
is loaded, the SDK's existing refusal remains; `thread/read` and
`thread/turns/list` can still inspect saved history. Paginated histories require
the native `thread_history_1.sqlite` store as well as the rollout files when
reproducing a read in an isolated home.

## Many requests for unloaded chats at once

A reconnecting app sends one request per chat in its sidebar, such as
`thread/attachment/list`, and an unloaded gateway chat needs a gateway executor to answer.
Since 1.6.5 requests for the same generation on the same host connection share a single
`execution/acquire`, whose frame carries the whole catalog; the host's lease covers all of
them. Each request reads the current settings first, so one with different settings asks
for its own generation. A failed acquire fails the requests waiting on it and is not
remembered; the next request tries again.

The adapter also keeps its answer to "which gateway SDK" while the SDK's files are unchanged
(device, inode, size, times, owner and mode), instead of hashing the file on every request.
That answer only names the SDK. Whatever spawns one still hashes the bytes first and refuses
a mismatch: the execution host on each spawn, and the adapter for its private executors.

## Re-attaching a gateway chat

A gateway chat runs on an executor that can go away under a loaded chat: the shared host
restarts (a service upgrade or restart), a private executor exits, or the host drops this
adapter's connection. Since 0.4.7 the chat's next request does not fail for that. The
adapter first loads the chat again: it finds the host again (a kick and up to 20 seconds
of waiting, taken once however many chats wait), takes the generation that still owns the
chat or the current one, and sends `thread/resume` the way a desktop resume does, then the
request itself. The resume carries only what the SDK cannot restore from the chat's own
history (config, instructions, personality and the speed tier), always with
`excludeTurns: true`, and never a model, provider id, approval policy, approvals reviewer,
permissions, folder or workspace roots: the SDK applies the latest values saved with the
chat to a resume that omits them (an explicit folder wins over the saved one, and explicit
roots skip their restore), so a chat that tightened its approvals, changed its model and
effort or moved to another folder after loading keeps those changes through a re-attach. A chat this connection
did not load, such as a sub-agent, one it has forgotten, or one whose parameters it
evicted (a connection keeps the most recent 512), is resumed with its saved settings
alone; the replayed `config` drops the keys that would block that restore.

- One re-attach per chat at a time: requests that arrive meanwhile wait on the flight
  claimed before anything is awaited, so the chat is resumed once.
- Nothing of a turn that died with the executor is sent again. Stopping or steering that
  turn afterwards gets the executor's own answer.
- The host's owner and generation rules still decide, so a chat never gets a second
  writer: a live generation that owns the chat serves it again.
- `thread/unsubscribe` asks nothing of an executor: on a closed engine the adapter clears
  the chat's records and answers `notLoaded` itself instead of waking the host.
  `thread/delete` and `thread/archive` still re-attach first, because the SDK must load
  the chat to unload or remove it. An unsubscribe that arrives while that chat's re-attach
  is running waits for it and then unloads the chat on the executor it landed on, so the
  re-attach never undoes it.
- A host that stays down fails fast: after one failed lookup, attempts on that connection
  for the next 5 seconds get the old error at once instead of kicking and waiting through
  the host again, and one such window records at most one failure. Only a failed host
  lookup opens the window; a refusal from the gateway itself (the catalog, the generation
  limit, a changed provider) or from the resume is the chat's own failure and opens none.
  The window ends as soon as any host lookup on the connection finds the host alive.
- A throwaway chat (a composer prediction) lived only in the executor that is gone and
  is not re-attached, and a host that stays down past the wait, an executor that refuses
  the resume, or a shutdown that has begun gives the error from before: "The gateway
  executor connection was lost; resume this chat to reconnect to its saved or running
  session." (code -32001), or for a private executor "The gateway executor exited; …".
- Native chats are unchanged: when the native engine goes away, the app reconnects.
- A host that runs another release's gateway SDK (an app and a service that moved to a
  new release at different times) refuses the generation with a fixed message that the
  adapter shows for the request, in place of the generic failure above. When this app is
  the newer one: "This Mac's gateway service is moving to the newer release; this chat
  continues as soon as no turn is running". Otherwise: "This app and this Mac's gateway
  service run different gateway releases; quit and reopen ChatGPT to load the installed
  release". The request that triggered a re-attach gets it too, and it is the chat's own
  failure, not a lost host, so it opens no fail-fast window. The service moves promptly
  when the adapter is the newer one, see
  [release skew](services.md#release-skew-a-newer-adapter-beside-an-older-host).

Each re-attach is logged as `executor_reattached` or `executor_reattach_failed`
([diagnostics](diagnostics.md)).

When only a shared executor client's socket closes during an active gateway turn,
the adapter attempts that same re-attach immediately. It reads the owning SDK's
saved turn state before updating the desktop: an in-progress turn is rejoined and
a terminal turn is forwarded once. It never repeats a prompt, steering request,
tool result or approval decision. Genuine pending approval requests retain their
frontend IDs and require an explicit answer. Paginated histories restore completed display items
only when the SDK recorded their completion time.
If an active turn's earlier item history is unavailable, the adapter keeps its
genuine future stream; reopening the chat may still be needed to reload earlier
output. A turn already finished during the disconnect requires readable item
history before the adapter reports its recovered completion.

### A listener that outlives its release

An adapter can stay open after the installer prunes the release directory it
started from. When its complete original `package` directory is gone, it may load
the SDK from the managed installation's `current` release and continue saved chats
without reconnecting. That replacement is accepted only when the installation
marker, `current` link, selected release marker, package version, SDK receipt,
component hashes, capability and pinned SDK source all verify. The link must select
a direct, user-owned release beneath that installation; a checkout, escaped link,
partial old package, or present package whose SDK is missing or invalid never falls
back.

The connection keeps the provider it selected for new chats. A `gatefox`
connection can use a newly verified SDK without changing its
identity. A connection that selected `openai` continues only when the replacement
proves the gateway executor capability; it never resumes gateway history on a stock
executor.

An already-loaded executor retains the catalog it loaded. Changing a catalog file
cannot alter that generation, and a live owner continues serving its loaded chats.
After an update, let the shared service adopt the release when it is quiet; do not
force-kill it. To move one affected chat sooner, unsubscribe it from every frontend,
wait for its `thread/closed` event (or for the host to report no owner), then resume
it through an adapter on the fixed release. A resume before the old owner unloads
returns to that owner.

## Empty chats and message order

The SDK answers a `thread/start` or `thread/fork` request before it announces the
new thread. The desktop depends on that order: it hides a prewarmed chat (the empty
chat behind an unsent draft) only when the reply arrives before `thread/started`.
The adapter records a gateway chat's tier before it answers, so it holds the new
thread's notifications until the reply is written and then releases them in SDK
order. Chats that are already known keep streaming while a start is pending, a
failed start still releases the held notifications, and a buffer of more than 512
held messages is written out in order rather than growing. A server request (an
approval or elicitation, which carries its own id and never waits) still follows
every message already held for its own chat: those held notifications are written
first, so the desktop is never asked to answer an event it has not seen. Before this, a gateway
prewarm showed up in the sidebar as an empty chat, and opening it failed with
"Failed to resume chat".

A request for a chat that no SDK knows (no rollout, nothing loaded) goes to the
native SDK unchanged, so the desktop receives the SDK's own answer: an empty
attachment list, a `notLoaded` unsubscribe, or "no rollout found for thread id",
which the desktop recognizes when it archives or deletes such a chat. Any other
failure of the provider lookup still fails closed.

## Queued messages (Cmd+Enter)

`thread/queue/*` goes to the chat's own engine like any other chat request, and the
SDK owns the queue: it is saved on disk in the shared queue database, the next
message starts when the running turn completes, and an interrupt pauses the queue.
With gateway SDK capability `gateway-executor-v3`, a failed gateway turn also
pauses automatic queue dispatch. This applies to every provider routed through
that executor, including Claude, Codex, Copilot, and ordinary API models. Queued
messages keep their IDs, contents, and order in the native database. Adding or
editing a queued message, another connection writing to the queue, or resuming
the chat after a restart does not release the pause.

An explicit new turn can continue the failed work from saved history. After it
succeeds, queued messages run in their existing order. An explicit
`thread/queue/start` can instead start the selected queued message. The failed
turn remains a real failure; the gateway does not fabricate an interruption,
retry a subscription limit, or choose another account or model. Unmarked native
Codex engines keep their own queue behavior. Clients outside this executor,
such as Claude Code or Claude Desktop, own their own queues.

The automatic queue start checks the pause while reserving an idle turn, so a
concurrent failure cannot slip past a prior queue inspection. Older SDK artifacts
retain their previous behavior; the release must build the v3 SDK before this
protection is available.

The SDK reads every attached local image or audio file while it enqueues a message.
macOS gives file access to the desktop app, not to the service that owns shared
executors, so a screenshot from a protected folder failed there with `-32600`
"local queued attachment is invalid: Operation not permitted". For `thread/queue/add`
and `thread/queue/update`, the adapter (which runs under the app) now copies each
attached local file into a private `queued-attachments` directory under the gateway
state directory, sends the SDK the copy, and removes the copy when the call returns;
copies older than ten minutes left by a crash are removed. The copy keeps the
file extension, because the SDK takes the audio type from it, and is cut one byte past
the SDK's own size limit so oversized files still get the SDK's size error. A file the
adapter cannot read is sent unchanged, so the SDK reports the same error as before.
Executors that run under the app (per-connection engines) are not changed. Paths and
file contents are never logged.
