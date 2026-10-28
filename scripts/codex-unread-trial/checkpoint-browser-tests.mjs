/** Real-browser IndexedDB checks. Synthetic identities/receipts only; no app or SDK access. */
import { createReceiptCheckpoints } from './receipt-checkpoints.mjs';
import { installReadStateBridge } from './read-state-bridge.mjs';

const equal = (actual, expected, message) => { if (!Object.is(actual, expected)) throw Error(`${message}: ${actual} !== ${expected}`); };
const rejects = async (operation, message) => { try { await operation(); } catch { return; } throw Error(message); };
const state = (revision, unread = true) => ({ revision, firstUnread: unread ? { type: 'turn', turnId: 'turn' } : null });
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const stores = [];
const store = (name, options = {}) => {
  const result = createReceiptCheckpoints({ scope: () => JSON.stringify(['synthetic-account', name]), ...options });
  stores.push(result); return result;
};
const project = async (journal, id, receipt, local, choice) => journal.project(id, receipt, local, await journal.capture(), choice);
// Interrupt a real transaction after its threads.put succeeds but before commit.
const afterWrite = callback => ({ open(...args) {
  const query = indexedDB.open(...args);
  query.addEventListener('success', () => {
    const db = query.result, nativeTransaction = db.transaction.bind(db);
    db.transaction = (...args) => {
      const tx = nativeTransaction(...args), nativeStore = tx.objectStore.bind(tx);
      tx.objectStore = name => {
        const object = nativeStore(name);
        if (name === 'threads') {
          const put = object.put.bind(object);
          object.put = (...args) => { const write = put(...args); write.addEventListener('success', callback); return write; };
        }
        return object;
      };
      return tx;
    };
  });
  return query;
} });

