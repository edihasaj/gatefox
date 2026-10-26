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
  const listeners = new Set();
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
  function announce(id, value) {
    if (disposed || receipts.get(id) !== value) return;
    for (const listener of [...listeners]) {
      if (disposed || receipts.get(id) !== value) return;
      try { listener(id); } catch { /* Native observers cannot fail an RPC. */ }
    }
  }
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
      if (!isCurrent(id, guard)) return;
      try { if (typeof notify === 'function') notify(id, unread); notified = true; } catch { /* Preserve the SDK response. */ }
      if (!isCurrent(id, guard)) return;
      if (persisted && notified) remember(projected, id, value.revision);
    } finally { applying.delete(id); }
  }
  function accept(id, raw, start, authoritative = false) {
    const value = receipt(raw);
    if (!validId(id) || !value || disposed || (!authoritative && !isCurrent(id, start))) return;
    const sameRevision = receipts.get(id)?.revision === value.revision;
    if (sameRevision && intents.get(id)?.flight) return;
    start = advance(id);
    let accepted = receipts.get(id);
    if (!sameRevision) {
      remember(receipts, id, value);
      remember(receiptEpochs, id, start);
      accepted = value;
    }
    const pending = intents.get(id);
    if (pending?.unread && !pending.flight) pending.revision = value.revision;
    if (!pending?.unread) apply(id, value, start);
    // An identical refresh still invalidates probes via advance(); wake them to retry.
    announce(id, accepted);
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
    const newer = intent.generation > flight.generation;
    // Retire this action before projecting; a synchronous native read may create its replacement.
    if (!newer) intents.delete(id);
    const value = receipt(result?.readState);
    const accepted = value && (receiptEpochs.get(id) || 0) <= flight.receiptEpoch;
    if (accepted) {
      remember(receipts, id, value);
      remember(receiptEpochs, id, ++clock);
      if (newer && intent.revision === flight.revision) intent.revision = value.revision;
      if (!newer && isCurrent(id, flight.launch)) apply(id, value, advance(id));
      announce(id, value);
    }
    schedule(id);
  }
  function conflict(id, flight, error) {
    if (disposed) return;
    const intent = intents.get(id);
    if (!intent || intent.flight !== flight) return;
    intent.flight = null;
    const newer = intent.generation > flight.generation;
    const value = error?.data?.reason === 'readStateConflict' && receipt(error.data.readState);
    // Preserve explicit unread across both transport failures and concurrent publications.
    // A later receipt/action retries it; do not spin a CAS loop or project it locally as read.
    if (intent.unread) {
      if (value && (receiptEpochs.get(id) || 0) <= flight.receiptEpoch) {
        remember(receipts, id, value);
        remember(receiptEpochs, id, ++clock);
        intent.revision = value.revision;
        announce(id, value);
      }
      if (newer) schedule(id); // A distinct queued action may run once; the failed action never loops.
      return;
    }
    if (!newer) intents.delete(id);
    const accepted = value && (receiptEpochs.get(id) || 0) <= flight.receiptEpoch;
    if (accepted) {
      const current = isCurrent(id, flight.launch);
      remember(receipts, id, value);
      const guard = current ? advance(id) : ++clock;
      remember(receiptEpochs, id, guard);
      // Never retarget an old read onto unseen work.
      if (current) apply(id, value, guard);
      announce(id, value);
    }
    schedule(id);
  }
  function schedule(id) {
    const intent = intents.get(id);
    const known = receipts.get(id);
    if (!intent || intent.flight || !known) return;
    if (intent.revision !== known.revision) {
      if (intent.unread) intent.revision = known.revision;
      else { intents.delete(id); return; }
    }
    // Manual unread must become threadStart, not disappear into a turn-based receipt.
    if (intent.unread ? known.firstUnread?.type === 'threadStart' : !unreadOf(known)) { intents.delete(id); return; }
    const flight = { generation: intent.generation, launch: clock, receiptEpoch: receiptEpochs.get(id) || 0, revision: known.revision };
    intent.flight = flight;
    const params = { threadId: id, operation: { type: intent.unread ? 'unread' : 'read' }, expectedRevision: known.revision };
    let update;
    try { update = nativeRequest.call(client, 'thread/readState/update', params); }
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
    if (prior && prior.unread === unread && prior.revision === known?.revision) return;
    if (!known && !prior && !unread) return;
    remember(intents, threadId, { unread, generation, revision: known?.revision, flight: prior?.flight || null });
    // An explicit unread need not wait for the next sidebar refresh to find its CAS token.
    if (!known && unread) request.call(client, 'thread/read', { threadId, includeTurns: false }).catch(() => {});
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
  async function readVisible(id, inspect, commit, loadHistory = () => inspect()?.history) {
    const known = receipts.get(id), guard = epoch(id);
    if (!known || !unreadOf(known) || intents.get(id)?.unread || disposed) return false;
    let expired = false;
    const current = () => !expired && !disposed && epoch(id) === guard && receipts.get(id)?.revision === known.revision && !intents.get(id)?.unread;
    let timer;
    try {
      // Raw requests: ingesting a probe would advance the action epoch and invalidate itself.
      const probe = async () => {
        const initial = inspect();
        if (initial?.visible !== true) return false;
        const generation = initial.generation;
        const latest = await nativeRequest.call(client, 'thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        if (!current()) return false;
        // Cu exposes an asynchronous RPC capability, not the original manager's synchronous method.
        let resource, history;
        try {
          resource = await loadHistory();
          const loaded = resource?.turns?.at(-1);
          history = { complete: resource?.isComplete === true, turnId: loaded?.turnId, status: loaded?.status };
        } finally { resource?.[Symbol.dispose]?.(); }
        if (!current()) return false;
        const checked = await nativeRequest.call(client, 'thread/read', { threadId: id, includeTurns: false });
        const verified = receipt(checked?.readState), tail = latest?.data?.[0];
        if (!current() || checked?.thread?.id !== id || verified?.revision !== known.revision ||
            JSON.stringify(verified.firstUnread) !== JSON.stringify(known.firstUnread) ||
            !tail || !validId(tail.id) || !['completed', 'failed', 'interrupted'].includes(tail.status)) return false;
        const view = inspect();
        if (!current() || view?.visible !== true || view.generation !== generation || !history.complete ||
            history.turnId !== tail.id || history.status !== tail.status) return false;
        // No await between the last visibility/history/epoch checks and the native semantic action.
        commit();
        return true;
      };
      const timeout = new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(false); }, 5000); });
      return await Promise.race([probe(), timeout]);
    } catch { return false; /* Unsupported or unavailable proof never marks anything read. */ }
    finally { clearTimeout(timer); }
  }
  client.sendRequest = request;
  saved.set = localSet;
  return {
    observe,
    mark,
    readVisible,
    snapshot(id) { return receipt(receipts.get(id)); },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Receipt listener must be a function');
      if (!disposed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (client.sendRequest === request) client.sendRequest = nativeRequest;
      if (saved.set === localSet) saved.set = nativeSet;
      if (typeof unsubscribe === 'function') unsubscribe();
      held.clear(); receipts.clear(); epochs.clear(); receiptEpochs.clear(); intents.clear(); projected.clear(); applying.clear(); listeners.clear();
    },
  };
}
