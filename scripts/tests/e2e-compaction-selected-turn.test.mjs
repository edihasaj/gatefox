import assert from 'node:assert/strict';
import test from 'node:test';
import { access } from 'node:fs/promises';
import { assertSelectedTurnEvents } from '../e2e-compaction-selected-turn.mjs';
import { replaySelectedTurnObserver } from '../e2e-compaction-ui-observer.mjs';

const event = (method, turnId = 'user-turn', status = 'completed') => ({ method, params: {
  threadId: 'thread', ...(method.startsWith('turn/') ? { turn: { id: turnId, status } }
    : { turnId, item: { id: 'compact-item', type: 'contextCompaction' } }),
} });
const valid = () => [event('turn/started'), event('item/started'), event('item/completed'), event('turn/completed')];

test('a compacting SDK user turn stays on the ACK ID', () => {
  assert.deepEqual(assertSelectedTurnEvents(valid(), 'thread', 'user-turn'), {
    turnId: 'user-turn', oneSdkTurn: true, compactItemsOnAcknowledgedTurn: 2, sdkStatus: 'completed',
  });
});
test('a separate manual compact lifecycle fails association even when the answer succeeds', () => {
  const manual = valid().map(e => event(e.method, 'manual-turn'));
  assert.throws(() => assertSelectedTurnEvents([...manual, ...valid()], 'thread', 'user-turn'), /one real SDK turn start/);
});
test('a compaction item with the wrong ID cannot masquerade as a selected user turn', () => {
  const sequence = valid(); sequence[1] = event('item/started', 'manual-turn');
  assert.throws(() => assertSelectedTurnEvents(sequence, 'thread', 'user-turn'), /Compaction ID/);
});
test('an ACK with an unrelated ID fails despite a consistent notification sequence', () => {
  assert.throws(() => assertSelectedTurnEvents(valid(), 'thread', 'different-ack'), /Started ID/);
});
test('duplicate terminal events fail rather than silently matching the first', () => {
  assert.throws(() => assertSelectedTurnEvents([...valid(), event('turn/completed')], 'thread', 'user-turn'), /one real SDK turn completion/);
});
test('a failed or interrupted compact may lack item completion but retains its user turn', () => {
  for (const status of ['failed', 'interrupted']) {
    const sequence = [event('turn/started'), event('item/started'), event('turn/completed', 'user-turn', status)];
    assert.equal(assertSelectedTurnEvents(sequence, 'thread', 'user-turn', { status }).sdkStatus, status);
  }
});
test('successful compaction requires its actual completed item', () => {
  assert.throws(() => assertSelectedTurnEvents([event('turn/started'), event('item/started'), event('turn/completed')], 'thread', 'user-turn'), /Missing real compaction completion/);
});
test('compaction after terminal state and unnecessary short-history compaction fail', () => {
  assert.throws(() => assertSelectedTurnEvents([event('turn/started'), event('turn/completed'), event('item/started'), event('item/completed')], 'thread', 'user-turn'), /outside the acknowledged turn/);
  assert.throws(() => assertSelectedTurnEvents(valid(), 'thread', 'user-turn', { compact: false }), /Unexpected compaction/);
});

test('actual extracted desktop handlers retain ACK association in both arrival orders', async t => {
  if (!await access('/tmp/verify/gateway-desktop/app-shared.js').then(() => true, () => false)) {
    t.skip('Extracted first-party desktop source is unavailable'); return;
  }
  const notifications = valid(); notifications[0].params.turn.status = 'inProgress';
  const result = await replaySelectedTurnObserver({ threadId: 'thread', turnId: 'user-turn', notifications });
  assert.equal(result.available, true); assert.equal(result.passed, true);
  assert.deepEqual(result.scenarios.map(s => [s.order, s.accepted, s.completed, s.userTurns]), [
    ['started-before-ack', 1, 1, 1], ['ack-before-started', 1, 1, 1],
  ]);
  await assert.rejects(replaySelectedTurnObserver({ threadId: 'thread', turnId: 'user-turn',
    notifications: [...notifications, event('item/started', 'manual-turn')] }), /competing turn ID/);
});
