import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export const fixtureModels = [
  { slug: 'claude-hg-route-107001', display_name: 'Gateway trial · Reasoning',
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort, description: `${effort} reasoning` })),
    default_reasoning_level: 'medium', service_tiers: [{ id: 'priority', name: 'Fast', description: 'Fixture priority transport' }],
    supports_ultracode: true,
    default_service_tier: null, context_window: 200000 },
  { slug: 'claude-hg-route-107002', display_name: 'Gateway trial · Standard only',
    supported_reasoning_levels: ['low', 'high'].map(effort => ({ effort, description: `${effort} reasoning` })),
    default_reasoning_level: 'high', service_tiers: [], default_service_tier: null, context_window: 200000 },
];

/** Local, synthetic inference only. Receipts contain controls, never prompts, tool arguments or credentials. */
export async function startNativePickerFixture(root) {
  const state = resolve(root);
  await mkdir(state, { mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const tokenFile = join(state, 'client-token');
  await writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 });
  const requests = [];
  const server = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
    if (req.headers.authorization !== `Bearer ${token}` && req.headers['x-api-key'] !== token) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'Fixture credential required' } });
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && route === '/health') return send(200, { status: 'ok' });
    if (req.method === 'GET' && route === '/v1/model-catalog') return send(200, { models: fixtureModels });
    if (req.method === 'GET' && /^\/api\/model_selector\/(cc|ccd|ccr|code)$/.test(route)) {
      const surface = route.split('/').at(-1);
      return send(200, { model_selector_config: [{ id: surface, models: fixtureModels.map(model => ({
        id: model.slug, name: model.display_name, context_window: model.context_window,
        runtime: { effort_levels: model.supported_reasoning_levels.map(level => level.effort), default_effort: model.default_reasoning_level },
      })) }] });
    }
    if (req.method === 'GET' && route === '/v1/models') return send(200, { data: fixtureModels.map(m => ({ id: m.slug, display_name: m.display_name, type: 'model', created_at: '2026-10-24T00:00:00Z' })), has_more: false });
    if (req.method !== 'POST' || route !== '/v1/messages') return send(404, { type: 'error', error: { type: 'not_found_error', message: 'Unknown fixture route' } });
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) return send(413, { type: 'error', error: { type: 'invalid_request_error', message: 'Fixture request too large' } }); chunks.push(chunk); }
    let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Expected an object' } });
    if (!fixtureModels.some(m => m.slug === body.model)) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Unknown fixture model' } });
    const allowed = (value, values) => values.includes(value) ? value : value == null ? null : 'unrecognized';
    requests.push({ model: body.model,
      effort: allowed(body.output_config?.effort, ['low', 'medium', 'high', 'xhigh', 'max']),
      tier: allowed(body.service_tier, ['auto', 'standard', 'priority', 'default', 'flex']),
      thinking: allowed(body.thinking?.type, ['enabled', 'disabled', 'adaptive']), stream: body.stream === true });
    const message = { id: `msg_fixture_${requests.length}`, type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: 'NATIVE_PICKER_OK' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } };
    if (!body.stream) return send(200, message);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'NATIVE_PICKER_OK' } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    event('message_stop', {}); res.end();
    } catch {
      if (!res.headersSent && !res.destroyed) send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Fixture request interrupted' } });
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, tokenFile, requests,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
