import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sourcePath = '/tmp/verify/gateway-desktop/app-shared.js';
const functionNames = ['Vnn', 'Hnn', 'Etn', 'Ytn', 'Rnn', 'Ktn', 'zun', 'sB', 'Z4t', 'ah', '_de', 'ih', 'oh',
  'vde', 'gde', 'oB', 'X4t', '$4t', 'Qm', 'zB', 'Km', 'qtn', 'ktn', 'Gtn', 'hz', 'mz', 'pz'];

function extract(source) {
  const observerOffset = source.indexOf('cdn=class{hostId;logger;capture;requests=');
  assert.ok(observerOffset >= 0, 'Desktop turn observer source is unavailable');
  const warningOffset = source.indexOf('warn(e){this.logger.warning(', observerOffset);
  assert.ok(warningOffset >= 0, 'Desktop turn observer boundary is unavailable');
  const observerEnd = source.indexOf(')}}', warningOffset);
  assert.ok(observerEnd >= 0, 'Desktop turn observer end is unavailable');
  const snippets = functionNames.map(name => {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, 'Desktop state handler is unavailable: ' + name);
    const end = source.indexOf('function ', start + ('function ' + name + '(').length);
    assert.ok(end > start, 'Desktop state handler boundary is unavailable: ' + name);
    return { name, start, code: source.slice(start, end) };
  });
  // Only the acknowledgement's association expression, without Uun's runtime or app operations.
  const ackOffset = source.indexOf('let r=ce==null?zun(n,a,se.turn.id):null;');
  assert.ok(ackOffset >= 0, 'Desktop acknowledgement association is unavailable');
  const ackEnd = source.indexOf(',re()&&', ackOffset);
  assert.ok(ackEnd > ackOffset, 'Desktop acknowledgement association boundary is unavailable');
  const ackCode = 'function bindAck(n,a,se){const ce=null;' + source.slice(ackOffset, ackEnd) + ';return r;}';
  return { observerCode: source.slice(observerOffset + 4, observerEnd + 3), snippets, ackCode,
    provenance: [{ name: 'cdn', offset: observerOffset }, ...snippets.map(({ name, start }) => ({ name, offset: start })),
      { name: 'Uun acknowledgement association', offset: ackOffset }] };
}

