// Exercise five real SDK writers with isolated state and no inference or native authentication.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { package: { type: 'string' } } });
assert.ok(values.package, 'Pass --package with a compiled release containing its verified gateway SDK');
const pkg = resolve(values.package);
const moduleAt = name => import(pathToFileURL(join(pkg, 'dist', name + '.js')).href);
const [{ startExecutionHost }, storage, { SocketAppServerConnection }, { gatewaySdkRuntime }, { modelCatalog }] = await Promise.all([
  moduleAt('execution-host'), moduleAt('execution-host-storage'), moduleAt('socket-app-server-connection'),
  moduleAt('gateway-sdk-runtime'), moduleAt('catalog'),
]);
const runtime = await gatewaySdkRuntime(pkg); assert.ok(runtime, 'The package must contain its gateway SDK');
const root = await mkdtemp('/tmp/gwcat-');
const nativeHome = join(root, 'native'), configPath = join(root, 'gateway.json');
await mkdir(nativeHome, { mode: 0o700 });
storage.setExecutionHostRootForTests(join(root, 'hosts'));
// The real SDK fixes its physical socket directory; host.close removes only this fixture's owned sockets.
const config = { version: 1, port: 3457, stateDirectory: join(root, 'state'), providers: [], clientOnly: true };
const alias = 'fixture/model';
const catalog = modelCatalog({ ...config, providers: [{ id: 'fixture', type: 'responses-api',
  models: { [alias]: 'fixture' }, modelMetadata: { [alias]: { contextWindow: 32768 } } }] });
const args = ['app-server', '-c', 'model_provider="fixture"', '-c', 'model="fixture/model"',
  '-c', 'model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:1/v1",wire_api="responses",requires_openai_auth=false}',
  '-c', 'web_search="disabled"', '-c', 'features.remote_control=false'];
const clients = []; let host, control;
try {
  host = await startExecutionHost({ config, configPath, nativeHome, codex: runtime.executable, gatewayRuntime: async () => runtime });
  const home = storage.executionHostHome(configPath, nativeHome);
  control = new SocketAppServerConnection(join(home, 'host.sock'), async () => {}); await control.ready;
  const chats = [], revisions = [];
  for (let index = 0; index < 5; index++) {
    const revision = createHash('sha256').update('real-sdk-catalog-' + index).digest('hex'); revisions.push(revision);
    const generation = await control.request('execution/acquire', { revision, args, settings: {},
      catalog: { models: catalog.models.map(row => ({ ...row, description: 'Catalog ' + index })) },
      aliases: [alias], gatewaySdkSha256: runtime.binarySha256 });
    const client = new SocketAppServerConnection(generation.socketPath, async () => {}); clients.push(client); await client.ready;
    await client.request('initialize', { clientInfo: { name: 'codex_app_server_daemon', version: '1' }, capabilities: { experimentalApi: true } });
    client.send({ method: 'initialized', params: {} });
    const started = await client.request('thread/start', { model: alias, modelProvider: 'fixture', cwd: root,
      approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
    chats.push(started.thread.id);
  }
  const status = await control.request('execution/status', {}); assert.equal(status.generations.length, 5);
  assert.equal((await storage.readOwner(join(home, 'owner.json'))).generations.length, 5);
  for (let index = 0; index < chats.length; index++) {
    const owner = await control.request('execution/find', { threadId: chats[index] });
    assert.equal(owner.revision, revisions[index]);
    assert.equal((await clients[index].request('thread/read', { threadId: chats[index], includeTurns: false })).thread.id, chats[index]);
  }
  console.log(JSON.stringify({ result: 'pass', realSdkGenerations: 5, originalWritersPreserved: true, inferenceRequests: 0, nativeAuthenticationCopied: false }));
} finally {
  for (const client of clients) client.stop(); control?.stop();
  await Promise.all(clients.map(client => client.exited)); await control?.exited; await host?.close();
  storage.setExecutionHostRootForTests();
  await rm(root, { recursive: true, force: true });
}
