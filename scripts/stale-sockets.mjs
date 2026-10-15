import { connect } from "node:net";

// The rules that decide which files the test runner (scripts/run-tests.mjs) may remove from the SDK's fixed socket folder when a
// run was stopped. They are kept apart so that a test can try each one with any file status, including one owned by another user.

/** Whether a name can be one of the pinned SDK's socket names: the SHA-256 of a path, in hexadecimal. */
export const sdkSocketName = name => /^[0-9a-f]{64}$/.test(name);

/** Whether a file's status (from `lstat`, so a link is not followed) is a socket made by this user: the only kind the runner removes. */
export const ownSocket = (info, uid) => info.isSocket() && info.uid === uid;


/** What a connection to a socket file shows: "refused" (nothing listens), "listening", or "unknown" (anything else, or no answer). */
const probe = path => new Promise(settle => {
  const socket = connect(path);
  // The timer fires before the answer of a process that was held up is read; the check phase, which comes after it, reads it first.
  const timer = setTimeout(() => setImmediate(() => { socket.destroy(); settle("unknown"); }), 1500);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); settle("listening"); });
  socket.once("error", error => { clearTimeout(timer); settle(error.code === "ECONNREFUSED" ? "refused" : "unknown"); });
});

/**
 * Whether nothing listens on this socket file. A process that was just killed can go on answering for a moment while the kernel
 * tears it down (on macOS it has left its process group by then), so a listener is asked again for up to `ms` before it is believed.
 * A socket that cannot be asked, or that still listens at the end, is not stale.
 */
export async function isStale(path, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const state = await probe(path);
    if (state !== "listening") return state === "refused";
    if (Date.now() >= end) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
