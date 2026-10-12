import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {mkdir, mkdtemp, readlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname} from 'node:path';
import {startExecutionHost, executionHostHome} from '../dist/execution-host.js';
import {SocketAppServerConnection} from '../dist/socket-app-server-connection.js';

const {values} = parseArgs({options: {codex: {type: 'string'}, output: {type: 'string'}}});
if (!values.codex || !values.output) throw new Error('Use --codex PATH --output PATH');
if (process.platform !== 'darwin') throw new Error('This check requires the actual macOS sandbox');
const root = await mkdtemp(resolve(tmpdir(), 'gw-execution-sandbox-'));
const nativeHome = resolve(root, 'native'); const workspace = resolve(root, 'work');
await mkdir(nativeHome, {mode: 0o700}); await mkdir(workspace, {mode: 0o700});
await writeFile(resolve(nativeHome, 'config.toml'), 'default_permissions = "probe"\n[permissions.probe.filesystem]\n"/" = "read"\n[permissions.probe.network]\nenabled = true\n', {mode: 0o600});
const configPath = resolve(root, 'gateway.json');
const config = {version: 1, clientOnly: true, providers: [], port: 3457, stateDirectory: resolve(root, 'state')};
await writeFile(configPath, JSON.stringify(config), {mode: 0o600});
const host = await startExecutionHost({config, configPath, nativeHome, codex: resolve(values.codex)});
const socketPath = resolve(executionHostHome(configPath, nativeHome), 'host.sock');
const control = new SocketAppServerConnection(socketPath, async () => {});
try {
  await control.ready;
  assert.equal((await control.request('execution/status', {})).pid, process.pid);
  const physical = await readlink(socketPath);
  const program = `const net=require('node:net');
  Promise.all(process.argv.slice(1).map(path=>new Promise(resolve=>{
    const socket=net.connect(path);const timer=setTimeout(()=>{socket.destroy();resolve('TIMEOUT');},3000);
    socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve('CONNECTED');});
    socket.once('error',error=>{clearTimeout(timer);socket.destroy();resolve(error.code);});
  }))).then(codes=>console.log(JSON.stringify({codes})));`;
  const env = {...process.env, CODEX_HOME: nativeHome};
  for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  const {stdout} = await promisify(execFile)(resolve(values.codex), [
    'sandbox', '--permission-profile', 'probe', '--allow-unix-socket', '/',
    '-C', workspace, '--', process.execPath, '-e', program, socketPath, physical,
  ], {env, cwd: workspace, timeout: 15000, maxBuffer: 65536});
  const {codes} = JSON.parse(stdout.trim());
  assert.equal(codes.length, 2);
  for (const code of codes) assert.ok(['EPERM', 'EACCES'].includes(code), 'Protected live socket must be denied');
  assert.equal((await control.request('execution/status', {})).pid, process.pid);
  const result = {passed: true, controlReachableOutsideSandbox: true, aliasDenied: true, physicalDenied: true, explicitUnixGrant: '/', noInference: true};
  await mkdir(dirname(resolve(values.output)), {recursive: true, mode: 0o700});
  await writeFile(resolve(values.output), JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify(result));
} finally { control.stop(); await control.exited; await host.close(); }
