import assert from 'node:assert/strict';
import test from 'node:test';
import { installReadStateBridge } from '../codex-unread-trial/read-state-bridge.mjs';
import { createReceiptRegistry } from '../codex-unread-trial/receipt-registry.mjs';

const state = (revision, unread = true) => ({ revision, firstUnread: unread ? { type: 'turn', turnId: 'turn' } : null });
const page = value => ({ data: [{ id: 'one' }], readStates: { one: value } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(send, { synchronousRead = false, notify } = {}) {
  const values = new Map(), loaded = new Map(), calls = [];
  let bridge;
  const saved = { has: id => values.get(id), isReady: () => true, subscribe: () => () => {},
    set(id, unread) {
      values.set(id, unread);
      if (synchronousRead && unread) { values.set(id, false); loaded.set(id, false); bridge.mark(id, false); }
    } };
  const client = { sendRequest(method, params) { calls.push({ method, params }); return send(method, params); } };
  bridge = installReadStateBridge({ client, saved, notify: notify ?? ((id, unread) => loaded.set(id, unread)) });
  return { bridge, client, saved, values, loaded, calls };
}

test('synchronous native read during projection cannot be overwritten by the outer unread projection', async () => {
  const ack = deferred();
  const f = setup(method => method === 'thread/list' ? Promise.resolve(page(state('v1'))) : ack.promise, { synchronousRead: true });
  await f.client.sendRequest('thread/list', {});
  assert.equal(f.values.get('one'), false); assert.equal(f.loaded.get('one'), false);
  assert.equal(f.calls[1].params.expectedRevision, 'v1');
  ack.resolve({ readState: state('v2', false) }); await tick(); f.bridge.dispose();
});

test('receipt signals include unchanged booleans, snapshots are copies, and disposal stops callbacks', async () => {
  let revision = 'v1'; const f = setup(() => Promise.resolve(page(state(revision))));
  const revisions = []; f.bridge.subscribe(id => revisions.push(f.bridge.snapshot(id).revision));
  await f.client.sendRequest('thread/list', {});
  const copy = f.bridge.snapshot('one'); copy.firstUnread.turnId = 'changed'; copy.revision = 'changed';
  assert.equal(f.bridge.snapshot('one').firstUnread.turnId, 'turn');
  revision = 'v2'; await f.client.sendRequest('thread/list', {});
  assert.deepEqual(revisions, ['v1', 'v2']);
  f.bridge.dispose(); f.bridge.observe({ method: 'thread/readState/changed', params: { threadId: 'one', readState: state('v3') } });
  assert.equal(revisions.length, 2); assert.equal(f.bridge.snapshot('one'), null);
});

test('a read of a newer receipt is retained behind a read of an older revision', async () => {
  const first = deferred(); let updates = 0;
  const f = setup((method, params) => method === 'thread/list' ? Promise.resolve(page(state('v1')))
    : ++updates === 1 ? first.promise : Promise.resolve({ readState: state('v3', false) }));
  await f.client.sendRequest('thread/list', {});
  f.saved.set('one', false); f.bridge.mark('one', false);
  f.bridge.observe({ method: 'thread/readState/changed', params: { threadId: 'one', readState: state('v2') } });
  f.saved.set('one', false); f.bridge.mark('one', false);
  first.reject(Object.assign(Error('conflict'), { data: { reason: 'readStateConflict', readState: state('v2') } }));
  await tick(); await tick();
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/readState/update').map(call => call.params.expectedRevision), ['v1', 'v2']);
  assert.equal(f.values.get('one'), false); f.bridge.dispose();
});

test('a synchronous fresh read during conflict projection survives retiring the old action', async () => {
  const first = deferred(); let calls = 0; let f;
  f = setup(method => method === 'thread/list' ? Promise.resolve(page(state('v1')))
    : ++calls === 1 ? first.promise : Promise.resolve({ readState: state('v3', false) }), {
    notify(id, unread) {
      f.loaded.set(id, unread);
      if (unread && f.bridge.snapshot(id)?.revision === 'v2') { f.saved.set(id, false); f.loaded.set(id, false); f.bridge.mark(id, false); }
    },
  });
  await f.client.sendRequest('thread/list', {}); f.saved.set('one', false); f.bridge.mark('one', false);
  first.reject(Object.assign(Error('conflict'), { data: { reason: 'readStateConflict', readState: state('v2') } }));
  await tick(); await tick();
  assert.equal(calls, 2); assert.equal(f.values.get('one'), false); assert.equal(f.loaded.get('one'), false); f.bridge.dispose();
});

test('registry replacement and disposal cannot publish an old manager receipt into its successor', async () => {
  const registry = createReceiptRegistry(installReadStateBridge), received = [];
  registry.subscribe('one', host => received.push([host, registry.snapshot(host, 'one')?.revision]));
  const manager = revision => ({ cleanup: [], getHostId: () => 'host',
    threadStore: { params: { requestClient: { sendRequest: async () => page(state(revision)) } } },
    readState: { has: () => false, set() {}, isReady: () => true, subscribe: () => () => {} }, applySavedConversationReadState() {} });
  const old = manager('old'), fresh = manager('fresh'); registry.install(old);
  await old.threadStore.params.requestClient.sendRequest('thread/list', {});
  registry.install(fresh); for (const clean of old.cleanup) clean();
  await fresh.threadStore.params.requestClient.sendRequest('thread/list', {}); await tick();
  assert.equal(received.at(-1)[1], 'fresh'); assert.equal(registry.snapshot('host', 'one').revision, 'fresh');
  for (const clean of fresh.cleanup) clean();
  assert.equal(registry.snapshot('host', 'one'), null);
});

test('replacement retires an old pending request before native manager cleanup runs', async () => {
  const registry = createReceiptRegistry(installReadStateBridge), oldResponse = deferred(), backing = new Map();
  const manager = send => ({ cleanup: [], getHostId: () => 'host',
    threadStore: { params: { requestClient: { sendRequest: send } } },
    readState: { has: id => backing.get(id), set: (id, value) => backing.set(id, value), isReady: () => true, subscribe: () => () => {} },
    applySavedConversationReadState() {} });
  const old = manager(() => oldResponse.promise), fresh = manager(async () => page(state('fresh', false)));
  registry.install(old); const pending = old.threadStore.params.requestClient.sendRequest('thread/list', {});
  registry.install(fresh); await fresh.threadStore.params.requestClient.sendRequest('thread/list', {});
  oldResponse.resolve(page(state('old', true))); await pending;
  assert.equal(backing.get('one'), false); assert.equal(registry.snapshot('host', 'one').revision, 'fresh');
  for (const clean of [...old.cleanup, ...fresh.cleanup]) clean();
});
