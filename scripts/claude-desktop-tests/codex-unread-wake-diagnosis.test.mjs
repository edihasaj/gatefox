// Execute extracted, pinned functions in memory. Never load a window or write an application.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { readAsarFile } from '../claude-native-trial/asar.mjs';
import { supportedUnreadTrial as pin } from '../codex-unread-trial/patch.mjs';
import { installReadStateBridge } from '../codex-unread-trial/read-state-bridge.mjs';

let extracted;
async function stock(t) {
  extracted ??= (async () => {
    let archive;
    try { archive = await readFile('/Applications/ChatGPT.app/Contents/Resources/app.asar'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (JSON.parse(readAsarFile(archive, 'package.json')).version !== pin.version) return;
    const source = readAsarFile(archive, pin.asset);
    assert.equal(createHash('sha256').update(source).digest('hex'), pin.assetSha256, 'Refuse changed vendor code');
    const ast = ts.createSourceFile(pin.asset, source.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const paginators = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ptn');
    assert.equal(paginators.length, 1, 'Pinned list paginator must remain unambiguous');
    const getters = [];
    function visit(node) {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const methods = new Map(node.members.map(m => [m.name?.getText(ast), m]));
        if (methods.has('observeCatalogThreads') && methods.has('getThreadHasUnreadTurn') && !methods.has('saveReadState')) {
          getters.push(methods.get('getThreadHasUnreadTurn'));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast); assert.equal(getters.length, 1);
    return {
      list: Function('kpe', `return (${paginators[0].getText(ast)});`)([]),
      unread: Function(`return ({${getters[0].getText(ast)}}).getThreadHasUnreadTurn;`)(),
    };
  })();
  const result = await extracted;
  if (!result) t.skip('No verified installed client for the wake diagnosis');
  return result;
}
function fixture() {
  const values = new Map([['finished-offline', false]]), calls = [];
  const saved = { has: id => values.get(id), set: (id, value) => values.set(id, value), isReady: () => true, subscribe: () => () => {} };
  const page = {
    data: [{ id: 'finished-offline', status: { type: 'idle' }, updatedAt: 2 }], nextCursor: null,
    readStates: { 'finished-offline': { firstUnread: { type: 'turn', turnId: 'completed-during-sleep' }, revision: 'receipt-after-sleep' } },
  };
  const client = { async sendRequest(method, params) { calls.push({ method, params }); assert.equal(method, 'thread/list'); return page; } };
  const store = { params: { savedReadState: saved }, conversations: new Map(), getThreadSummary: () => ({ hasUnreadTurn: true }) };
  return { values, saved, page, client, store, calls };
}

test('stock wake list discards a valid unread receipt and the saved local read value still hides the dot', async t => {
  const code = await stock(t); if (!code) return;
  const f = fixture();
  assert.notEqual(f.page.readStates['finished-offline'].firstUnread, null, 'The server has durable unread evidence');
  const rows = await code.list({ sendRequest: f.client.sendRequest, recentConversationsSortKey: 'updated_at' }, {});
  assert.deepEqual(rows, f.page.data, 'The stock helper returns only rows, leaving readStates behind');
  assert.equal(rows.readStates, undefined);
  assert.equal(f.values.get('finished-offline'), false, 'Refreshing the list did not reconcile the local read store');
  assert.equal(code.unread.call(f.store, 'finished-offline'), false, 'Even a summary hint cannot override the saved read value');
  assert.equal(f.calls.some(c => c.method === 'thread/readState/update'), false);
});

test('the uninstalled receipt bridge can restore the stock getter before that same paginator drops metadata', async t => {
  const code = await stock(t); if (!code) return;
  const f = fixture(), projected = [];
  const bridge = installReadStateBridge({ client: f.client, saved: f.saved, notify: (id, unread) => projected.push({ id, unread }) });
  try {
    await code.list({ sendRequest: f.client.sendRequest.bind(f.client), recentConversationsSortKey: 'updated_at' }, {});
    assert.equal(code.unread.call(f.store, 'finished-offline'), true);
    assert.deepEqual(projected, [{ id: 'finished-offline', unread: true }]);
    assert.deepEqual(f.calls.map(c => c.method), ['thread/list'], 'Importing a receipt does not acknowledge it or replay a terminal');
  } finally { bridge.dispose(); }
});
