import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { startNativePickerFixture, fixtureModels } from '../claude-native-trial/fixture.mjs';
import { isolationPrelude } from '../claude-native-trial/isolation.mjs';
import vm from 'node:vm';

test('native fixture authenticates and records only sanitized controls', async () => {
  const root = await mkdtemp('/tmp/claude-native-picker-fixture.');
  const fixture = await startNativePickerFixture(`${root}/fixture`);
  try {
    assert.equal((await fetch(`${fixture.endpoint}/v1/models`)).status, 401);
    const token = await readFile(fixture.tokenFile, 'utf8');
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    for (const body of ['null', '[]', '"text"']) {
      assert.equal((await fetch(`${fixture.endpoint}/v1/messages`, { method: 'POST', headers, body })).status, 400);
    }
    const response = await fetch(`${fixture.endpoint}/v1/messages`, { method: 'POST', headers,
      body: JSON.stringify({ model: fixtureModels[0].slug, messages: [{ role: 'user', content: 'DO_NOT_RECORD' }],
        output_config: { effort: 'high' }, service_tier: 'priority', thinking: { type: 'adaptive' } }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, 'NATIVE_PICKER_OK');
    await fetch(`${fixture.endpoint}/v1/messages`, { method: 'POST', headers,
      body: JSON.stringify({ model: fixtureModels[1].slug, stream: true,
        output_config: { effort: 'DO_NOT_RECORD' }, thinking: { type: { secret: 'DO_NOT_RECORD' } } }) });
    assert.deepEqual(fixture.requests[0], { model: fixtureModels[0].slug, effort: 'high', tier: 'priority', thinking: 'adaptive', stream: false });
    assert.equal(fixture.requests[1].effort, 'unrecognized');
    assert.equal(fixture.requests[1].thinking, 'unrecognized');
    assert.ok(!JSON.stringify(fixture.requests).includes('DO_NOT_RECORD'));
  } finally { await fixture.close(); await rm(root, { recursive: true }); }
});

test('isolation prelude redirects native and CLI state before vendor imports', () => {
  const root = '/tmp/claude-native-picker.Test123/trial';
  const paths = {}, env = {}, dirs = [];
  vm.runInNewContext(isolationPrelude(root), { process: { env, getuid: () => 501 }, require(name) {
    if (name === 'electron') return { app: { setPath(key, value) { paths[key] = value; } } };
    if (name === 'node:fs') return { mkdirSync(path) { dirs.push(path); }, lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 501, mode: 0o700 }) };
    if (name === 'node:path') return { join: (...parts) => parts.join('/'), dirname: path => path.slice(0, path.lastIndexOf('/')) };
    throw Error('Unexpected import');
  } });
  assert.equal(paths.userData, `${root}/profile`);
  assert.equal(paths.appData, `${root}/app-data`);
  assert.equal(env.CLAUDE_CONFIG_DIR, `${root}/cli`);
  assert.equal(dirs.length, 6);
  for (const bad of ['/tmp', '/Users/edi', '/tmp/claude-native-picker.X/trial/../cli', 'relative']) {
    assert.throws(() => isolationPrelude(bad));
  }
});
