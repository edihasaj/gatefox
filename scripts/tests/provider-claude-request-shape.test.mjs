import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyRequest, evaluate, loadGateway, probeClaudeRequestShape, scenarios } from '../claude-request-shape.mjs';
import { qualifyClaudeRequestShape } from '../validate-provider-cli.mjs';

const checkout = resolve(import.meta.dirname, '../..');
const gateway = await loadGateway(checkout);
const body = { model: 'codex/x', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] };
const metadata = { user_id: JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: '019a1234-5678-7890-abcd-0123456789ab' }) };

test('a known field is a recovered rejection, and an unknown one is a new shape', () => {
  assert.equal(classifyRequest(body, gateway).verdict, 'accepted');
  assert.deepEqual(classifyRequest({ ...body, safeguards: [] }, gateway).fields, ['safeguards']);
  assert.equal(classifyRequest({ ...body, safeguards: [] }, gateway).verdict, 'known_rejection');
  const deferred = { ...body, tools: [{ name: 't', input_schema: { type: 'object' }, defer_loading: true }] };
  assert.equal(classifyRequest(deferred, gateway).verdict, 'known_rejection');
  const unknown = classifyRequest({ ...body, brand_new_field: true }, gateway);
  assert.equal(unknown.verdict, 'new_rejection'); assert.deepEqual(unknown.fields, ['brand_new_field']);
  assert.equal(classifyRequest({ ...body, safeguards: [], brand_new_field: true }, gateway).verdict, 'new_rejection', 'a known field cannot hide a new one');
});

test('the classifier controls are only known on a side request', () => {
  const classifier = { ...body, stop_sequences: ['x'], thinking: { type: 'disabled' } };
  assert.equal(classifyRequest(classifier, gateway, undefined, 'auxiliary').verdict, 'known_rejection');
  assert.equal(classifyRequest(classifier, gateway, undefined, 'main').verdict, 'new_rejection');
});

