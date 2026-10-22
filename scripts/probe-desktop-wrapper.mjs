// Read-only startup checks through the exact desktop wrapper. Never starts a chat or performs inference.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: { wrapper: { type: 'string' }, output: { type: 'string' }, 'native-home': { type: 'string' } } });
assert.ok(values.wrapper && isAbsolute(values.wrapper), 'Use --wrapper with an absolute path');
assert.ok(values.output && isAbsolute(values.output), 'Use --output with an absolute path');
const child = spawn(values.wrapper, ['app-server', '--listen', 'stdio://'], {
  env: { ...process.env, ...(values['native-home'] ? { CODEX_HOME: values['native-home'] } : {}) },
  stdio: ['pipe', 'pipe', 'ignore'], detached: true,
});
const pending = new Map(), lines = createInterface({ input: child.stdout });
const result = { checkedAt: new Date().toISOString(), passed: false, readOnly: true, inferenceRequests: 0, checks: [] };
let sequence = 0, closed = false, phase = 'initialize';
const failAll = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('adapter_closed')); } pending.clear(); };
const exited = new Promise(resolve => child.once('close', () => { closed = true; failAll(); resolve(); }));
child.on('error', failAll); child.stdin.on('error', failAll);
lines.on('line', line => {
  let frame; try { frame = JSON.parse(line); } catch { failAll(); return; }
  const request = pending.get(frame.id);
  if (request) {
    pending.delete(frame.id); clearTimeout(request.timer);
    frame.error ? request.reject(Object.assign(Error('rpc_failed'), { code: frame.error.code })) : request.resolve(frame.result);
  } else if (frame.method && frame.id !== undefined) {
    child.stdin.write(JSON.stringify({ id: frame.id, error: { code: -32601, message: 'Read-only startup probe has no tool handler' } }) + '\n');
  }
});
const send = frame => child.stdin.write(JSON.stringify(frame) + '\n');
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  if (closed) return reject(Error('adapter_closed'));
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error('rpc_timeout')); }, 45000);
  pending.set(id, { resolve, reject, timer }); send({ id, method, params });
});
try {
  await rpc('initialize', { clientInfo: { name: 'gateway_desktop_wrapper_probe', version: '1' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized', params: {} }); result.checks.push({ method: phase, passed: true });
  phase = 'configRequirements/read'; await rpc(phase); result.checks.push({ method: phase, passed: true });
  phase = 'model/list'; const models = await rpc(phase, { limit: 100 }); assert.ok(Array.isArray(models.data) && models.data.length > 0);
  result.checks.push({ method: phase, passed: true, count: models.data.length });
  phase = 'thread/list'; const chats = await rpc(phase, { limit: 1 }); assert.ok(Array.isArray(chats.data));
  result.checks.push({ method: phase, passed: true, count: chats.data.length }); result.passed = true;
} catch (error) {
  result.checks.push({ method: phase, passed: false, ...(typeof error.code === 'number' ? { code: error.code } : {}) }); process.exitCode = 1;
} finally {
  child.stdin.end();
  if (!await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (!await Promise.race([exited.then(() => true), delay(3000).then(() => false)])) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await exited;
    }
  }
  lines.close(); await writeFile(values.output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
}
