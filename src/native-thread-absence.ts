/**
 * True when the native SDK reports that it has no record of this exact chat:
 * not loaded and never written (no rollout, no SQLite row). A provider probe
 * that fails this way has learned nothing, so the original request goes to the
 * native SDK, which gives its own answer for that method (an empty list, a
 * notLoaded unsubscribe, or "no rollout found", which the desktop recognizes).
 */
export function nativeThreadAbsent(error: unknown, threadId: string): boolean {
  const failure = error as { code?: unknown; message?: unknown } | undefined;
  return failure?.code === -32600 && (failure.message === `thread not loaded: ${threadId}` || failure.message === `no rollout found for thread id ${threadId}`);
}
