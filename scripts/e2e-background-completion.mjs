#!/usr/bin/env node
// A real executor and loopback provider prove background exit resumes sampling without a goal.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { AppServerConnection } from '../dist/app-server-connection.js';
import { startGateway } from '../dist/server.js';
import { gatewayToken } from '../dist/config.js';

const { values } = parseArgs({ options: {
  gateway: { type: 'string' }, control: { type: 'string' }, catalog: { type: 'string' }, root: { type: 'string' },
} });
assert.ok(values.gateway && values.catalog && values.root,
  'Usage: --gateway SDK --catalog MODELS_JSON --root NEW_PRIVATE_DIRECTORY [--control UNPATCHED_SDK]');
const root = resolve(values.root);
await mkdir(root, { mode: 0o700 });
const catalog = JSON.parse(await readFile(resolve(values.catalog), 'utf8'));
const base = catalog.models.find(row => row.slug === 'gpt-6.1-sol') ?? catalog.models[0];
assert.ok(base);
const fixtureKey = 'GATEWAY_BACKGROUND_UPSTREAM_FIXTURE_KEY';
assert.ok(!Object.hasOwn(process.env, fixtureKey));
process.env[fixtureKey] = 'fixture-only';

function findTool(tools, name, namespace) {
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      const found = findTool(tool.tools, name, tool.name);
      if (found) return found;
    } else if ((tool.name ?? tool.function?.name) === name) return { ...(tool.function ?? tool), namespace };
  }
}
function send(response, item, sequence) {
  const id = `resp_background_fixture_${sequence}`;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function sendAnthropic(response, item, sequence, toolName) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [{ type: 'message_start', message: { id: `msg_fixture_${sequence}`, usage: { input_tokens: 1 } } }];
  if (item.type === 'function_call') {
    events.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: item.call_id, name: toolName, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: item.arguments } },
      { type: 'content_block_stop', index: 0 });
  } else events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: item.content[0].text } });
  events.push({ type: 'message_delta', delta: { stop_reason: item.type === 'function_call' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

async function run(executable, name, options = {}) {
  const directory = await mkdtemp(join(root, `${name}-`));
  const home = join(directory, 'home'), work = join(directory, 'work'), tmp = join(directory, 'tmp');
  for (const path of [home, work, tmp]) await mkdir(path, { mode: 0o700 });
  const model = 'fixture/background-model';
  const followupModel = options.switchModel ? 'fixture/background-followup-model' : model;
  const aliases = [...new Set([model, followupModel])];
  await writeFile(join(home, 'models.json'), JSON.stringify({ models: aliases.map(slug => ({ ...base, slug,
    tool_mode: 'direct', use_responses_lite: false, supports_search_tool: false, node_repl_disabled: true, supported_in_api: true })) }), { mode: 0o600 });
  let requests = 0, schemaPresent = false, runtimeNotice = false, toolResult = false, finalOutputRead = false, sessionId;
  let callbackFailure, observedExitCode, appliedSettings;
  const models = new Set(), turns = [], eventMethods = [];
  const server = createServer(async (request, response) => {
    try {
      assert.ok(request.url.endsWith(options.anthropic ? '/messages' : '/responses'));
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 8 * 1024 * 1024); chunks.push(chunk); }
      const wire = JSON.parse(Buffer.concat(chunks));
      const body = options.anthropic ? {
        model: wire.model,
        tools: wire.tools.map(tool => ({ name: tool.input_schema.properties?.cmd ? 'exec_command' :
          tool.input_schema.properties?.session_id ? 'write_stdin' : tool.name,
        nativeName: tool.name, parameters: tool.input_schema })),
        input: wire.messages.flatMap(message => message.content.map(content => content.type === 'tool_result'
          ? { type: 'function_call_output', call_id: content.tool_use_id, output: content.content }
          : { content: [{ text: content.text ?? '' }] })),
      } : wire;
      requests++;
      assert.ok(requests <= 4, 'Unexpected inference loop');
      models.add(body.model);
      const exec = findTool(body.tools, 'exec_command');
      schemaPresent ||= Boolean(exec?.parameters?.properties?.notify_on_exit);
      for (const item of body.input ?? []) {
        if (item.type === 'function_call_output' && item.call_id === 'fixture-background-call') {
          const text = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
          const match = /Session ID:\s*(\d+)|session_id["\s:]*(\d+)/i.exec(text)
            ?? /Process running with session ID (\d+)/i.exec(text);
          if (match) sessionId = Number(match[1] ?? match[2]);
          toolResult = true;
        }
        if (item.type === 'function_call_output' && item.call_id === 'fixture-output-call') {
          finalOutputRead ||= JSON.stringify(item.output).includes('FIXTURE_FINISHED');
        }
        for (const content of item.content ?? []) {
          if (typeof content.text === 'string' && content.text.includes('source="background_exec"')) {
            runtimeNotice = true;
            const match = /"exit_code":(-?\d+)/.exec(content.text);
            observedExitCode = match ? Number(match[1]) : undefined;
          }
        }
      }
      let item;
      if (requests === 1) {
        assert.ok(exec, `Missing exec_command; declared tools: ${(body.tools ?? []).map(tool => tool.name ?? tool.function?.name ?? tool.type).join(', ')}`);
        assert.equal(Boolean(exec.parameters.properties.notify_on_exit), !options.control);
        item = { type: 'function_call', id: 'fixture-background-tool', call_id: 'fixture-background-call',
          name: 'exec_command', ...(exec.namespace ? { namespace: exec.namespace } : {}),
          arguments: JSON.stringify({ cmd: options.quick ? 'printf FIXTURE_FINISHED' :
            `/bin/sleep 2; printf FIXTURE_FINISHED; exit ${options.exitCode ?? 0}`,
          login: false, yield_time_ms: 250, max_output_tokens: 100,
          ...(options.control || options.notify === false ? {} : { notify_on_exit: true }) }), status: 'completed' };
      } else if (requests === 3 && !(options.resume && !runtimeNotice)) {
        const stdin = findTool(body.tools, 'write_stdin'); assert.ok(stdin && sessionId);
        item = { type: 'function_call', id: 'fixture-output-tool', call_id: 'fixture-output-call',
          name: 'write_stdin', ...(stdin.namespace ? { namespace: stdin.namespace } : {}),
          arguments: JSON.stringify({ session_id: sessionId, chars: '', yield_time_ms: 1000, max_output_tokens: 100 }), status: 'completed' };
      } else {
        item = { type: 'message', role: 'assistant', id: `fixture-final-${requests}`, phase: 'final_answer',
          content: [{ type: 'output_text', text: requests === 2 ? 'Fixture job started.' : 'Fixture completion received.' }] };
      }
      if (options.anthropic) sendAnthropic(response, item, requests, findTool(body.tools, item.name)?.nativeName);
      else send(response, item, requests);
    } catch (error) { callbackFailure = error; if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const stateDirectory = join(directory, 'gateway-state');
  const gateway = await startGateway({ version: 1, port: 0, stateDirectory,
    providers: [{ id: 'fixture', type: options.anthropic ? 'anthropic-api' : 'responses-api',
      baseUrl: `http://127.0.0.1:${server.address().port}`, apiKeyEnv: fixtureKey,
      models: Object.fromEntries(aliases.map(alias => [alias, alias])) }] },
  undefined, undefined, { heartbeatMs: 100 });
  const config = `model = "${model}"\nmodel_provider = "subscription_gateway"\n` +
    `model_catalog_json = ${JSON.stringify(join(home, 'models.json'))}\nweb_search = "disabled"\n` +
    '[features]\nplugins = false\nhooks = false\ncode_mode_host = false\n' +
    '[model_providers.subscription_gateway]\nname = "Subscription Gateway fixture"\n' +
    `base_url = "http://127.0.0.1:${gateway.address().port}/v1"\nwire_api = "responses"\n` +
    'env_key = "GATEWAY_BACKGROUND_CLIENT_FIXTURE_KEY"\n' +
    'requires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n';
  await writeFile(join(home, 'config.toml'), config, { mode: 0o600 });
  const client = new AppServerConnection(executable, ['app-server', '--listen', 'stdio://'], message => {
    if (message.method) eventMethods.push(message.method);
    if (message.method === 'turn/completed') turns.push(message.params.turn);
    if (message.method === 'thread/settings/updated') appliedSettings = message.params.threadSettings;
    if (message.id !== undefined && message.method) {
      client.send({ id: message.id, error: { code: -32601, message: 'Fixture refuses unexpected client callback' } });
    }
  }, () => {}, { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CODEX_HOME: home, TMPDIR: tmp,
    HARNESS_GATEWAY_EXECUTOR: options.control ? '0' : '1', GATEWAY_ERROR_REPORTS: 'off',
    GATEWAY_BACKGROUND_CLIENT_FIXTURE_KEY: await gatewayToken(stateDirectory),
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' });
  async function until(check, label) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (callbackFailure) throw callbackFailure;
      if (check()) return;
      await delay(25);
    }
    throw Error(`Timed out: ${name} ${label}`);
  }
  try {
    await client.request('initialize', { clientInfo: { name: 'background_completion_fixture', version: '1' },
      capabilities: { experimentalApi: true } });
    client.send({ method: 'initialized', params: {} });
    const started = await client.request('thread/start', { model, modelProvider: 'subscription_gateway', cwd: work,
      approvalPolicy: 'never', sandbox: 'danger-full-access' });
    const threadId = started.thread.id;
    await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'Run the finite fixture command.' }] });
    await until(() => turns.length >= 1, 'initial turn');
    assert.equal(turns[0].status, 'completed');
    assert.equal(toolResult, true);
    if (!options.quick) assert.ok(sessionId, 'The initial command must return a tracked session');
    if (options.stop) await client.request('turn/interrupt', { threadId, turnId: '' });
    if (options.resume) {
      await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'Acknowledge this explicit continuation.' }] });
      await until(() => turns.length === 2, 'explicit resumed turn');
    }
    if (options.switchModel) {
      await client.request('thread/settings/update', { threadId, model: followupModel,
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
      await until(() => appliedSettings?.model === followupModel, 'applied model switch');
      assert.equal(appliedSettings.sandboxPolicy.type, 'readOnly');
      assert.equal(appliedSettings.approvalPolicy, 'never');
    }
    if (options.terminate) await client.request('thread/backgroundTerminals/clean', { threadId });
    if (options.terminateOne) {
      const result = await client.request('thread/backgroundTerminals/terminate', { threadId, processId: String(sessionId) });
      assert.equal(result.terminated, true);
    }
    const expectWake = !options.control && options.notify !== false && !options.quick && !options.stop && !options.terminate && !options.terminateOne;
    if (expectWake) {
      await until(() => turns.length === 2, 'automatic completion turn');
      assert.equal(turns[1].status, 'completed');
      assert.equal(runtimeNotice, true);
      assert.equal(observedExitCode, options.exitCode ?? 0);
      assert.equal(requests, 4);
      assert.equal(finalOutputRead, true);
    } else {
      await until(() => eventMethods.includes('item/completed'), 'terminal event');
      await delay(3000);
      assert.equal(turns.length, options.resume ? 2 : 1);
      assert.equal(requests, options.resume ? 3 : 2);
      assert.equal(runtimeNotice, false);
    }
    assert.deepEqual([...models], aliases);
    if (options.switchModel) {
      assert.equal(appliedSettings.model, followupModel);
      assert.equal(appliedSettings.sandboxPolicy.type, 'readOnly');
      assert.equal(appliedSettings.approvalPolicy, 'never');
    }
    assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), config);
    const result = { name, passed: true, requests, turns: turns.length, schemaPresent, runtimeNotice, finalOutputRead,
      wireProtocol: options.anthropic ? 'anthropic-messages' : 'responses',
      selectedModelPreserved: true, nativeHomeIsolated: true, ...(runtimeNotice ? { observedExitCode } : {}) };
    console.log(JSON.stringify(result)); return result;
  } finally {
    client.stop(); await client.exited;
    gateway.closeAllConnections(); await new Promise(done => gateway.close(done));
    server.closeAllConnections(); await new Promise(done => server.close(done));
  }
}

const gateway = await realpath(resolve(values.gateway)), results = [];
for (const [name, options] of [
  ['notify-success', {}], ['notify-failure', { exitCode: 7 }],
  ['default-no-notify', { notify: false }], ['quick-no-duplicate', { quick: true }],
  ['interrupt-cancels', { stop: true }], ['terminal-stop-cancels', { terminate: true }],
  ['single-terminal-stop-cancels', { terminateOne: true }],
  ['stop-resume-drops-old', { stop: true, resume: true }], ['current-model-after-switch', { switchModel: true }],
  ['anthropic-notify-success', { anthropic: true }], ['anthropic-notify-failure', { anthropic: true, exitCode: 7 }],
]) results.push(await run(gateway, name, options));
if (values.control) results.push(await run(await realpath(resolve(values.control)), 'unpatched-control', { control: true }));
await writeFile(join(root, 'result.json'), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(),
  zeroPaidInference: true, goalsCreated: 0, gatewaySha256: createHash('sha256').update(await readFile(gateway)).digest('hex'),
  results }, null, 2) + '\n', { mode: 0o600 });
delete process.env[fixtureKey];
