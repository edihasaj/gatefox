/** Isolated renderer helper: translate durable unread receipts into the native store. */
export function installReadStateBridge({ client, saved, notify } = {}) {
  if (!client || typeof client.sendRequest !== 'function' || !saved || typeof saved.has !== 'function' ||
      typeof saved.set !== 'function' || typeof saved.isReady !== 'function' || typeof saved.subscribe !== 'function') {
    throw new TypeError('Unread read-state bridge requires the native client and saved store');
  }

  const nativeRequest = client.sendRequest;
  const nativeSet = saved.set;
  const receipts = new Map();
  const held = new Map();
  const epochs = new Map();
  const receiptEpochs = new Map();
  const intents = new Map();
  const projected = new Map();
  const applying = new Set();
  const limit = 200;
  let clock = 0;
  let evictionFloor = 0;
  let ready = safelyReady();
  let disposed = false;

  const validId = id => typeof id === 'string' && id.length > 0;
  const receipt = value => {
    if (!value || typeof value !== 'object' || typeof value.revision !== 'string' || !value.revision) return null;
    const first = value.firstUnread;
    if (first === null) return { firstUnread: null, revision: value.revision };
    if (!first || typeof first !== 'object') return null;
    if (first.type === 'threadStart') return { firstUnread: { type: 'threadStart' }, revision: value.revision };
    if (first.type === 'turn' && typeof first.turnId === 'string' && first.turnId) {
      return { firstUnread: { type: 'turn', turnId: first.turnId }, revision: value.revision };
    }
    return null;
  };
  const unreadOf = value => value.firstUnread !== null;
  const remember = (map, id, value) => {
    map.delete(id); map.set(id, value);
    if (map.size > limit) map.delete(map.keys().next().value);
  };
  const epoch = id => epochs.get(id) || evictionFloor;
  const advance = (id, local = false) => {
    clock += 1; epochs.delete(id); epochs.set(id, clock);
    if (epochs.size > limit) { const [old, value] = epochs.entries().next().value; epochs.delete(old); evictionFloor = Math.max(evictionFloor, value); }
    held.delete(id);
    if (local) projected.delete(id);
    return clock;
  };

  function safelyReady() {
    try { return saved.isReady() === true; } catch { return false; }
  }
  function isCurrent(id, start) { return !disposed && epoch(id) <= start; }
  function apply(id, value, guard) {
    if (!isCurrent(id, guard)) return;
    if (!ready && !safelyReady()) { remember(held, id, { value, guard }); return; }
    ready = true;
    const unread = unreadOf(value);
    if (projected.get(id) === value.revision) return;
    applying.add(id);
    try {
      let persisted = false, notified = typeof notify !== 'function';
      try {
        if (saved.has(id) === unread) persisted = true;
        else { nativeSet.call(saved, id, unread); persisted = true; }
      } catch { /* A later identical receipt may retry a transient store failure. */ }
      try { if (typeof notify === 'function') notify(id, unread); notified = true; } catch { /* Preserve the SDK response. */ }
      if (persisted && notified) remember(projected, id, value.revision);
    } finally { applying.delete(id); }
  }
  function accept(id, raw, start, authoritative = false) {
    const value = receipt(raw);
    if (!validId(id) || !value || disposed || (!authoritative && !isCurrent(id, start))) return;
    const sameRevision = receipts.get(id)?.revision === value.revision;
    if (sameRevision && intents.get(id)?.flight) return;
    start = advance(id);
    if (!sameRevision) {
      remember(receipts, id, value);
      remember(receiptEpochs, id, start);
    }
    apply(id, value, start);
    schedule(id);
  }
  function reflush() {
    if (disposed) return;
    ready = true;
    for (const [id, pending] of [...held]) {
      held.delete(id);
      apply(id, pending.value, pending.guard);
    }
  }
  function observeSaved(event) {
    if (disposed || !event || typeof event !== 'object') return;
    if (event.type === 'ready' && event.unreadThreadIds instanceof Set) { reflush(); return; }
    if (validId(event.threadId) && typeof event.hasUnreadTurn === 'boolean' && !applying.has(event.threadId)) advance(event.threadId);
  }
  const unsubscribe = saved.subscribe(observeSaved);

  function request(method, params, ...rest) {
    const launch = clock;
    let result;
    try { result = nativeRequest.call(this, method, params, ...rest); }
    catch (error) { throw error; }
    return Promise.resolve(result).then(value => {
      if (!disposed) { try { ingest(method, params, value, launch); } catch {} }
      return value;
    });
  }
  function ingest(method, params, result, launch) {
    if (method === 'thread/list' && Array.isArray(result?.data) && result?.readStates && typeof result.readStates === 'object') {
      for (const row of result.data) {
        const id = row?.id;
        if (validId(id) && !intents.get(id)?.flight) accept(id, result.readStates[id], launch);
      }
      return;
    }
    const requested = params?.threadId;
    if (!validId(requested)) return;
    if (method === 'thread/read' && result?.thread?.id === requested && !intents.get(requested)?.flight) accept(requested, result.readState, launch);
    if (method === 'thread/readState/update') accept(requested, result?.readState, launch);
  }
  function settle(id, flight, result) {
    if (disposed) return;
    const intent = intents.get(id);
    if (!intent || intent.flight !== flight) return;
    intent.flight = null;
    const value = receipt(result?.readState);
    const accepted = value && (receiptEpochs.get(id) || 0) <= flight.receiptEpoch;
    if (accepted) {
      remember(receipts, id, value);
      remember(receiptEpochs, id, ++clock);
    }
    if (intent.generation > flight.generation) schedule(id);
    else intents.delete(id);
  }
  function conflict(id, flight, error) {
    if (disposed) return;
    const intent = intents.get(id);
    if (!intent || intent.flight !== flight) return;
    intent.flight = null;
    const value = error?.data?.reason === 'readStateConflict' && receipt(error.data.readState);
    const accepted = value && (receiptEpochs.get(id) || 0) <= flight.receiptEpoch;
    if (accepted) {
      const current = isCurrent(id, flight.launch);
      remember(receipts, id, value);
      const guard = current ? advance(id) : ++clock;
      remember(receiptEpochs, id, guard);
      if (current) apply(id, value, guard);
    }
    // A conflict settles this action. Only a distinct later local action may use its receipt.
    if (intent.generation > flight.generation && value) schedule(id);
    else intents.delete(id);
  }
  function schedule(id) {
    const intent = intents.get(id);
    const known = receipts.get(id);
    if (!intent || intent.flight || !known) return;
    if (unreadOf(known) === intent.unread) { intents.delete(id); return; }
    const flight = { generation: intent.generation, launch: clock, receiptEpoch: receiptEpochs.get(id) || 0 };
    intent.flight = flight;
    const params = { threadId: id, operation: { type: intent.unread ? 'unread' : 'read' }, expectedRevision: known.revision };
    let update;
    try { update = client.sendRequest('thread/readState/update', params); }
    catch (error) { conflict(id, flight, error); return; }
    Promise.resolve(update).then(
      result => settle(id, flight, result),
      error => conflict(id, flight, error),
    );
  }
  function mark(threadId, unread) {
    if (disposed || !validId(threadId) || typeof unread !== 'boolean') return;
    const known = receipts.get(threadId);
    const generation = advance(threadId, true);
    const prior = intents.get(threadId);
    if (prior && prior.unread === unread) return;
    if (!known && !prior) return;
    remember(intents, threadId, { unread, generation, flight: prior?.flight || null });
    schedule(threadId);
  }
  function observe(message) {
    if (disposed || message?.method !== 'thread/readState/changed') return;
    const params = message.params;
    if (validId(params?.threadId)) accept(params.threadId, params.readState, clock, true);
  }
  function localSet(...args) {
    const result = nativeSet.apply(this, args);
    const [id, unread] = args;
    if (!disposed && validId(id) && typeof unread === 'boolean' && !applying.has(id)) advance(id, true);
    return result;
  }
  client.sendRequest = request;
  saved.set = localSet;
  return {
    observe,
    mark,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (client.sendRequest === request) client.sendRequest = nativeRequest;
      if (saved.set === localSet) saved.set = nativeSet;
      if (typeof unsubscribe === 'function') unsubscribe();
      held.clear(); receipts.clear(); epochs.clear(); receiptEpochs.clear(); intents.clear(); projected.clear(); applying.clear();
    },
  };
}
