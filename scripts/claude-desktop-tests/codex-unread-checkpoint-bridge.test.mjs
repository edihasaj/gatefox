import assert from 'node:assert/strict';
import test from 'node:test';
import { installReadStateBridge } from '../codex-unread-trial/read-state-bridge.mjs';
import { createReceiptRegistry } from '../codex-unread-trial/receipt-registry.mjs';

const state = (revision, unread = true) => ({ revision, firstUnread: unread ? { type: 'turn', turnId: 'A' } : null });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
// Contract fake only: real transactional persistence is covered by verify-checkpoints.mjs.
function journal() {
  const rows = new Map(); let sequence = 0;
  return { rows, capture: async () => sequence, dispose() {}, fresh: async id => { if (!rows.has(id)) rows.set(id, { revision: null, unread: false, sequence: ++sequence }); },
    forget: async id => { rows.delete(id); sequence++; },
    async project(id, receipt, local, fence, choice) {
      const prior = rows.get(id);
      if (prior?.revision === receipt.revision && (choice === undefined || prior.unread === choice)) return prior.unread;
      if (choice !== undefined && prior && prior.revision !== receipt.revision) return undefined;
      if (prior?.sequence > fence) return undefined;
      const unread = choice ?? (prior ? receipt.firstUnread !== null : local ?? receipt.firstUnread !== null);
      rows.set(id, { revision: receipt.revision, unread, sequence: ++sequence }); return unread;
    } };
}
function fixture(checkpoints = journal()) {
  const values = new Map([['one', false]]), calls = [], notices = [], listeners = new Set();
  const server = { receipt: state('R1'), ready: true };
  const saved = { has: id => values.get(id), set: (id, value) => values.set(id, value), isReady: () => server.ready,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const client = { async sendRequest(method, params) {
    calls.push({ method, params }); await server.gate?.promise;
    if (method === 'thread/list') return { data: [{ id: 'one' }], readStates: { one: structuredClone(server.receipt) } };
    if (method === 'thread/read') return { thread: { id: params.threadId }, readState: structuredClone(server.receipt) };
    if (method === 'thread/start') return { thread: { id: 'new' } };
    if (method === 'thread/readState/update') {
      await server.ackGate?.promise;
      server.receipt = { revision: `ACK-${server.receipt.revision}`, firstUnread: params.operation.type === 'unread' ? { type: 'threadStart' } : null };
      return { readState: structuredClone(server.receipt) };
    }
    return {};
  } };
  const bridge = installReadStateBridge({ client, saved, checkpoints, notify: (id, value) => notices.push([id, value]) });
  return { bridge, client, saved, values, calls, notices, checkpoints, server, listeners,
    list: () => client.sendRequest('thread/list', {}),
    mark(unread) { saved.set('one', unread); bridge.mark('one', unread); } };
}

test('migration preserves native choices without ACK; later revision restores missed completion after restart', async () => {
  const f = fixture(); await f.list();
  assert.equal(f.saved.has('one'), false); assert.equal(f.calls.length, 1);
  f.bridge.dispose();
  const reopened = fixture(f.checkpoints); await reopened.list();
  assert.equal(reopened.saved.has('one'), false);
  reopened.server.receipt = state('R2'); await reopened.list();
  assert.equal(reopened.saved.has('one'), true);
  reopened.mark(false); await tick(); await tick();
  assert.equal(reopened.checkpoints.rows.get('one').unread, false);
  await reopened.list(); assert.equal(reopened.saved.has('one'), false);
  assert.equal(reopened.calls.filter(call => call.method === 'thread/readState/update').length, 1);
  reopened.bridge.dispose();
});

test('new threads use receipts on first completion; deleting removes their checkpoint', async () => {
  const f = fixture(); await f.client.sendRequest('thread/start', {});
  assert.equal(f.checkpoints.rows.get('new').revision, null);
  await f.client.sendRequest('thread/read', { threadId: 'new' });
  assert.equal(f.saved.has('new'), true);
  await f.client.sendRequest('thread/delete', { threadId: 'new' });
  assert.equal(f.checkpoints.rows.has('new'), false); f.bridge.dispose();
});

test('a first-seen remote chat remains an ambiguous native baseline without a witnessed start', async () => {
  const f = fixture(); f.server.receipt = { revision: 'remote-R1', firstUnread: { type: 'threadStart' } };
  await f.list(); assert.equal(f.saved.has('one'), false);
  assert.equal(f.calls.some(call => call.method === 'thread/readState/update'), false);
  f.server.receipt = state('remote-R2'); await f.list(); assert.equal(f.saved.has('one'), true); f.bridge.dispose();
});

test('a semantic choice persists even when the SDK already reports that state', async () => {
  for (const unread of [true, false]) {
    const f = fixture(); f.values.set('one', !unread);
    f.server.receipt = { revision: 'R1', firstUnread: unread ? { type: 'threadStart' } : null };
    await f.list(); f.mark(unread); await tick(); await tick();
    await f.list(); assert.equal(f.saved.has('one'), unread);
    assert.equal(f.checkpoints.rows.get('one').unread, unread);
    assert.equal(f.calls.some(call => call.method === 'thread/readState/update'), false); f.bridge.dispose();
  }
});

test('a failed no-op write retains the explicit choice until a later refresh retries it', async () => {
  for (const unread of [true, false]) {
    const f = fixture(); f.values.set('one', !unread);
    f.server.receipt = { revision: 'R1', firstUnread: unread ? { type: 'threadStart' } : null };
    await f.list(); const original = f.checkpoints.project; let fail = true;
    f.checkpoints.project = (...args) => fail && args[4] !== undefined ? Promise.reject(Error('Storage error')) : original(...args);
    f.mark(unread); await tick(); await tick();
    await f.list(); assert.equal(f.saved.has('one'), unread);
    fail = false; await f.list(); await tick(); await tick();
    assert.equal(f.checkpoints.rows.get('one').unread, unread);
    assert.equal(f.calls.some(call => call.method === 'thread/readState/update'), false); f.bridge.dispose();
  }
});

test('duplicate semantic read cancels and replaces its pending no-op disk transaction', async () => {
  const f = fixture(); f.values.set('one', true); f.server.receipt = state('R1', false); await f.list();
  const original = f.checkpoints.project, entered = deferred(), gate = deferred(); let first = true;
  f.checkpoints.project = async (...args) => {
    if (first && args[4] === false) {
      first = false; entered.resolve(); await gate.promise;
      if (args[5].aborted) throw Error('Transaction aborted');
    }
    return original(...args);
  };
  f.mark(false); await entered.promise; f.mark(false); gate.resolve(); await tick(); await tick();
  await f.list(); assert.equal(f.saved.has('one'), false);
  assert.equal(f.checkpoints.rows.get('one').unread, false);
  assert.equal(f.calls.some(call => call.method === 'thread/readState/update'), false); f.bridge.dispose();
});

test('manual unread behind a read ACK survives persistence and the next refresh', async () => {
  const f = fixture(); f.values.set('one', true); await f.list();
  f.server.ackGate = deferred(); f.mark(false); await tick(); f.mark(true);
  f.server.ackGate.resolve(); await tick(); await tick(); await tick();
  assert.equal(f.server.receipt.firstUnread.type, 'threadStart');
  await f.list(); assert.equal(f.saved.has('one'), true);
  assert.equal(f.checkpoints.rows.get('one').unread, true); f.bridge.dispose();
});

test('persistence failures preserve the native result and cannot authorize ACKs', async () => {
  const f = fixture({ ...journal(), project: async () => { throw Error('Storage unavailable'); } });
  await f.list(); f.mark(false); await tick();
  assert.equal(f.saved.has('one'), false); assert.equal(f.bridge.snapshot('one'), null);
  assert.equal(f.calls.length, 1); f.bridge.dispose();
});

test('a read during first migration aborts the stale durable projection before retrying without ACK', async () => {
  const checkpoints = journal(), gate = deferred(), entered = deferred();
  const original = checkpoints.project; let first = true, canceled = false;
  checkpoints.project = async (...args) => {
    if (first) {
      first = false; entered.resolve(); await gate.promise;
      if (args[5].aborted) { canceled = true; throw Error('Transaction aborted'); }
    }
    return original(...args);
  };
  const f = fixture(checkpoints); f.values.set('one', true);
  const listing = f.list(); await entered.promise;
  f.mark(false); gate.resolve(); await listing; await tick(); await tick();
  assert.equal(canceled, true); assert.equal(checkpoints.rows.get('one').unread, false);
  await f.list(); assert.equal(f.saved.has('one'), false);
  assert.equal(f.calls.some(call => call.method === 'thread/readState/update'), false); f.bridge.dispose();
});

test('not-ready receipts refresh after readiness without accepting unjournaled pushes', async () => {
  const f = fixture(); f.server.ready = false; await f.list();
  assert.equal(f.bridge.snapshot('one'), null);
  f.server.ready = true;
  for (const listener of f.listeners) listener({ type: 'ready', unreadThreadIds: new Set() });
  await tick(); await tick();
  assert.equal(f.bridge.snapshot('one').revision, 'R1');
  f.server.receipt = state('R2');
  f.bridge.observe({ method: 'thread/readState/changed', params: { threadId: 'one', readState: state('stale-push') } });
  await tick(); await tick();
  assert.equal(f.bridge.snapshot('one').revision, 'R2'); assert.equal(f.saved.has('one'), true); f.bridge.dispose();
});

test('registry skips account-unaware legacy facades and unavailable persistence', () => {
  for (const withScope of [true, false]) {
    let installed = 0;
    const manager = { getHostId: () => 'host', cleanup: [], applySavedConversationReadState() {},
      threadStore: { params: { requestClient: { sendRequest() {} } } },
      readState: { has() {}, set() {}, isReady() {}, subscribe() {}, ...(withScope ? { receiptCheckpointScope: () => 'scope' } : {}) } };
    const registry = createReceiptRegistry(() => { installed++; }, () => { throw Error('No IDB'); });
    registry.install(manager); assert.equal(installed, 0); assert.equal(manager.cleanup.length, 0);
  }
});