export async function run() {
  const passed = [];
  const check = async (name, action) => { await action(); passed.push(name); };
  try {
    await check('legacy choices survive first sync and reopening', async () => {
      let journal = store('migration');
      equal(await project(journal, 'read', state('R1'), false), false, 'Legacy read');
      equal(await project(journal, 'unread', state('R1', false), true), true, 'Legacy unread');
      journal.dispose(); journal = store('migration');
      equal(await project(journal, 'read', state('R1'), true), false, 'Durable baseline');
      equal(await project(journal, 'read', state('R2'), false), true, 'Offline completion');
      equal(await project(journal, 'read', state('ACK', false), true), false, 'Read acknowledgement');
      journal.dispose(); journal = store('migration');
      equal(await project(journal, 'read', state('ACK', false), true), false, 'Read survives reopen');
    });
    await check('fresh threads and explicit no-op choices persist', async () => {
      const journal = store('fresh'); await journal.fresh('new');
      equal(await project(journal, 'new', state('R1'), false), true, 'First completion');
      const start = { revision: 'manual', firstUnread: { type: 'threadStart' } };
      equal(await project(journal, 'legacy', start, false), false, 'Preserve legacy');
      equal(await project(journal, 'legacy', start, true, true), true, 'Explicit unread');
      equal(await project(journal, 'legacy', start, false), true, 'Choice persists');
      await journal.forget('new');
      equal(await project(journal, 'new', state('R1'), false), false, 'Deleted baseline removed');
    });
    await check('shared connections reject stale cross-window responses atomically', async () => {
      const frame = document.createElement('iframe'); frame.src = '/';
      const loaded = new Promise(resolve => { frame.onload = resolve; }); document.body.append(frame); await loaded;
      const a = store('shared');
      // A separate document/global owns this connection, as with a second native window.
      const b = await frame.contentWindow.eval("import('/receipt-checkpoints.mjs').then(m=>m.createReceiptCheckpoints({scope:()=>JSON.stringify(['synthetic-account','shared'])}))");
      try {
        await project(a, 'one', state('R1'), false);
        const stale = await a.capture();
        equal(await project(b, 'one', state('R2'), false), true, 'Other window completion');
        equal(await a.project('one', state('R1'), false, stale), undefined, 'Delayed old list rejected');
        equal(await a.project('one', state('R1'), false, await a.capture(), false), undefined, 'Stale semantic choice reverted other window revision');
        equal(await project(a, 'one', state('R2'), false), true, 'Current receipt retained');
        const fence = await a.capture();
        const results = await Promise.all([a.project('one', state('R3'), false, fence), b.project('one', state('R4'), false, fence)]);
        equal(results.filter(value => value === undefined).length, 1, 'Concurrent revisions serialized');
      } finally { b.dispose(); frame.remove(); }
    });
    await check('account, execution host and retired scope stay isolated', async () => {
      const a = store('host-a'), b = store('host-b'), other = store('host-a', { scope: () => 'other-account/host-a' });
      await project(a, 'one', state('R1'), false); await project(a, 'one', state('R2'), false);
      equal(await project(b, 'one', state('R2'), false), false, 'Execution host isolation');
      equal(await project(other, 'one', state('R2'), false), false, 'Account isolation');
      let scope = 'retirable'; const retired = store('retired', { scope: () => scope });
      await retired.capture(); scope = null;
      await rejects(() => project(retired, 'one', state('R1'), false), 'Retired scope accepted');
    });
    await check('capacity, malformed receipts and storage errors preserve data', async () => {
      const journal = store('bounded', { limit: 1 }); await project(journal, 'one', state('R1'), false);
      await rejects(() => project(journal, 'two', state('R1'), true), 'Capacity evicted attention');
      equal(await project(journal, 'one', state('R2'), false), true, 'Existing row retained');
      await rejects(() => project(journal, 'one', { revision: '', firstUnread: null }, false), 'Malformed revision accepted');
      const broken = store('broken', { indexedDB: { open() { throw Error('Storage denied'); } } });
      await rejects(() => broken.capture(), 'Storage error ignored');
    });
    await check('stored scope is hashed and corrupted rows fail closed', async () => {
      const journal = store('corruption'); await project(journal, 'one', state('R1'), false);
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('harness-gateway-unread-checkpoints-v1', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = reject;
      });
      try {
        const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['synthetic-account', 'corruption']))))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['threads'], 'readwrite'), query = tx.objectStore('threads').get(`${key}:one`);
          query.onsuccess = () => {
            equal(JSON.stringify(query.result).includes('synthetic-account'), false, 'Raw identity stored');
            tx.objectStore('threads').put({ ...query.result, sequence: -1 });
          };
          tx.oncomplete = resolve; tx.onabort = reject;
        });
        await rejects(() => project(journal, 'one', state('R2'), false), 'Corruption accepted');
      } finally { db.close(); }
    });
    await check('aborting a projection rolls back writes and journal sequence before commit', async () => {
      const controller = new AbortController();
      const journal = store('abort', { indexedDB: afterWrite(() => controller.abort()) });
      const fence = await journal.capture();
      await rejects(() => journal.project('one', state('R1'), true, fence, undefined, controller.signal), 'Aborted projection committed');
      equal(await journal.capture(), fence, 'Sequence did not roll back');
      equal(await project(journal, 'one', state('R1'), false), false, 'Stale first-sync row survived abort');
    });
    await check('a semantic read during first-sync disk write cannot resurrect unread after refresh', async () => {
      let unread = true, acknowledgements = 0, interrupt = true;
      const saved = { has: () => unread, set: (_id, value) => { unread = value; }, isReady: () => true, subscribe: () => () => {} };
      const journal = store('migration-race', { indexedDB: afterWrite(() => {
        if (!interrupt) return; interrupt = false; saved.set('one', false); bridge.mark('one', false);
      }) });
      const client = { async sendRequest(method) {
        if (method === 'thread/readState/update') { acknowledgements++; throw Error('Unknown read must not ACK'); }
        return { data: [{ id: 'one' }], thread: { id: 'one' }, readStates: { one: state('R1') }, readState: state('R1') };
      } };
      const bridge = installReadStateBridge({ client, saved, checkpoints: journal });
      try {
        await client.sendRequest('thread/list', {});
        for (let attempt = 0; attempt < 100 && !bridge.snapshot('one'); attempt++) await pause();
        await client.sendRequest('thread/list', {});
        equal(unread, false, 'First refresh resurrected dot'); equal(acknowledgements, 0, 'Unknown receipt acknowledged');
        bridge.dispose();
        equal(await project(store('migration-race'), 'one', state('R1'), true), false, 'Stale baseline survived manager disposal');
      } finally { bridge.dispose(); }
    });
    await check('bridge persists wake recovery and a semantic read across manager replacement', async () => {
      const values = new Map([['one', false]]); let receipt = state('R1'), acknowledgements = 0;
      const create = () => {
        const saved = { has: id => values.get(id), set: (id, value) => values.set(id, value), isReady: () => true, subscribe: () => () => {} };
        const client = { async sendRequest(method, params) {
          if (method === 'thread/readState/update') { acknowledgements++; receipt = state('ACK', false); return { readState: receipt }; }
          return { data: [{ id: 'one' }], readStates: { one: receipt } };
        } };
        const bridge = installReadStateBridge({ client, saved, checkpoints: store('bridge') });
        return { client, saved, bridge };
      };
      let f = create(); await f.client.sendRequest('thread/list', {});
      equal(values.get('one'), false, 'Preserved first sync'); equal(acknowledgements, 0, 'No inferred ACK');
      f.bridge.dispose(); receipt = state('R2'); f = create(); await f.client.sendRequest('thread/list', {});
      equal(values.get('one'), true, 'Wake dot restored');
      f.saved.set('one', false); f.bridge.mark('one', false);
      for (let attempt = 0; attempt < 100 && f.bridge.snapshot('one')?.revision !== 'ACK'; attempt++) await pause();
      // Flush the ACK checkpoint transaction before retiring this manager.
      for (let attempt = 0; attempt < 100; attempt++) {
        await f.client.sendRequest('thread/list', {});
        if (f.bridge.snapshot('one')?.revision === 'ACK' && values.get('one') === false) break;
        await pause();
      }
      equal(acknowledgements, 1, 'Single semantic ACK'); f.bridge.dispose(); f = create();
      await f.client.sendRequest('thread/list', {}); equal(values.get('one'), false, 'Read survives replacement'); f.bridge.dispose();
    });
    // The runner reloads this origin before checking this journal again.
    const reload = store('document-reload'); await project(reload, 'one', state('R1'), false);
    return { passed, count: passed.length };
  } finally { for (const journal of stores) journal.dispose(); }
}

export async function afterReload() {
  const journal = store('document-reload');
  try {
    equal(await project(journal, 'one', state('R1'), true), false, 'Document reload lost checkpoint');
    equal(await project(journal, 'one', state('R2'), false), true, 'Completion after reload lost');
    return { passed: ['checkpoint survives document reload; new revision restores unread'], count: 1 };
  } finally { journal.dispose(); }
}
