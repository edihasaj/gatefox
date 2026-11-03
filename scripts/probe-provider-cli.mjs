// Runs only inside a private candidate HOME, without a user prompt or real provider credentials.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [kind, executable, checkout, directory, version] = process.argv.slice(2);
if (kind === 'copilot') {
  // The gateway's own command line for this verified version, so the probe proves exactly what production launches.
  const { CopilotRPC, copilotCliArgs } = await import(pathToFileURL(join(checkout, 'dist/providers/copilot-rpc.js')));
  const child = spawn(executable, copilotCliArgs(directory, version),
  { cwd: directory, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new CopilotRPC(process.env, directory, child);
  try { if ((await rpc.request('connect')).protocolVersion !== 3) throw Error('Unsupported Copilot protocol'); }
  finally { rpc.stop(); await rpc.exited; }
} else if (kind === 'claude') {
  const { claudeCliArgs, controlLine } = await import(pathToFileURL(join(checkout, 'dist/providers/claude-control.js')));
  const mcpPath = join(directory, 'mcp.json'); const systemPath = join(directory, 'system.txt');
  writeFileSync(mcpPath, '{"mcpServers":{}}', { mode: 0o600 }); writeFileSync(systemPath, 'Compatibility probe.', { mode: 0o600 });
  const args = claudeCliArgs({ mcpPath, systemPath, model: 'compatibility-probe', effort: 'medium', fast: false, thinkingDisplay: true });
  const child = spawn(executable, args, { cwd: directory, env: { ...process.env,
    ANTHROPIC_API_KEY: 'local-compatibility-probe', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
  stdio: ['pipe', 'pipe', 'pipe'] });
  const request = controlLine('initialize', { hooks: {} });
  child.stderr.resume();
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Claude control initialization timed out')), 15_000);
      const fail = () => { clearTimeout(timer); reject(Error('Claude control initialization failed')); };
      child.once('error', fail); child.once('exit', fail); child.stdin.on('error', fail);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (output.length > 1024 * 1024) { fail(); return; }
        let end;
        while ((end = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { fail(); return; }
          if (message.type !== 'control_response' || message.response?.request_id !== request.requestId) continue;
          clearTimeout(timer);
          if (message.response.subtype !== 'success') reject(Error('Claude control protocol changed')); else resolve();
        }
      });
      child.stdin.write(request.line);
    });
  } finally {
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGKILL');
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (child.exitCode === null && child.signalCode === null) await closed;
  }
} else throw Error('Unknown provider probe');
