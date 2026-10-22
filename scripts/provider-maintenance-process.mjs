import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { ValidationDiagnostics } from './provider-maintenance-diagnostics.mjs';

/** Private, credential-free child environment. Validators never inherit provider login exports. */
export function validationEnvironment(home, extra = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home,
    LANG: 'en_US.UTF-8', CODEX_HOME: `${home}/.codex`, CLAUDE_CONFIG_DIR: `${home}/.claude`,
    COPILOT_HOME: `${home}/.copilot`, DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', GATEWAY_TEST_CONCURRENCY: '4', ...extra };
}

/** Bound owned process groups; discard diagnostics so upstream errors cannot print request bodies. */
export function runValidation(command, args, { cwd, env, timeoutMs = 120_000, maximumOutput = 4 * 1024 * 1024, abortSignal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch {
      reject(Object.assign(Error('Provider candidate validation failed'), { failureReason: 'spawn_error', failureFiles: [], compilerCodes: [] })); return;
    }
    const chunks = []; let size = 0; let reason; let stopped = false;
    const diagnostics = new ValidationDiagnostics(cwd);
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const leftovers = ['', ''];
    const read = (index, chunk) => {
      const text = leftovers[index] + decoders[index].write(chunk);
      const lines = text.split(/\r?\n/); leftovers[index] = lines.pop() ?? '';
      for (const line of lines) diagnostics.line(line);
      if (leftovers[index].length > 8 * 1024) { diagnostics.line(leftovers[index]); leftovers[index] = ''; }
    };
    const finishDiagnostics = () => {
      for (const [index, decoder] of decoders.entries()) {
        const final = leftovers[index] + decoder.end();
        if (final) diagnostics.line(final);
      }
    };
    const setReason = value => { if (!reason) reason = value; };
    const signal = name => { if (child.pid) { try { process.kill(-child.pid, name); } catch {} } };
    let escalation;
    const stop = value => {
      setReason(value);
      if (stopped) return;
      stopped = true; signal('SIGTERM');
      // The test runner owns a detached suite and needs its own teardown grace.
      escalation = setTimeout(() => { signal('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); }, 15_000);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const cancelled = () => stop('cancelled');
    process.once('SIGTERM', cancelled); process.once('SIGINT', cancelled);
    const aborted = () => stop('cancelled');
    if (abortSignal?.aborted) aborted(); else abortSignal?.addEventListener('abort', aborted, { once: true });
    const receive = (index, chunk) => {
      read(index, chunk); size += chunk.length;
      if (size > maximumOutput) stop('output_limit');
      else if (index === 0) chunks.push(chunk);
    };
    child.stdout.on('data', chunk => receive(0, chunk));
    child.stderr.on('data', chunk => receive(1, chunk));
    child.once('error', () => { setReason('spawn_error'); });
    child.once('close', (code, closeSignal) => {
      clearTimeout(timer); clearTimeout(escalation); process.removeListener('SIGTERM', cancelled); process.removeListener('SIGINT', cancelled);
      abortSignal?.removeEventListener('abort', aborted);
      // The leader has exited; any remaining members belong to this completed validator.
      signal('SIGKILL');
      finishDiagnostics();
      if (!reason && (code !== 0 || closeSignal)) setReason('nonzero_exit');
      if (reason) {
        const metadata = diagnostics.metadata();
        reject(Object.assign(Error('Provider candidate validation failed'), {
          failureReason: reason,
          ...(Number.isInteger(code) && code >= 0 ? { exitCode: code } : {}),
          ...(typeof closeSignal === 'string' ? { signal: closeSignal } : {}),
          failureFiles: metadata.failureFiles ?? [], compilerCodes: metadata.compilerCodes ?? [], ...metadata,
        }));
      }
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
