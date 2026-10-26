import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { readAsarFile } from '../claude-native-trial/asar.mjs';
import { patchPinnedUnreadBundle, supportedUnreadTrial as pin } from '../codex-unread-trial/patch.mjs';
import { installReadStateBridge } from '../codex-unread-trial/read-state-bridge.mjs';
import { createReceiptRegistry } from '../codex-unread-trial/receipt-registry.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
let cachedStock;
async function loadStock() {
  let archive;
  try { archive = await readFile('/Applications/ChatGPT.app/Contents/Resources/app.asar'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (JSON.parse(readAsarFile(archive, 'package.json')).version !== pin.version) return;
  const args = { renderer: readAsarFile(archive, pin.asset).toString(), conversation: readAsarFile(archive, pin.conversationAsset).toString(),
    bridgeSource: await readFile(new URL('../codex-unread-trial/read-state-bridge.mjs', import.meta.url), 'utf8'), version: pin.version };
  const patched = patchPinnedUnreadBundle(args);
  const ast = ts.createSourceFile('conversation.js', patched.conversation, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const hook = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'xF').getText(ast);
  return { hook, args };
}
async function stockHook(t) {
  const stock = await (cachedStock ??= loadStock());
  if (!stock) t.skip('Pinned installed native hook unavailable');
  return stock;
}

function fixture(hook) {
  const registry = createReceiptRegistry(installReadStateBridge), values = new Map(), calls = [];
  const state = { focused: true, unread: true, readCalls: 0, complete: true,
    loaded: { turnId: 'turn', status: 'completed' }, latest: { id: 'turn', status: 'completed' },
    server: { revision: 'v1', firstUnread: { type: 'turn', turnId: 'turn' } } };
  let watcher = () => {}, revision = 1;
  const pump = () => watcher();
  const saved = { has: id => values.get(id), isReady: () => true, subscribe: () => () => {}, set(id, unread) { values.set(id, unread); pump(); } };
  const client = { async sendRequest(method, params) {
    calls.push({ method, params });
    if (method === 'thread/list') return { data: [{ id: 'one' }], readStates: { one: structuredClone(state.server) } };
    if (method === 'thread/turns/list') return { data: [structuredClone(state.latest)] };
    if (method === 'thread/read') { await state.readGate; return { thread: { id: 'one' }, readState: structuredClone(state.server) }; }
    assert.equal(method, 'thread/readState/update');
    if (params.expectedRevision !== state.server.revision) throw Object.assign(Error('conflict'), { data: { reason: 'readStateConflict', readState: structuredClone(state.server) } });
    state.server = { revision: `v${++revision}`, firstUnread: params.operation.type === 'read' ? null : { type: 'threadStart' } };
    return { readState: structuredClone(state.server) };
  } };
  const manager = { cleanup: [], getHostId: () => 'host', readState: saved, threadStore: { params: { requestClient: client } },
    applySavedConversationReadState(_id, unread) { state.unread = unread; pump(); },
    mark(unread) {
      if (!unread) state.readCalls++;
      manager.applySavedConversationReadState('one', unread); saved.set('one', unread); registry.mark(manager, 'one', unread);
    } };
  registry.install(manager);
  const keys = Object.fromEntries(['Tp', 'qd', 'Gf', 'Hr', 'kc', 'zu', 'fo', 'Id', '__hgNativeUnreadTrialHistory'].map(name => [name, Symbol(name)]));
  const get = (key, params) => {
    if (key === keys.__hgNativeUnreadTrialHistory) assert.equal(params, 'one', 'Native history invalidation is keyed by conversation ID');
    return key === keys.Hr ? state.focused : key === keys.qd ? 'host' : key === keys.Tp
      ? { lastTurnId: state.loaded.turnId, lastTurnStatus: state.loaded.status } : key === keys.kc ? { requests: [] } : null;
  };
  const scope = { get, watch(callback) { watcher = () => callback({ get }); pump(); return () => { watcher = () => {}; }; } };
  const run = Function(...Object.keys(keys), '__hgNativeUnreadTrial', 'bp', 'vF', 'SF', 'bF', 'qi', 'Cu', `return (${hook});`)(
    ...Object.values(keys), registry, id => id, () => () => {},
    () => ({ hasConversation: true, hasPersistedUnreadTurn: values.get('one') === true, hasUnreadTurn: state.unread, persistedUnreadHostId: 'host' }),
    () => manager.mark(false), () => {}, () => ({ async getLoadedConversationHistory() {
      return { isComplete: state.complete, turns: [structuredClone(state.loaded)], [Symbol.dispose]() { state.disposedHistory = (state.disposedHistory ?? 0) + 1; } };
    } }),
  );
  return { state, values, calls, manager, registry, client, pump, open: () => run(scope, 'one'), close: () => manager.cleanup.forEach(clean => clean()) };
}

test('paired native hooks repair read-before-first-receipt without acknowledging an unseen revision', async t => {
  const stock = await stockHook(t); if (!stock) return;
  const f = fixture(stock.hook); const stop = f.open();
  try {
    assert.equal(f.state.unread, false); assert.equal(f.calls.length, 0, 'Stock local read remains, but there is no blind durable acknowledgement');
    await f.client.sendRequest('thread/list', {}); await tick(); await tick();
    assert.equal(f.state.unread, false); assert.equal(f.values.get('one'), false); assert.equal(f.state.server.firstUnread, null);
    assert.deepEqual(f.calls.filter(call => call.method === 'thread/readState/update').map(call => call.params.expectedRevision), ['v1']);
  } finally { stop(); f.close(); }
});

test('receipt v2 with firstUnread A cannot clear unseen B while the loaded transcript is still A', async t => {
  const stock = await stockHook(t); if (!stock) return;
  const f = fixture(stock.hook); f.state.focused = false; const stop = f.open();
  try {
    await f.client.sendRequest('thread/list', {}); await tick();
    f.state.latest = { id: 'newer-B', status: 'completed' };
    f.state.server.revision = 'v2'; // firstUnread deliberately remains the older A.
    f.registry.observe(f.manager, { method: 'thread/readState/changed', params: { threadId: 'one', readState: f.state.server } });
    f.state.focused = true; f.pump(); await tick(); await tick();
    assert.equal(f.state.unread, true);
    assert.equal(f.calls.filter(call => call.method === 'thread/readState/update').length, 0);
    f.state.loaded = { turnId: 'newer-B', status: 'completed' };
    f.state.complete = false; f.pump(); await tick(); await tick();
    assert.equal(f.state.unread, true, 'A metadata match is not item hydration');
    f.state.complete = true; f.pump(); await tick(); await tick();
    assert.equal(f.state.server.firstUnread, null, 'A fresh hydrated match may acknowledge v2');
  } finally { stop(); f.close(); }
});

test('manual unread before the first receipt becomes durable threadStart and is not auto-cleared', async t => {
  const stock = await stockHook(t); if (!stock) return;
  const f = fixture(stock.hook); const stop = f.open();
  try {
    f.manager.mark(true);
    await f.client.sendRequest('thread/list', {}); await tick(); await tick();
    assert.equal(f.state.server.firstUnread.type, 'threadStart');
    assert.equal(f.state.unread, true); assert.equal(f.values.get('one'), true);
    assert.deepEqual(f.calls.filter(call => call.method === 'thread/readState/update').map(call => call.params.operation.type), ['unread']);
  } finally { stop(); f.close(); }
});

test('closing and reopening the same chat cannot inherit an old pending read proof', async t => {
  const stock = await stockHook(t); if (!stock) return;
  const f = fixture(stock.hook); f.state.focused = false; const stop = f.open();
  let release;
  try {
    await f.client.sendRequest('thread/list', {}); await tick();
    f.state.readGate = new Promise(resolve => { release = resolve; });
    f.state.focused = true; f.pump(); await tick(); stop(); release(); await tick();
    const beforeReopen = f.state.readCalls;
    assert.equal(f.state.server.firstUnread.type, 'turn'); assert.equal(beforeReopen, 0);
    const stopReopened = f.open(); await tick(); await tick(); stopReopened();
    assert.equal(f.state.server.firstUnread, null); assert.equal(f.state.readCalls, 1);
  } finally { release?.(); stop(); f.close(); }
});

test('a host without receipt support keeps stock local-read behavior without any durable update', async t => {
  const stock = await stockHook(t); if (!stock) return;
  const f = fixture(stock.hook); const stop = f.open();
  try {
    assert.equal(f.state.unread, false); assert.equal(f.state.readCalls, 1);
    assert.equal(f.calls.length, 0);
  } finally { stop(); f.close(); }
});

test('an identical receipt refresh during a proof queues a fresh proof rather than leaving the dot stuck', async t => {
  const stock = await stockHook(t); if (!stock) return;
  const f = fixture(stock.hook); f.state.focused = false; const stop = f.open(); let release;
  try {
    await f.client.sendRequest('thread/list', {}); await tick();
    f.state.readGate = new Promise(resolve => { release = resolve; });
    f.state.focused = true; f.pump(); await tick();
    await f.client.sendRequest('thread/list', {}); await tick();
    release(); await tick(); await tick(); await tick();
    assert.equal(f.state.server.firstUnread, null); assert.equal(f.state.unread, false);
    assert.equal(f.calls.filter(call => call.method === 'thread/readState/update').length, 1);
    assert.ok(f.state.disposedHistory >= 2, 'Both retired and successful async history results are disposed');
  } finally { release?.(); stop(); f.close(); }
});

test('background receipt restores a dot; focus clears it durably; a refresh stays read', async t => {
  const stock = await stockHook(t); if (!stock) return;
  const f = fixture(stock.hook); f.state.focused = false; const stop = f.open();
  try {
    await f.client.sendRequest('thread/list', {}); await tick();
    assert.equal(f.state.unread, true); assert.equal(f.values.get('one'), true);
    assert.equal(f.calls.filter(call => call.method === 'thread/readState/update').length, 0);
    f.state.focused = true; f.pump(); await tick(); await tick();
    assert.equal(f.state.server.firstUnread, null); assert.equal(f.state.unread, false);
    await f.client.sendRequest('thread/list', {}); await tick();
    assert.equal(f.state.unread, false); assert.equal(f.values.get('one'), false);
  } finally { stop(); f.close(); }
});

test('manual mark-unread remains unread in the focused chat', async t => {
  const stock = await stockHook(t); if (!stock) return;
  const f = fixture(stock.hook); const stop = f.open();
  try {
    await f.client.sendRequest('thread/list', {}); await tick(); await tick();
    f.manager.mark(true); await tick(); await tick();
    assert.equal(f.state.server.firstUnread.type, 'threadStart'); assert.equal(f.state.unread, true);
    assert.equal(f.values.get('one'), true);
    await f.client.sendRequest('thread/list', {}); await tick();
    assert.equal(f.state.unread, true);
  } finally { stop(); f.close(); }
});

test('both pinned chunks must validate before a candidate bundle is produced', async t => {
  const stock = await stockHook(t); if (!stock) return;
  assert.throws(() => patchPinnedUnreadBundle({ ...stock.args, conversation: stock.args.conversation + '\n' }), /No verified/);
  assert.throws(() => patchPinnedUnreadBundle({ ...stock.args, renderer: stock.args.renderer + '\n' }), /No verified/);
});