const accepted = { verdict: 'accepted', fields: [], topLevel: [], toolFields: [], betas: [], requestClass: 'main', agent: false, parentSessionId: 'session', sessionId: 'session' };
const finished = { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHAPE_OK', modelUsage: {} }) };
const state = requests => ({ requests, failures: [] });
const plain = { name: 'plain' };

test('a clean run passes and every lost contract fails', () => {
  assert.deepEqual(evaluate(plain, state([accepted]), finished).failures, []);
  const failing = (scenario, requests, run = finished) => evaluate(scenario, state(requests), run).failures;
  assert.ok(failing(plain, [{ ...accepted, verdict: 'new_rejection' }, accepted]).includes('new_rejection'), 'a client that recovered still blocks');
  assert.ok(failing(plain, [accepted], { stdout: JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 400' }) }).includes('client_did_not_finish'));
  assert.ok(failing(plain, [accepted], { timedOut: true, stdout: '' }).includes('client_timeout'));
  assert.ok(failing(plain, [{ ...accepted, requestClass: undefined }]).includes('request_class_missing'));
  assert.ok(failing(plain, [{ ...accepted, parentSessionId: undefined }]).includes('session_identity_missing'));
  assert.ok(failing({ name: 'read', script: 'read' }, [accepted]).includes('tool_result_missing'));
  assert.ok(failing({ name: 'agent', expectSubagent: true }, [accepted, { ...accepted, agent: true }]).includes('subagent_identity_shared'));
  assert.ok(failing({ name: 'auto', permissionMode: 'auto' }, [accepted, { ...accepted, agent: true, sessionId: 'child' }]).includes('auto_review_behavior_changed'));
  assert.ok(failing({ name: 'auto', permissionMode: 'auto' }, [accepted]).includes('classifier_missing'), 'a run with no classifier proves nothing');
  assert.ok(failing({ name: 'mcp', mcp: true }, [{ ...accepted, mcpTools: 0 }]).includes('mcp_tools_missing'));
  assert.deepEqual(failing({ name: 'mcp', mcp: true }, [{ ...accepted, mcpTools: 60 }]), []);
  assert.ok(failing(plain, [accepted], { ...finished, code: 1 }).includes('client_exit'), 'success text does not excuse a failed exit');
  assert.ok(failing({ name: 'window', window: 400000 }, [accepted]).includes('context_window_ignored'), 'a run that reports no window proves nothing');
  const window = { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHAPE_OK', modelUsage: { m: { contextWindow: 200000 } } }) };
  assert.ok(failing({ name: 'window', window: 400000 }, [accepted], window).includes('context_window_ignored'));
});

function fakeClaude(extra) {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-shape-client-'));
  const script = join(directory, 'claude');
  writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--settings') + 1], 'utf8'));
const body = { model: 'codex/x', max_tokens: 8, stream: true, metadata: ${JSON.stringify(metadata)}, messages: [{ role: 'user', content: 'hi' }], ...${JSON.stringify(extra)} };
fetch(settings.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', { method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-request-class': 'main', 'anthropic-beta': 'probe-beta' }, body: JSON.stringify(body) })
  .then(response => response.text()).then(() => console.log(JSON.stringify({ type: 'result', is_error: false, result: 'SHAPE_OK', modelUsage: {} })));
`);
  chmodSync(script, 0o755);
  return { script, root: join(directory, 'root') };
}

test('a new field blocks even when the client finishes, and the report names it without content', async () => {
  const { script, root } = fakeClaude({ brand_new_field: 'private prompt text' });
  const report = await probeClaudeRequestShape({ command: script, checkout, root, only: [scenarios[1]] });
  assert.equal(report.passed, false);
  assert.deepEqual(report.scenarios[0].newRejectionFields, ['brand_new_field']);
  assert.equal(JSON.stringify(report).includes('private prompt text'), false);
});

test('a request a real adapter refuses blocks the update, as the Qwen effort failure would have', async () => {
  const { script, root } = fakeClaude({ output_config: { effort: 'high' } });
  const report = await probeClaudeRequestShape({ command: script, checkout, root, only: [scenarios[1]] });
  assert.equal(report.passed, false);
  assert.deepEqual(report.scenarios[0].newRejectionFields, ['route:chat-completions-api']);
});

test('a valid forced tool choice is not mistaken for a refusal', async () => {
  const { script, root } = fakeClaude({ tools: [{ name: 'lookup', input_schema: { type: 'object' } }], tool_choice: { type: 'any' } });
  const report = await probeClaudeRequestShape({ command: script, checkout, root, only: [scenarios[1]] });
  assert.deepEqual(report.scenarios[0].failures, []);
});

test('an unchanged shape passes and records the fields and betas it saw', async () => {
  const { script, root } = fakeClaude({});
  const report = await probeClaudeRequestShape({ command: script, checkout, root, only: [scenarios[1]] });
  assert.equal(report.passed, true);
  assert.ok(report.topLevelFields.includes('metadata')); assert.deepEqual(report.betas, ['probe-beta']);
});

test('the update gate keeps only the field receipt and refuses a report that did not pass', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-shape-gate-'));
  const receipt = { knownRejections: ['safeguards'], topLevelFields: ['model'], toolFields: [], betas: ['b'], requestClasses: ['main'] };
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); return JSON.stringify({ passed: true, scenarios: [{ private: true }], ...receipt }); };
  assert.deepEqual(await qualifyClaudeRequestShape('/candidate/claude', checkout, directory, { HOME: directory }, run), receipt);
  assert.ok(calls[0].args.includes('/candidate/claude')); assert.ok(calls[0].args.includes(checkout));
  assert.deepEqual(calls[0].options.env, { HOME: directory }, 'the check runs in the credential-free validation environment');
  await assert.rejects(qualifyClaudeRequestShape('/c', checkout, directory, {}, async () => JSON.stringify({ passed: false })), /request shape changed/);
  assert.equal(existsSync(join(directory, 'request-shape')), false);
});
