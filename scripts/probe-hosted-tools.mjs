#!/usr/bin/env node
// Asks the ChatGPT backend directly whether it accepts OpenAI's hosted `web_search` tool and Codex's client-executed
// `tool_search` tool, so the gateway can turn them on for Codex 2 rows only where the backend really takes them.
// The gateway posts subscription requests to https://api.openai.com/v1 without `ChatGPT-Account-ID`; native Codex with a
// ChatGPT login posts to https://chatgpt.com/backend-api/codex with that header and `originator`. Each case varies
// endpoint x headers x tools, so one run shows which difference matters.
// Privacy: the access token and account id stay in memory. Output holds only HTTP status, fixed error fields, a scrubbed
// and capped error message, stream event types and output item types. No request body, response text or header value.
// Uses real inference on the Codex subscription (one short request per case). `--dry-run` lists the cases offline.
// Example: node scripts/probe-hosted-tools.mjs --config "$HOME/Library/Application Support/Subscription Gateway/gateway.json"
//   --output /tmp/FRESH_DIR/hosted-tools.json [--alias codex/gpt-6.1-sol] [--only web_search,tool_search] [--dry-run]
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values: options } = parseArgs({ options: { config: { type: 'string' }, output: { type: 'string' },
  alias: { type: 'string', default: 'codex/gpt-6.1-sol' }, only: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
if (!options.config || !options.output) throw Error('Usage: probe-hosted-tools.mjs --config GATEWAY_JSON --output FILE [--alias A] [--only tools] [--dry-run]');

const endpoints = { platform: 'https://api.openai.com/v1', codex: 'https://chatgpt.com/backend-api/codex' };
// The exact shape native Codex sends (codex-rs/core/src/tools/handlers/tool_search_spec.rs at the pinned revision).
const toolSearch = { type: 'tool_search', execution: 'client',
  description: '# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\n',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Maximum number of tools to return. Defaults to 8.' },
    query: { type: 'string', description: 'Search query for deferred tools.' } }, required: ['query'], additionalProperties: false } };
const toolSets = { baseline: [], web_search: [{ type: 'web_search' }], tool_search: [toolSearch] };
const wanted = options.only ? new Set(['baseline', ...options.only.split(',')]) : new Set(Object.keys(toolSets));
for (const name of wanted) if (!toolSets[name]) throw Error(`Unknown tool set: ${name}`);
const cases = [];
for (const endpoint of Object.keys(endpoints)) for (const headers of ['bare', 'native']) for (const tools of Object.keys(toolSets))
  if (wanted.has(tools)) cases.push({ endpoint, headers, tools });
if (options['dry-run']) { console.log(JSON.stringify({ dryRun: true, cases }, null, 1)); process.exit(0); }

const config = JSON.parse(await readFile(resolve(options.config), 'utf8'));
const provider = (config.providers || []).find(entry => entry.type === 'codex-subscription' && entry.models && Object.hasOwn(entry.models, options.alias));
if (!provider?.credentialFile) throw Error(`No codex-subscription provider serves ${options.alias}`);
// The gateway resolves a relative credential path against the configuration file's folder (src/config.ts), so the probe does too.
const credentialFile = resolve(dirname(resolve(options.config)), provider.credentialFile);
const model = provider.models[options.alias];
const { accessToken, readCredentials } = await import(new URL('../dist/auth/chatgpt.js', import.meta.url));
// Never refresh here: the refresh token is single-use and belongs to the running gateway.
const token = await accessToken(credentialFile, { refresh: false }).catch(() => { throw Error('The login needs a refresh; send one gateway request first, then rerun'); });
const credentials = await readCredentials(credentialFile);
// The account id is a claim inside the ID token; it is decoded in memory and never printed.
let accountId;
try { accountId = JSON.parse(Buffer.from(String(credentials?.id_token || '').split('.')[1] || '', 'base64url').toString('utf8'))?.['https://api.openai.com/auth']?.chatgpt_account_id; } catch { accountId = undefined; }

const fixed = value => typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : value === undefined || value === null ? undefined : 'other';
// Upstream messages can echo request details; long opaque runs are removed and the text is capped.
const scrub = text => typeof text === 'string' ? text.replace(/[A-Za-z0-9_\-+/=.]{24,}/g, '[redacted]').replace(/\s+/g, ' ').slice(0, 240) : undefined;

async function probe({ endpoint, headers, tools }) {
  const body = { model, instructions: 'You are a connectivity probe. Reply with the single word OK.', stream: true, store: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }],
    tools: toolSets[tools], tool_choice: 'auto', parallel_tool_calls: false, reasoning: { effort: 'low' } };
  const sent = { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}`,
    ...(headers === 'native' ? { originator: 'codex_cli_rs', ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}) } : {}) };
  const control = new AbortController(); const timer = setTimeout(() => control.abort(), 45_000);
  const row = { endpoint, headers, tools, accountIdSent: headers === 'native' && !!accountId };
  try {
    const response = await fetch(`${endpoints[endpoint]}/responses`, { method: 'POST', redirect: 'manual', signal: control.signal, headers: sent, body: JSON.stringify(body) });
    row.status = response.status;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      const error = parsed?.error ?? parsed?.detail ?? parsed;
      Object.assign(row, { errorCode: fixed(error?.code), errorType: fixed(error?.type), errorParam: fixed(error?.param),
        message: scrub(typeof error === 'string' ? error : error?.message ?? (parsed ? undefined : text.slice(0, 400))),
        contentType: fixed(response.headers.get('content-type')?.split(';')[0]) });
      return row;
    }
    const events = new Set(); const items = new Set(); let buffer = ''; let terminal;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        let event; try { event = JSON.parse(line.slice(5)); } catch { continue; }
        if (typeof event.type === 'string') events.add(fixed(event.type));
        if (event.item?.type) items.add(fixed(event.item.type));
        if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type)) {
          terminal = event.type;
          if (event.type !== 'response.completed') { const error = event.response?.error ?? event.error; row.errorCode = fixed(error?.code); row.message = scrub(error?.message); }
        }
      }
      if (terminal) break;
    }
    Object.assign(row, { terminal: terminal ?? 'eof', eventTypes: [...events].sort(), outputItemTypes: [...items].sort() });
    control.abort();
  } catch (error) { row.status ??= 0; row.failure = control.signal.aborted && !row.terminal ? 'timeout' : fixed(error?.cause?.code ?? error?.name); }
  finally { clearTimeout(timer); }
  return row;
}

const results = [];
const save = () => writeFile(resolve(options.output), JSON.stringify({ alias: options.alias, model, at: new Date().toISOString(), results }, null, 2) + '\n', { mode: 0o600 });
for (const entry of cases) {
  const row = await probe(entry); results.push(row); await save();
  console.log(JSON.stringify(row));
  // A spent allowance fails every case alike; stop instead of spending more requests on the same answer.
  if (row.status === 429) { results.push({ stopped: 'rate_or_usage_limit' }); await save(); break; }
  await delay(1500);
}
const verdict = name => results.filter(row => row.tools === name).map(row => `${row.endpoint}/${row.headers}=${row.status}${row.terminal ? `:${row.terminal}` : ''}`).join(' ');
console.log(JSON.stringify({ summary: Object.fromEntries([...wanted].map(name => [name, verdict(name)])) }));
