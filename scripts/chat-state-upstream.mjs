import { createServer } from 'node:http';
import { once } from 'node:events';

/** A synthetic Responses provider. It cuts one frame while the shared SDK has no viewing clients. */
export async function chatStateUpstream({ currentCall, gate, fail }) {
  const stats = { requests: 0, truncatedFrames: 0, prematureDisconnects: 0 };
  let began;
  const truncated = new Promise(resolve => { began = resolve; });
  const server = createServer((req, res) => { void (async () => {
    for await (const _ of req) { /* Never retain or log the fixture request. */ }
    const attempt = ++stats.requests, call = currentCall();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const cut = call === 3 && stats.truncatedFrames === 0;
    if (cut) { stats.truncatedFrames++; res.write('data: {"type":"response.output_text.delta","delta":"'); began(); }
    let ended;
    const disconnected = new Promise((_, reject) => {
      ended = () => { if (!res.writableEnded) { stats.prematureDisconnects++; reject(Error('Fixture caller disconnected')); } };
      res.once('close', ended);
    });
    try {
      if (gate()) await Promise.race([gate(), disconnected]);
      if (res.destroyed) return;
      if (cut) { res.end(); return; }
      if (fail()) { res.end('data: {"type":"error","error":{"code":"usage_limit_reached"}}\n\n'); return; }
      const item = { id: `msg_fixture_${attempt}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture answer.', annotations: [] }] };
      const frames = [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Fixture answer.' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `resp_fixture_${attempt}`, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
      ];
      res.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    } catch { if (!res.destroyed) res.destroy(); }
    finally { res.off('close', ended); }
  })().catch(() => { if (!res.destroyed) res.destroy(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, stats, truncated,
    close: async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}
