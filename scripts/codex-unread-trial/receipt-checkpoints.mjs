/** Per-account/executor client checkpoints. Only opaque scope hashes and receipt metadata reach IndexedDB. */
export function createReceiptCheckpoints({ scope, indexedDB = globalThis.indexedDB, crypto = globalThis.crypto, limit = 10000 } = {}) {
  if (typeof scope !== 'function' || !indexedDB?.open || !crypto?.subtle?.digest || !Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw Error('Unread checkpoint persistence is unavailable');
  }
  let disposed = false, originalScope, opening, connection;
  const fail = () => Error('Unread checkpoint persistence is unavailable or retired');
  const current = () => !disposed && (originalScope === undefined || scope() === originalScope);
  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256;
  const validReceipt = state => typeof state?.revision === 'string' && state.revision.length > 0 && state.revision.length <= 1024 &&
    (state.firstUnread === null || state.firstUnread?.type === 'threadStart' ||
      (state.firstUnread?.type === 'turn' && validId(state.firstUnread.turnId)));
  const request = query => new Promise((resolve, reject) => {
    query.onsuccess = () => resolve(query.result);
    query.onerror = () => reject(fail());
  });
  async function open() {
    if (!current()) throw fail();
    if (!opening) {
      const value = scope();
      if (typeof value !== 'string' || !value || value.length > 16384) throw fail();
      originalScope = value;
      opening = (async () => {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        const key = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (!current()) throw fail();
        const query = indexedDB.open('harness-gateway-unread-checkpoints-v1', 1);
        query.onupgradeneeded = () => {
          for (const store of ['meta', 'threads']) if (!query.result.objectStoreNames.contains(store)) query.result.createObjectStore(store, { keyPath: 'key' });
        };
        query.onblocked = () => { /* Never delete another window's data or force-close it. */ };
        const db = await request(query); connection = db;
        db.onversionchange = () => db.close();
        if (!current()) { db.close(); throw fail(); }
        return { db, key };
      })();
    }
    return opening;
  }
  async function transaction(mode, change, signal) {
    const { db, key } = await open(); if (!current() || signal?.aborted) throw fail();
    const tx = db.transaction(['meta', 'threads'], mode, { durability: 'strict' });
    const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(fail()); tx.onerror = () => {}; });
    // Observe failures even when a rejected request exits change() before transaction completion.
    done.catch(() => {});
    const abort = () => { try { tx.abort(); } catch {} };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await change(tx.objectStore('meta'), tx.objectStore('threads'), key);
      await done; if (!current() || signal?.aborted) throw fail(); return result;
    } catch (error) { try { tx.abort(); } catch {} throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  const metadata = (value, key) => {
    if (value === undefined) return { key, sequence: 0, count: 0 };
    if (value.key !== key || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      !Number.isInteger(value.count) || value.count < 0 || value.count > limit) throw fail();
    return value;
  };
  const next = meta => { if (meta.sequence >= Number.MAX_SAFE_INTEGER) throw fail(); meta.sequence++; };
  return {
    /** Captured before the SDK request: a response cannot overwrite a newer observation from another window. */
    capture() { return transaction('readonly', async (meta, _threads, key) => metadata(await request(meta.get(key)), key).sequence); },
    project(id, state, localUnread, fence, choice, signal) {
      if (!validId(id) || !validReceipt(state) || !Number.isSafeInteger(fence) || fence < 0 ||
          (choice !== undefined && typeof choice !== 'boolean')) return Promise.reject(fail());
      return transaction('readwrite', async (metaStore, threads, key) => {
        const meta = metadata(await request(metaStore.get(key)), key), rowKey = `${key}:${id}`;
        const prior = await request(threads.get(rowKey));
        if (prior && (prior.key !== rowKey || !Number.isSafeInteger(prior.sequence) || prior.sequence < 1 || prior.sequence > meta.sequence ||
          (prior.revision !== null && (typeof prior.revision !== 'string' || !prior.revision || prior.revision.length > 1024)) || typeof prior.unread !== 'boolean')) throw fail();
        if (prior?.revision === state.revision && (choice === undefined || choice === prior.unread)) return prior.unread;
        // A local no-op choice is tied to its known revision, never to an older
        // snapshot that another window has already replaced before capture().
        if (choice !== undefined && prior && prior.revision !== state.revision) return undefined;
        if (prior && prior.sequence > fence) return undefined;
        // First sync preserves the native client's existing choice. No SDK acknowledgement is inferred from it.
        const unread = choice ?? (prior ? state.firstUnread !== null : typeof localUnread === 'boolean' ? localUnread : state.firstUnread !== null);
        if (!prior && meta.count >= limit) throw Error('Unread checkpoint capacity reached; native read state was preserved');
        if (!prior) meta.count++;
        next(meta);
        await request(threads.put({ key: rowKey, revision: state.revision, unread, sequence: meta.sequence }));
        await request(metaStore.put(meta));
        return unread;
      }, signal);
    },
    /** A response to our own start/fork proves a new chat; it has no ambiguous legacy read baseline. */
    fresh(id) {
      if (!validId(id)) return Promise.reject(fail());
      return transaction('readwrite', async (metaStore, threads, key) => {
        const rowKey = `${key}:${id}`; if (await request(threads.get(rowKey))) return;
        const meta = metadata(await request(metaStore.get(key)), key);
        if (meta.count >= limit) throw fail(); meta.count++; next(meta);
        await request(threads.put({ key: rowKey, revision: null, unread: false, sequence: meta.sequence }));
        await request(metaStore.put(meta));
      });
    },
    forget(id) {
      if (!validId(id)) return Promise.reject(fail());
      return transaction('readwrite', async (metaStore, threads, key) => {
        const rowKey = `${key}:${id}`; if (!await request(threads.get(rowKey))) return;
        const meta = metadata(await request(metaStore.get(key)), key); meta.count--; next(meta);
        await request(threads.delete(rowKey)); await request(metaStore.put(meta));
      });
    },
    dispose() { disposed = true; connection?.close(); },
  };
}