function replay(extracted, threadId, turnId, events, ackFirst) {
  const clientId = 'selected-turn-observer-fixture';
  const pending = { turnId: null, status: 'inProgress', pendingUserMessageAdmission: false,
    params: { threadId, clientUserMessageId: clientId, input: [{ type: 'text', text: 'Owned fixture input' }] }, items: [] };
  const conversation = { id: threadId, turns: [pending], requests: [] };
  const counters = { accepted: 0, completed: 0, disposed: 0, loggerErrors: 0 };
  const completions = [];
  const logger = { warning() {}, error() { counters.loggerErrors++; }, info() {}, trace() {} };
  const globals = {
    // Array-backed fixture storage and non-association notification policy seams.
    Y: value => value, ch: () => null, Q4t: () => null, qf: () => false, np: value => value, rp: value => value,
    Enn: () => ({ threadId, input: [] }), DM: () => true,
    znn: { default: (items, predicate) => items.findLast(predicate) },
    Inn: () => ({ decision: 'DONT_NOTIFY', heartbeatAssistantMessage: null, shouldMarkUnread: false, hasRunnableQueuedFollowUp: false }),
    xnn: () => false, A8t: () => new Set(),
  };
  const sandbox = vm.createContext(globals);
  const Observer = vm.runInContext('(' + extracted.observerCode + ')', sandbox, { timeout: 1000 });
  const handlers = vm.runInContext(extracted.snippets.map(row => row.code).join('\n') + '\n' + extracted.ackCode +
    ';({Vnn,Rnn,Ktn,zun,sB,bindAck})', sandbox, { timeout: 1000 });
  const observer = new Observer('owned-fixture-host', logger, (_context, register) => register({
    isCurrent: () => true,
    onAccepted: id => { assert.equal(id, turnId); counters.accepted++; return true; },
    onCompleted: event => { assert.equal(event.turnId, turnId); counters.completed++; completions.push(event); },
    dispose: () => { counters.disposed++; },
  }));
  const request = observer.begin(threadId, () => true);
  const createId = () => 'owned-observer-item';
  const manager = {
    logger, getHostId: () => 'owned-fixture-host', getConversation: () => conversation, getConversationOrThrow: () => conversation,
    getStreamRole: () => ({ role: 'owner' }), supportsThreadTimeline: () => false,
    updateConversationState: (id, update) => { assert.equal(id, threadId); update(conversation); },
    broadcastConversationSnapshot() {},
  };
  const notificationContext = {
    threadStore: { conversations: new Map([[threadId, conversation]]), getThreadSummaries: () => [], getCachedConversations: () => [] },
    resumeNotificationBuffer: { buffer: () => false }, threadStartedNotificationDeferral: { bufferNotification: () => false },
    streamState: { shouldIgnoreThreadMutationAsFollower: () => false },
    itemStreamState: { drainBefore: () => false, clearTurnTerminalInputBuffers() {} },
    manualContextCompactions: { consumeSource: () => 'automatic', removePendingItemFromTurn() {} },
    unread: { discardTurn() {}, completeTurn() {} },
    getLastAgentMessageForTurn: () => null,
    updateTurnState: (id, selectedId, update) => {
      assert.equal(id, threadId);
      const turn = handlers.sB(conversation, selectedId, { logger, createId });
      assert.ok(turn, 'Captured notification lost its selected turn'); update(turn);
    },
    events: { emitNotification() {}, emitTurnCompleted: event => observer.observeCompletion(event) },
  };
  const context = { manager, notificationContext, createId,
    threadDiscovery: { bufferNotification: () => false }, observeTurnStart: (id, selectedId) => observer.observeStart(id, selectedId) };
  const acknowledge = () => {
    request.accepted(turnId);
    const associated = handlers.bindAck(conversation, clientId, { turn: { id: turnId, status: 'inProgress' } });
    assert.equal(associated, pending, 'Acknowledgement lost the pending user request');
    assert.equal(pending.turnId, turnId);
  };
  request.dispatched();
  if (ackFirst) acknowledge();
  let acknowledged = ackFirst;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    // Vnn calls observeTurnStart before Rnn, matching the first-party dispatcher.
    handlers.Vnn(context, event.method, structuredClone(event.params), null, index + 1, null);
    if (!acknowledged && event.method === 'turn/started') { acknowledge(); acknowledged = true; }
  }
  assert.equal(acknowledged, true);
  assert.equal(conversation.turns.length, 1, 'Compaction manufactured another UI turn');
  assert.equal(pending.turnId, turnId);
  assert.equal(pending.params.clientUserMessageId, clientId);
  assert.equal(pending.status, 'completed');
  assert.equal(handlers.zun(conversation, clientId, turnId), pending);
  const compact = pending.items.filter(item => item.type === 'contextCompaction');
  assert.ok(compact.length > 0 && compact.every(item => item.completed === true), 'Captured compaction did not complete in the selected turn');
  assert.deepEqual(counters, { accepted: 1, completed: 1, disposed: 1, loggerErrors: 0 });
  assert.equal(completions.length, 1);
  return { order: ackFirst ? 'ack-before-started' : 'started-before-ack', accepted: 1, completed: 1,
    disposed: 1, userTurns: 1, pendingRequestBoundToAcknowledgedTurn: true, completedCompactionItems: compact.length };
}

/** Replay captured SDK state in an isolated VM. Never attaches to or operates an app. */
export async function replaySelectedTurnObserver({ threadId, turnId, notifications }) {
  let source;
  try { source = await readFile(sourcePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { available: false, sourcePath, reason: 'Extracted desktop source is unavailable', appOperated: false };
    throw error;
  }
  assert.ok(typeof threadId === 'string' && threadId && typeof turnId === 'string' && turnId);
  assert.ok(Array.isArray(notifications), 'Captured SDK notifications must be an array');
  const events = notifications.filter(event => event?.params?.threadId === threadId &&
    (['turn/started', 'turn/completed'].includes(event.method) ||
      (['item/started', 'item/completed'].includes(event.method) && event.params.item?.type === 'contextCompaction')));
  for (const event of events) assert.equal(event.params.turn?.id ?? event.params.turnId, turnId,
    'Captured compaction lifecycle introduced a competing turn ID');
  assert.equal(events.filter(event => event.method === 'turn/started').length, 1, 'Capture must contain exactly one selected turn start');
  assert.equal(events.filter(event => event.method === 'turn/completed').length, 1, 'Capture must contain exactly one selected turn completion');
  assert.equal(events.find(event => event.method === 'turn/completed').params.turn.status, 'completed');
  assert.ok(events.some(event => event.method === 'item/started') && events.some(event => event.method === 'item/completed'),
    'Capture must contain real selected-turn compaction notifications');
  const extracted = extract(source);
  return { available: true, passed: true, sourcePath, sourceSha256: createHash('sha256').update(source).digest('hex'),
    actualFirstPartyFunctions: extracted.provenance, capturedNotificationsReplayed: events.length,
    fixtureStorage: 'array-backed conversation', modeledSeams: ['storage adapters', 'notification policy', 'unread state', 'empty stream buffers'],
    renderedAppTest: false, appOperated: false, productionChanged: false,
    scenarios: [replay(extracted, threadId, turnId, events, false), replay(extracted, threadId, turnId, events, true)] };
}
