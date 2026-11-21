/**
 * Synchronous cleanups for a process that exits while something it owns is still in use: a CLI in a group of its own, or a
 * private folder that holds a copied credential. Nothing asynchronous runs in a `process.exit`, so each owner registers the
 * moment it acquires the thing (not when startup finishes) and unregisters when it has released it normally.
 *
 * The list lives on `globalThis`, so every copy of this module a hot swap leaves loaded shares one `exit` listener. Cleanups run
 * newest first (a process group is killed before the folder it was started in is removed) and one that throws never stops the rest.
 */
type Cleanup = () => void;
const symbol = Symbol.for("harness-gateway/exit-cleanups/v1");

/** Registers `cleanup` for process exit and returns the function that unregisters it. */
export function onProcessExit(cleanup: Cleanup): () => void {
  const scope = globalThis as unknown as Record<symbol, Set<Cleanup> | undefined>;
  let cleanups = scope[symbol];
  if (!cleanups) {
    const created = cleanups = scope[symbol] = new Set<Cleanup>();
    process.once("exit", () => { for (const run of [...created].reverse()) { try { run(); } catch { /* The rest still run. */ } } });
  }
  cleanups.add(cleanup);
  const registered = cleanups;
  return () => { registered.delete(cleanup); };
}
