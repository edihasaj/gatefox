/** Isolated real-IndexedDB verification via abx. Never connects to or launches ChatGPT. */
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFile = promisify(execFileCallback);
const root = await mkdtemp('/tmp/hg-checkpoint-browser-');
await mkdir(join(root, 'tmp')); await mkdir(join(root, 'abx'));
const allowed = new Set(['receipt-checkpoints.mjs', 'read-state-bridge.mjs', 'checkpoint-browser-tests.mjs']);
const server = createServer(async (request, response) => {
  try {
    const name = request.url?.slice(1);
    if (allowed.has(name)) {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(new URL(name, import.meta.url)));
    } else if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Isolated unread checkpoint checks</title>');
    } else { response.writeHead(404); response.end(); }
  } catch { response.writeHead(500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TMPDIR: join(root, 'tmp'), BROWSE_STATE_FILE: join(root, 'abx', 'browse.json') };
// Explicit isolated state, never inherit another task's skill routing or production browser.
delete env.ABX_PORT; delete env.ABX_SKILL_TOKEN;
const abx = async (...args) => (await execFile('abx', args, { env, cwd: root, timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim();
try {
  await abx('goto', `http://127.0.0.1:${server.address().port}/`);
  const first = JSON.parse(await abx('js', "await import('/checkpoint-browser-tests.mjs').then(m=>m.run())"));
  await abx('reload');
  const second = JSON.parse(await abx('js', "await import('/checkpoint-browser-tests.mjs').then(m=>m.afterReload())"));
  const report = { passed: [...first.passed, ...second.passed], count: first.count + second.count, installedAppTouched: false };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ root, ...report }, null, 2));
} finally {
  await abx('stop').catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
