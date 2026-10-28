import assert from 'node:assert/strict';
import test from 'node:test';
import { installReadStateBridge } from '../codex-unread-trial/read-state-bridge.mjs';

const receipt = revision => ({ revision, firstUnread: { type: 'turn', turnId: 'A' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
async function fixture() {
  const values = new Map(), calls = [];
  const state = { receipt: receipt('R1'), tail: { id: 'A', status: 'completed' },
    view: { visible: true, generation: 0, history: { isComplete: true, turns: [{ turnId: 'A', status: 'completed' }] } } };
  const saved = { has: id => values.get(id), set: (id, value) => values.set(id, value), isReady: () => true, subscribe: () => () => {} };
  const client = { async sendRequest(method, params) {
    calls.push({ method, params });
    if (method === 'thread/list') return { data: [{ id: 'one' }], readStates: { one: structuredClone(state.receipt) } };
    if (method === 'thread/turns/list') return { data: [structuredClone(state.tail)] };
    if (method === 'thread/read') {
      await state.readGate?.promise;
      return { thread: { id: 'one' }, readState: structuredClone(state.receipt) };
    }
    if (state.failUpdate) throw Error('Unavailable');
    if (state.conflictUpdate) throw Object.assign(Error('Conflict'), { data: { reason: 'readStateConflict', readState: structuredClone(state.receipt) } });
    state.receipt = { revision: 'ACK', firstUnread: params.operation.type === 'unread' ? { type: 'threadStart' } : null };
    return { readState: structuredClone(state.receipt) };
  } };
  const bridge = installReadStateBridge({ client, saved });
  await client.sendRequest('thread/list', {});
  const commit = () => { saved.set('one', false); bridge.mark('one', false); };
  return { state, calls, client, saved, bridge, commit, prove: () => bridge.readVisible('one', () => state.view, commit) };
}

test('proof validates latest terminal and receipt without self-invalidating through wrapper ingestion', async () => {
  const f = await fixture();
  assert.equal(await f.prove(), true); await tick();
  assert.equal(f.state.receipt.firstUnread, null);
  assert.deepEqual(f.calls.slice(1).map(call => call.method), ['thread/turns/list', 'thread/read', 'thread/readState/update']);
  assert.equal(f.calls.at(-1).params.expectedRevision, 'R1'); f.bridge.dispose();
});

test('new receipt during the proof is not acknowledged even if the latest loaded ID still matches', async () => {
  const f = await fixture(); f.state.readGate = deferred();
  const proof = f.prove(); await tick();
  f.state.receipt = receipt('R2'); f.state.readGate.resolve();
  assert.equal(await proof, false);
  assert.equal(f.calls.some(call => call.method === 'thread/readState/update'), false); f.bridge.dispose();
});

test('focus loss, incomplete items, trailing pending turn, and manager disposal all fail closed', async () => {
  for (const change of [
    f => { f.state.view.visible = false; },
    f => { f.state.view.history.isComplete = false; f.state.view.generation++; },
    f => { f.state.view.history.turns.push({ turnId: null, status: 'inProgress' }); f.state.view.generation++; },
    f => { f.bridge.dispose(); },
  ]) {
    const f = await fixture(); f.state.readGate = deferred();
    const proof = f.prove(); await tick(); change(f); f.state.readGate.resolve();
    assert.equal(await proof, false); assert.equal(f.calls.some(call => call.method === 'thread/readState/update'), false);
    f.bridge.dispose();
  }
});

test('manual unread arriving during the proof prevents its late read commit', async () => {
  const f = await fixture(); f.state.readGate = deferred();
  const proof = f.prove(); await tick();
  f.saved.set('one', true); f.bridge.mark('one', true); await tick(); f.state.readGate.resolve();
  assert.equal(await proof, false); assert.equal(f.state.receipt.firstUnread.type, 'threadStart');
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/readState/update').map(call => call.params.operation.type), ['unread']);
  f.bridge.dispose();
});

test('a failed manual-unread acknowledgement stays pending and blocks auto-read until refresh retries it', async () => {
  const f = await fixture(); f.state.failUpdate = true;
  f.saved.set('one', true); f.bridge.mark('one', true); await tick();
  assert.equal(await f.prove(), false);
  f.state.failUpdate = false; await f.client.sendRequest('thread/list', {}); await tick();
  assert.equal(f.state.receipt.firstUnread.type, 'threadStart'); f.bridge.dispose();
});

test('a concurrent publication cannot discard manual-unread intent on a valid CAS conflict', async () => {
  const f = await fixture(); f.state.receipt = receipt('R2'); f.state.conflictUpdate = true;
  f.saved.set('one', true); f.bridge.mark('one', true); await tick();
  assert.equal(f.bridge.snapshot('one').revision, 'R2'); assert.equal(await f.prove(), false);
  assert.equal(f.saved.has('one'), true);
  f.state.conflictUpdate = false; await f.client.sendRequest('thread/list', {}); await tick();
  assert.equal(f.state.receipt.firstUnread.type, 'threadStart'); f.bridge.dispose();
});

test('asynchronous history capabilities are disposed and a hydration change invalidates their snapshot', async () => {
  const f = await fixture(); const historyGate = deferred(); let disposed = 0;
  const proof = f.bridge.readVisible('one', () => f.state.view, f.commit, () => historyGate.promise);
  await tick(); f.state.view.generation++;
  historyGate.resolve({ isComplete: true, turns: [{ turnId: 'A', status: 'completed' }], [Symbol.dispose]() { disposed++; } });
  assert.equal(await proof, false); assert.equal(disposed, 1);
  assert.equal(f.calls.some(call => call.method === 'thread/readState/update'), false); f.bridge.dispose();
});

test('fully loaded latest-turn items prove reading without loading every older turn', async () => {
  const f = await fixture();
  f.state.view.history = { isComplete: false, turns: [{ turnId: 'A', status: 'completed',
    itemsPagination: { hasLoadedOldest: true, olderCursor: null, isLoadingOlder: false } }] };
  assert.equal(await f.prove(), true); await tick();
  assert.equal(f.state.receipt.firstUnread, null); f.bridge.dispose();
});

test('incomplete, evicted or reconnecting latest items never acknowledge a partial transcript', async () => {
  for (const change of [{ hasLoadedOldest: false }, { olderCursor: 'older' }, { isLoadingOlder: true }, { evicted: true }, { reconnect: {} }]) {
    const f = await fixture();
    f.state.view.history = { isComplete: false, turns: [{ turnId: 'A', status: 'completed',
      itemsPagination: { hasLoadedOldest: true, olderCursor: null, isLoadingOlder: false, ...change } }] };
    assert.equal(await f.prove(), false);
    assert.equal(f.calls.some(call => call.method === 'thread/readState/update'), false); f.bridge.dispose();
  }
});
