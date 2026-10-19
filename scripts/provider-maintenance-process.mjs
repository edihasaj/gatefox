import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

/** Private, credential-free child environment. Validators never inherit provider login exports. */
export function validationEnvironment(home, extra = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home,
    LANG: 'en_US.UTF-8', CODEX_HOME: `${home}/.codex`, CLAUDE_CONFIG_DIR: `${home}/.claude`,
    COPILOT_HOME: `${home}/.copilot`, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...extra };
}

/** Bound owned process groups; discard diagnostics so upstream errors cannot print request bodies. */
export function runValidation(command, args, { cwd, env, timeoutMs = 120_000, maximumOutput = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0; let failed = false;
    const signal = name => { if (child.pid) { try { process.kill(-child.pid, name); } catch {} } };
    let escalation;
    const stop = () => {
      if (failed) return;
      failed = true; signal('SIGTERM');
      // The test runner owns a detached suite and needs its own teardown grace.
      escalation = setTimeout(() => { signal('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); }, 15_000);
    };
    const timer = setTimeout(stop, timeoutMs);
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maximumOutput) stop(); else chunks.push(chunk); });
    const compilerCodes = new Set();
    child.stderr.on('data', chunk => {
      for (const match of chunk.toString().matchAll(/(?:error\[(E\d+)\]|error (TS\d+))/g)) compilerCodes.add(match[1] ?? match[2]);
    });
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(escalation); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
      // The leader has exited; any remaining members belong to this completed validator.
      signal('SIGKILL');
      if (failed || code !== 0) {
        const output = Buffer.concat(chunks).toString('utf8');
        const files = [...new Set([...output.matchAll(/(?:test at |\/)(dist\/tests\/[a-zA-Z0-9._/-]+\.test\.js):\d+/g)].map(match => match[1]))];
        reject(Object.assign(Error('Provider candidate validation failed'), { failureFiles: files, compilerCodes: [...compilerCodes] }));
      }
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
