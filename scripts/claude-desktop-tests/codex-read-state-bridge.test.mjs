import assert from 'node:assert/strict';
import test from 'node:test';
import { installReadStateBridge } from '../codex-unread-trial/read-state-bridge.mjs';

const unread = (revision = 'v1') => ({ firstUnread: { type: 'turn', turnId: 'turn-1' }, revision });
const read = (revision = 'v2') => ({ firstUnread: null, revision });
const deferred = () => { let resolve, reject; return { promise: new Promise((a, b) => { resolve = a; reject = b; }), resolve, reject }; };

function fixture({ ready = true, request, nativeSet, notify } = {}) {
  const values = new Map(), listeners = new Set(), writes = [], calls = [], notices = [];
  const saved = {
    has(id) { return values.get(id); },
    set(id, value, source) { writes.push([id, value, source]); if (nativeSet) return nativeSet(id, value, source); values.set(id, value); },
    isReady() { return ready; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const client = { sendRequest(method, params, ...rest) { calls.push({ method, params, rest, self: this }); return request?.(method, params, ...rest) ?? Promise.resolve({}); } };
  return { values, listeners, writes, calls, notices, saved, client, bridge: installReadStateBridge({ client, saved, notify: notify ?? ((id, value) => notices.push([id, value])) }) };
}

test('projects only eligible list rows, including threadStart, and does not ack raw store writes', async () => {
  const f = fixture({ request(method) {
    return Promise.resolve(method === 'thread/list' ? { data: [{ id: 'one' }, { id: 'two' }], readStates: {
      one: unread(), two: { firstUnread: { type: 'threadStart' }, revision: 'start' }, outside: unread('outside'),
    } } : {});
  } });
  await f.client.sendRequest('thread/list', {});
  assert.equal(f.values.get('one'), true);
  assert.equal(f.values.get('two'), true);
  assert.equal(f.values.has('outside'), false);
  assert.deepEqual(f.notices, [['one', true], ['two', true]]);
  f.saved.set('housekeeping', false, 'native-source');
  await Promise.resolve();
  assert.equal(f.calls.filter(call => call.method === 'thread/readState/update').length, 0);
});

test('rejects malformed receipts and preserves native request args, result, this and errors', async () => {
  const raw = { data: [{ id: 'one' }], readStates: { one: { firstUnread: { type: 'turn' }, revision: '' } } };
  const f = fixture({ request: () => Promise.resolve(raw) });
  assert.equal(await f.client.sendRequest('thread/list', { limit: 1 }, 'native-extra'), raw);
  assert.equal(f.calls[0].self, f.client);
  assert.deepEqual(f.calls[0].rest, ['native-extra']);
  assert.equal(f.values.has('one'), false);
  const error = new Error('native failure');
  const failing = fixture({ request: () => Promise.reject(error) });
  await assert.rejects(failing.client.sendRequest('anything', {}), value => value === error);
  failing.bridge.dispose();
});

test('does not let a stale list response overwrite a local action before the first receipt', async () => {
  const pending = deferred();
  const f = fixture({ request: () => pending.promise });
  const list = f.client.sendRequest('thread/list', {});
  f.saved.set('one', false, 'native-source');
  f.bridge.mark('one', false);
  pending.resolve({ data: [{ id: 'one' }], readStates: { one: unread() } });
  await list;
  assert.equal(f.values.get('one'), false);
  assert.equal(f.calls.filter(call => call.method === 'thread/readState/update').length, 0);
});

test('serializes a newer local intent after an old acknowledgement without duplicate RPCs', async () => {
  const ack = deferred();
  const f = fixture({ request(method, params) {
    if (method === 'thread/list') return Promise.resolve({ data: [{ id: 'one' }], readStates: { one: unread('v1') } });
    if (params.operation.type === 'read') return ack.promise;
    return Promise.resolve({ readState: unread('v3') });
  } });
  await f.client.sendRequest('thread/list', {});
  f.saved.set('one', false); f.bridge.mark('one', false);
  f.saved.set('one', false); f.bridge.mark('one', false);
  f.saved.set('one', true); f.bridge.mark('one', true);
  assert.equal(f.calls.filter(call => call.method === 'thread/readState/update').length, 1);
  ack.resolve({ readState: read('v2') });
  await new Promise(resolve => setImmediate(resolve));
  const updates = f.calls.filter(call => call.method === 'thread/readState/update');
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1].params, { threadId: 'one', operation: { type: 'unread' }, expectedRevision: 'v2' });
  assert.equal(f.values.get('one'), true);
});

test('uses a conflict receipt once for a newer action, then honors readiness and disposal', async () => {
  const conflict = Object.assign(new Error('conflict'), { data: { reason: 'readStateConflict', readState: read('v2') } });
  let first = true;
  const f = fixture({ ready: false, request(method, params) {
    if (method === 'thread/list') return Promise.resolve({ data: [{ id: 'one' }], readStates: { one: unread('v1') } });
    if (first) { first = false; return Promise.reject(conflict); }
    return Promise.resolve({ readState: unread('v3') });
  } });
  await f.client.sendRequest('thread/list', {});
  assert.equal(f.values.has('one'), false);
  for (const listener of f.listeners) listener({ type: 'ready', unreadThreadIds: new Set(['one']) });
  assert.equal(f.values.get('one'), true);
  f.saved.set('one', false); f.bridge.mark('one', false);
  f.saved.set('one', true); f.bridge.mark('one', true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.method === 'thread/readState/update').length, 2);
  f.bridge.dispose();
  assert.equal(f.client.sendRequest.name, 'sendRequest');
  assert.equal(f.saved.set.name, 'set');
  for (const listener of f.listeners) listener({ threadId: 'one', hasUnreadTurn: false });
});

test('notification and native-store failures never reject a successful SDK response', async () => {
  const result = { data: [{ id: 'one' }], readStates: { one: unread() } };
  const f = fixture({ request: () => Promise.resolve(result), nativeSet: () => { throw new Error('store'); }, notify: () => { throw new Error('notify'); } });
  assert.equal(await f.client.sendRequest('thread/list', {}), result);
  f.bridge.dispose();
});
