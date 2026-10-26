/** Client-local receipt signals. Hosts and manager generations never share pending actions. */
export function createReceiptRegistry(installBridge) {
  const managers = new WeakMap(), hosts = new Map(), listeners = new Map(), pending = new Map();
  const queue = (host, id, entry) => {
    if (hosts.get(host) !== entry || !listeners.has(id)) return;
    const key = `${host}\0${id}`;
    const queued = pending.has(key);
    pending.set(key, entry);
    if (queued) return;
    queueMicrotask(() => {
      const latest = pending.get(key);
      pending.delete(key);
      if (hosts.get(host) !== latest) return;
      for (const listener of [...(listeners.get(id) ?? [])]) {
        try { listener(host); } catch { /* A receipt never fails a native response. */ }
      }
    });
  };
  return {
    install(manager) {
      if (managers.has(manager)) return;
      const client = manager.threadStore?.params?.requestClient, saved = manager.readState;
      const host = manager.getHostId?.();
      if (typeof host !== 'string' || !host || !client || typeof client.sendRequest !== 'function' ||
          !saved || typeof saved.has !== 'function' || typeof saved.set !== 'function' ||
          typeof saved.isReady !== 'function' || typeof saved.subscribe !== 'function' ||
          !Array.isArray(manager.cleanup) || typeof manager.applySavedConversationReadState !== 'function') {
        throw Error('Unread trial client contract changed');
      }
      // Retire before wrapping a possibly shared request client or saved facade again.
      hosts.get(host)?.retire();
      const bridge = installBridge({ client, saved, notify: (id, unread) => manager.applySavedConversationReadState(id, unread) });
      if (typeof bridge.snapshot !== 'function' || typeof bridge.subscribe !== 'function') {
        bridge.dispose?.(); throw Error('Unread trial receipt signal contract changed');
      }
      const entry = { bridge };
      managers.set(manager, entry); hosts.set(host, entry);
      const unsubscribe = bridge.subscribe(id => queue(host, id, entry));
      entry.retire = () => {
        unsubscribe(); bridge.dispose(); managers.delete(manager);
        if (hosts.get(host) === entry) hosts.delete(host);
      };
      manager.cleanup.push(entry.retire);
    },
    observe(manager, message) { managers.get(manager)?.bridge.observe(message); },
    mark(manager, id, unread) { managers.get(manager)?.bridge.mark(id, unread); },
    snapshot(host, id) { return hosts.get(host)?.bridge.snapshot(id) ?? null; },
    readVisible(host, id, inspect, commit, loadHistory) { return hosts.get(host)?.bridge.readVisible(id, inspect, commit, loadHistory) ?? Promise.resolve(false); },
    subscribe(id, listener) {
      let group = listeners.get(id);
      if (!group) { group = new Set(); listeners.set(id, group); }
      group.add(listener);
      return () => { group.delete(listener); if (!group.size && listeners.get(id) === group) listeners.delete(id); };
    },
  };
}
