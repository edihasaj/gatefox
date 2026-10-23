#!/usr/bin/env node
// Real gateway and app-management checks for host/Grok and shared-client views.
// Every account, token and configuration is a private fixture. No real provider inference.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: { output: { type: 'string' }, code: { type: 'string' }, 'serve-fixture': { type: 'boolean' } } });
const code = resolve(values.code ?? new URL('..', import.meta.url).pathname);
const root = values.output ? resolve(values.output) : await mkdtemp('/tmp/gateway-connections-');
if (values.output) await mkdir(root, { mode: 0o700 });
const load = name => import(pathToFileURL(join(code, 'dist', name + '.js')));
const { startGateway } = await load('server');
const { loadConfig, writePrivateJson, readClientToken } = await load('config');
const { LiveConfig } = await load('live-config');
const { handleManagement } = await load('app-management');
const hostHome = join(root, 'host'), clientHome = join(root, 'client');
for (const home of [hostHome, clientHome]) await mkdir(join(home, 'settings'), { recursive: true, mode: 0o700 });
const hostPath = join(hostHome, 'settings/gateway.json'), clientPath = join(clientHome, 'settings/gateway.json');
const hostState = join(hostHome, 'state'), clientState = join(clientHome, 'state');
await mkdir(hostState, { mode: 0o700 }); await mkdir(clientState, { mode: 0o700 });
const grokMetadata = { displayName: 'Grok fixture', contextWindow: 65536, reasoningEfforts: ['low'] };
const config = { version: 1, port: 0, stateDirectory: hostState, providers: [
  { id: 'claude', label: 'Claude fixture', type: 'claude-subscription', models: { 'claude/fixture': 'claude-fixture' } },
  { id: 'codex', label: 'Codex fixture', type: 'codex-subscription', credentialFile: join(hostState, 'codex.json'),
    defaultForBareModels: true, models: { 'codex/fixture': 'gpt-fixture' } },
  { id: 'local', label: 'Local fixture', type: 'chat-completions-api', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FIXTURE_UNUSED',
    sessionAffinity: true, models: { 'local/fixture': 'local-fixture' } },
  { id: 'grok', label: 'Grok fixture', type: 'grok-subscription', grokHome: join(hostState, 'grok'),
    models: { 'grok/one': 'grok-fixture-one', 'grok/two': 'grok-fixture-two' }, modelMetadata: { 'grok/one': grokMetadata, 'grok/two': grokMetadata } },
] };
await writePrivateJson(hostPath, config);
const initial = await loadConfig(hostPath); let live;
let inferenceCalls = 0;
const server = await startGateway(initial, () => ({ async *infer() {
  inferenceCalls++; yield { type: 'text', text: 'CONNECTIONS_FIXTURE_OK' };
  yield { type: 'done', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
} }), () => live ? live.current() : Promise.resolve(initial));
const port = server.address().port;
await writePrivateJson(hostPath, { ...config, port });
live = new LiveConfig(hostPath, await loadConfig(hostPath));
const token = await readClientToken(join(hostState, 'client-token'));
await writeFile(join(clientState, 'client-token'), token + '\n', { mode: 0o600 });
await writePrivateJson(clientPath, { version: 1, port, clientOnly: true, stateDirectory: clientState, providers: [] });
const fixtures = { root, host: { home: hostHome, configPath: hostPath }, client: { home: clientHome, configPath: clientPath }, port };
await writePrivateJson(join(root, 'fixture.json'), fixtures);
let closed = false;
async function close() {
  if (closed) return; closed = true; server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const inspect = async configPath => {
  const response = await handleManagement({ operation: 'inspect', configPath }, { lookupCli: async () => true });
  assert.equal(response.ok, true, response.error?.code); return response.result;
};
try {
  const before = await readFile(hostPath, 'utf8');
  const host = await inspect(hostPath);
  assert.equal(host.providers.length, 4, 'A Grok route must not erase the host connection list');
  assert.equal(host.providers.find(provider => provider.id === 'grok').canDiscover, false);
  assert.equal(host.providers.find(provider => provider.id === 'grok').canReconnect, false);
  assert.equal(await readFile(hostPath, 'utf8'), before, 'Inspection is read-only');
  let client = await inspect(clientPath);
  assert.equal(client.sharedGateway?.status, 'available');
  assert.equal(client.sharedGateway.providers.length, 4);
  assert.ok(client.sharedGateway.hostname, 'The catalog identifies its actual serving host');
  assert.equal(client.sharedGateway.providers.find(provider => provider.id === 'claude').label, 'Claude fixture');
  assert.equal(client.sharedGateway.providers.find(provider => provider.id === 'grok').models[0].label, 'Grok fixture');
  assert.equal(JSON.stringify(client).includes(token), false);
  assert.equal(JSON.stringify(client.sharedGateway).includes(hostState), false, 'Shared catalogs never disclose host state paths');
  assert.equal(inferenceCalls, 0, 'Listing connections never sends model inference');
  const saved = await handleManagement({ operation: 'models', configPath: hostPath, providerId: 'grok', revision: host.revision,
    selectedModels: ['grok-fixture-one'] });
  assert.equal(saved.ok, true, saved.error?.code);
  const refreshed = await inspect(hostPath);
  const restored = await handleManagement({ operation: 'models', configPath: hostPath, providerId: 'grok', revision: refreshed.revision,
    selectedModels: ['grok-fixture-one', 'grok-fixture-two'] });
  assert.equal(restored.ok, true, restored.error?.code);
  const raw = JSON.parse(await readFile(hostPath, 'utf8'));
  assert.deepEqual(raw.providers.find(provider => provider.id === 'grok'), config.providers.find(provider => provider.id === 'grok'));
  const noEdit = await handleManagement({ operation: 'models', configPath: clientPath, providerId: 'grok', revision: client.revision,
    selectedModels: ['grok-fixture-one'] });
  assert.equal(noEdit.ok, false, 'A consumer cannot edit another host through local management');
  const source = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ model: 'local/fixture', input: 'fixture' }) });
  assert.equal(source.status, 200); assert.ok(JSON.stringify(await source.json()).includes('CONNECTIONS_FIXTURE_OK'));
  client = await inspect(clientPath); assert.equal(client.sharedGateway.status, 'available');
  assert.equal(inferenceCalls, 1);
  const digest = createHash('sha256').update(await readFile(hostPath)).digest('hex');
  if (values['serve-fixture']) {
    console.log(JSON.stringify({ status: 'serving', ...fixtures, checksPassed: true }));
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else {
    await close();
    const unavailable = await inspect(clientPath);
    assert.equal(unavailable.sharedGateway.status, 'unavailable');
    assert.deepEqual(unavailable.sharedGateway.providers, []);
    assert.equal(createHash('sha256').update(await readFile(hostPath)).digest('hex'), digest);
    console.log(JSON.stringify({ status: 'passed', ...fixtures, grokSelectionRoundtrip: true, sharedCatalog: true,
      readOnlyClient: true, unavailableClearsCatalog: true, realGateway: true, paidInferenceRequests: 0 }));
  }
} finally { await close(); }
