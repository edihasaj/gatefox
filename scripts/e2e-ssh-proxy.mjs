// Real signed native proxy, real HTTP upgrade, and a private gateway Unix listener.
// No account, inference, application state, or existing listener is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';

const { values } = parseArgs({ options: { package: { type: 'string' }, codex: { type: 'string' }, root: { type: 'string' } } });
assert.ok(values.package && values.codex && values.root, 'Pass --package PACKAGE --codex SIGNED_NATIVE_CLI --root FRESH_DIRECTORY');
const root = resolve(values.root), pkg = resolve(values.package);
await mkdir(root, { mode: 0o700 });
const home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
const { serveUnix } = await import(pathToFileURL(join(pkg, 'dist/unix-transport.js')));
const { proxyNative } = await import(pathToFileURL(join(pkg, 'dist/codex-shim.js')));
const controller = new AbortController(), socketPath = join(root, 'rpc.sock'), device = 'e'.repeat(32);
let listening; const ready = new Promise(resolve => { listening = resolve; });
const received = [], children = new Set(), flights = new Set(), clients = new Set();
let stderrBytes = 0;
const serving = serveUnix(socketPath, controller.signal, async (input, emit) => {
  let buffered = '';
  for await (const chunk of input) {
    buffered += chunk.toString();
    for (let end; (end = buffered.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      received.push(message);
      if (message.method === 'initialize') await emit({ id: message.id, result: { diagnostic: true } });
    }
  }
}, null, () => listening());
const env = { ...process.env, HOME: home, CODEX_HOME: home };
for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'HARNESS_GATEWAY_EXECUTOR']) delete env[name];
const bridge = createServer(input => {
  clients.add(input); input.once('close', () => clients.delete(input)); input.on('error', () => {});
  const flight = proxyNative(resolve(values.codex), ['app-server', 'proxy', '--sock', socketPath], env, input, device,
    (command, args, options) => {
      const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child); child.once('exit', () => children.delete(child));
      child.stdout.pipe(input); child.stderr.on('data', bytes => { stderrBytes += bytes.length; });
      return child;
    }).finally(() => { input.destroy(); flights.delete(flight); });
  flights.add(flight); void flight.catch(() => {});
});
let ws;
let deadline;
try {
  await Promise.race([ready, serving.then(() => { throw new Error('Unix listener ended before readiness'); })]);
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  ws = new WebSocket(`ws://127.0.0.1:${bridge.address().port}/rpc`, { handshakeTimeout: 10000 });
  await once(ws, 'open');
  const answer = new Promise((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('Initialize response timed out')), 10000);
    ws.on('error', reject);
    ws.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (message.id === 713) resolve(message); });
  });
  ws.send(JSON.stringify({ id: 713, method: 'initialize', params: { clientInfo: { name: 'gateway_proxy_fixture', version: '1' } } }));
  assert.deepEqual(await answer, { id: 713, result: { diagnostic: true } });
  assert.deepEqual(received.map(message => message.method), ['gateway/client', 'initialize']);
  assert.equal(received[0].params.device, device);
  const version = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).version;
  const receipt = { version, websocketUpgrade: true, nativeProxy: true, identityBeforeInitialize: true, initializeReply: true, stderrBytes };
  await writeFile(join(root, 'result.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} finally {
  clearTimeout(deadline); ws?.terminate();
  for (const client of clients) client.destroy();
  for (const child of children) child.kill('SIGTERM');
  bridge.close(); controller.abort();
  let grace;
  const settled = Promise.allSettled([...flights, serving]);
  const finished = await Promise.race([settled.then(() => true), new Promise(resolve => { grace = setTimeout(() => resolve(false), 3000); })]);
  clearTimeout(grace);
  if (!finished) {
    for (const child of children) child.kill('SIGKILL');
    let finalWait;
    const stopped = await Promise.race([settled.then(() => true), new Promise(resolve => { finalWait = setTimeout(() => resolve(false), 3000); })]);
    clearTimeout(finalWait);
    if (!stopped) { for (const child of children) child.unref(); throw new Error('Native proxy fixture cleanup timed out'); }
  }
}
