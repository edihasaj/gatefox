// Real SDK thread/sample -> Gateway -> synthetic Claude CLI. No paid inference or native-home writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { gatewayToken, validateConfig } from '../dist/config.js';
import { startGateway } from '../dist/server.js';
import { ClaudeSubscription } from '../dist/providers/claude.js';
import { claudeLive } from '../dist/providers/claude-live.js';
import { sessionRegistry } from '../dist/providers/claude-session-registry.js';
import { providerCommand } from '../dist/provider-tool-runtime.js';
import { installClaudeFixture } from '../dist/tests/claude-cli-fixture.js';

const { values } = parseArgs({ options: { sdk: { type: 'string' }, catalog: { type: 'string' }, root: { type: 'string' } } });
for (const name of ['sdk', 'catalog', 'root']) assert.ok(values[name], `Pass --${name}`);
const root = resolve(values.root), sdk = resolve(values.sdk);
assert.ok(root.startsWith('/tmp/'), 'Use a task-specific /tmp evidence directory');
await mkdir(root, { mode: 0o700 }); // A reused evidence directory is refused.
process.env.TMPDIR = root;
const home = join(root, 'native'), work = join(root, 'work');
for (const dir of [home, work]) await mkdir(dir, { mode: 0o700 });
const catalog = JSON.parse(await readFile(resolve(values.catalog), 'utf8'));
const base = catalog.models.find(row => row.slug === 'gpt-6.1-sol') ?? catalog.models[0];
assert.ok(base);
await writeFile(join(home, 'models.json'), JSON.stringify({ models: [{ ...base, slug: 'alias', display_name: 'alias',
  context_window: 1_000_000, auto_compact_token_limit: 900_000 }] }), { mode: 0o600 });
const fixture = await installClaudeFixture({ replies: [{ text: 'PARENT' },
  ...Array.from({ length: 3 }, () => ({ text: '{"suggestion":"NEXT"}' })), { text: 'PARENT_CONTINUED' }] });
assert.equal(await providerCommand('claude'), 'claude', 'Use a private HOME without managed tools so only the synthetic CLI runs');
const config = validateConfig({ version: 1, port: 0, stateDirectory: join(root, 'state'),
  providers: [{ id: 'fixture', type: 'claude-subscription', models: { alias: 'fixture' }, claudeSessions: { max: 1, warmup: 0 } }] });
const sources = [];
const gateway = await startGateway(config, provider => {
  const subscription = new ClaudeSubscription(provider);
  return { async *infer(request, signal, context) {
    sources.push(context?.threadSource ?? null);
    yield* subscription.infer(request, signal, context);
  } };
});
let child;
try {
  const token = await gatewayToken(config.stateDirectory);
  await writeFile(join(home, 'config.toml'), `model = "alias"\nmodel_provider = "fixture"\nmodel_catalog_json = ${JSON.stringify(join(home, 'models.json'))}\n` +
    `web_search = "disabled"\n[features]\nremote_control = false\n[model_providers.fixture]\nname = "Fixture"\n` +
    `base_url = "http://127.0.0.1:${gateway.address().port}/v1"\nenv_key = "SAMPLING_FIXTURE_TOKEN"\nwire_api = "responses"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`, { mode: 0o600 });
  child = spawn(sdk, ['app-server', '--listen', 'stdio://'], { cwd: work, detached: true,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: root, SAMPLING_FIXTURE_TOKEN: token,
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map(), completed = new Map(); let sequence = 0;
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line), entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(Error(`${entry.method}: ${message.error.code}`)) : entry.resolve(message.result);
    } else if (message.method === 'turn/completed') completed.set(message.params.turn.id, message.params.turn);
    else if (message.method && message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'No fixture handler' } });
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 60_000);
    pending.set(id, { method, resolve, reject, timer }); send({ id, method, params });
  });
  await rpc('initialize', { clientInfo: { name: 'gateway_sampling_fixture', version: '1' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized', params: {} });
  const { thread } = await rpc('thread/start', { model: 'alias', modelProvider: 'fixture', cwd: work,
    approvalPolicy: 'never', sandbox: 'workspace-write' });
  const turn = async text => {
    const { turn } = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] });
    const deadline = Date.now() + 60_000;
    while (!completed.has(turn.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(completed.get(turn.id)?.status, 'completed'); return turn.id;
  };
  const firstTurn = await turn('x'.repeat(300_000));
  assert.equal(sessionRegistry().sessions.size, 1);
  const parent = [...sessionRegistry().sessions.values()][0];
  for (let sample = 0; sample < 3; sample++) {
    const result = await rpc('thread/sample', { threadId: thread.id, expectedTurnId: firstTurn,
      prompt: 'Suggest the next synthetic fixture prompt.', threadSource: 'composer_predictions',
      turnTrigger: 'composer_predictions', disableMcp: true });
    assert.equal(JSON.parse(result.text).suggestion, 'NEXT');
    assert.equal(sessionRegistry().sessions.size, 1);
    assert.equal([...sessionRegistry().sessions.values()][0], parent);
  }
  await turn('Continue the parent.');
  assert.equal([...sessionRegistry().sessions.values()][0], parent);
  const starts = (await fixture.capture()).filter(entry => entry.start).map(entry => entry.start);
  assert.deepEqual(starts, ['live', 'oneshot', 'oneshot', 'oneshot']);
  assert.deepEqual(sources.slice(1, 4), ['composer_predictions', 'composer_predictions', 'composer_predictions']);
  assert.ok([null, 'user'].includes(sources[0]) && [null, 'user'].includes(sources[4]));
  const receipt = { passed: true, samples: 3, poolLimit: 1, retainedSessions: 1, parentContinued: true, sources, starts };
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); process.kill(-child.pid, 'SIGTERM');
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
    await exited; clearTimeout(timer);
  }
  await claudeLive({ max: 1, parkMinutes: 60 }).stop();
  gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
  await fixture.restore();
}
