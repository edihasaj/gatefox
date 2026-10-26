import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { readAsarFile } from '../claude-native-trial/asar.mjs';
import { supportedUnreadTrial } from '../codex-unread-trial/patch.mjs';

// Execute only the original automatic-read hook in memory, never the app or a patched bundle.
const asset = 'webview/assets/local-conversation-thread-f8411a03e6c2.js';
const digest = '4f94f2c3ec4fac892800f78f791c76615f29545f888454dee2f1db7b1f8e183f';
async function hook(t) {
  let archive;
  try { archive = await readFile('/Applications/ChatGPT.app/Contents/Resources/app.asar'); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Installed app unavailable'); return; } throw error; }
  if (JSON.parse(readAsarFile(archive, 'package.json')).version !== supportedUnreadTrial.version) {
    t.skip('No verified stock read hook for this app version'); return;
  }
  const bytes = readAsarFile(archive, asset);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest, 'Refuse changed vendor code');
  const parsed = ts.createSourceFile(asset, bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'xF');
  assert.equal(found.length, 1);
  const keys = Object.fromEntries(['Tp', 'qd', 'Gf', 'Hr', 'kc', 'zu', 'fo', 'Id'].map(key => [key, Symbol(key)]));
  return read => Function(...Object.keys(keys), 'bp', 'vF', 'SF', 'bF', 'qi', `return (${found[0].getText(parsed)});`)(
    ...Object.values(keys), id => id, () => () => {},
    () => ({ hasConversation: true, hasPersistedUnreadTurn: read.unread, hasUnreadTurn: read.unread, persistedUnreadHostId: 'host' }),
    () => { read.unread = false; read.calls++; }, () => {},
  )({
    get: node => node === keys.Hr ? true : node === keys.qd ? 'host' : node === keys.Tp
      ? { lastTurnId: 'same-turn', lastTurnStatus: 'completed' } : node === keys.kc ? { requests: [] } : null,
    watch(callback) { read.pump = () => callback({ get: this.get }); return () => {}; },
  }, 'thread');
}

test('stock automatic read ignores a later unread mutation for the same completed turn', async t => {
  const install = await hook(t); if (!install) return;
  const state = { unread: true, calls: 0, pump: undefined };
  const stop = install(state);
  try {
    state.pump(); assert.equal(state.unread, false); assert.equal(state.calls, 1);
    // An ordinary resume/refresh with no synthetic terminal preserves the user's read action.
    state.pump(); assert.equal(state.unread, false); assert.equal(state.calls, 1);
    // A replayed terminal sets unread again but changes none of the hook's request/turn/status keys.
    state.unread = true; state.pump();
    assert.equal(state.unread, true, 'The stock hook cannot reconcile a same-turn terminal replay');
    assert.equal(state.calls, 1, 'It does not perform a second semantic read');
  } finally { stop(); }
});
