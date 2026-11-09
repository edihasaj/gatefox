// Opt-in live availability-policy E2E. It uses real subscription inference, but
// keeps every client/SDK state file in /tmp and writes only a scrubbed receipt.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: {
  package: { type: 'string' }, code: { type: 'string' }, config: { type: 'string' }, root: { type: 'string' },
  model: { type: 'string' }, 'child-status': { type: 'boolean' }, context: { type: 'string' }, policy: { type: 'string' }, roles: { type: 'string' }, scenario: { type: 'string', default: 'healthy' },
} });
for (const key of ['package', 'config', 'root', 'model', 'context', 'policy', 'roles']) assert.ok(values[key], `Pass --${key}`);
assert.ok(['healthy', 'held-worker', 'local-unhealthy', 'unknown-source', 'worker-failure'].includes(values.scenario), '--scenario must be healthy, held-worker, local-unhealthy, unknown-source, or worker-failure');

const code = resolve(values.code ?? new URL('..', import.meta.url).pathname);
const packagePath = resolve(values.package), sourceConfigPath = resolve(values.config), root = resolve(values.root);
const helperPath = resolve(values.context), policyPath = resolve(values.policy), scenario = values.scenario, parentAlias = values.model;
const originalHome = process.env.HOME;
assert.ok(originalHome && originalHome.startsWith('/'), 'An absolute original HOME is required');
const originalSpendwatch = resolve(originalHome, '.local/bin/spendwatch');
const execText = (file, args, options = {}) => new Promise(resolveDone => {
  execFile(file, args, { timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 524_288, encoding: 'utf8', windowsHide: true, ...options }, (error, stdout, stderr) =>
    resolveDone({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});
const pythonCandidate = await execText('/usr/bin/which', ['python3']);
assert.ok(pythonCandidate.ok && /^\/[^\r\n]+$/.test(pythonCandidate.stdout.trim()), 'A resolved python3 is required');
const pythonPath = pythonCandidate.stdout.trim();
const pythonVersion = await execText(pythonPath, ['--version']);
const versionMatch = `${pythonVersion.stdout}\n${pythonVersion.stderr}`.match(/Python\s+(\d+)\.(\d+)/);
assert.ok(pythonVersion.ok && versionMatch && (Number(versionMatch[1]) > 3 || Number(versionMatch[1]) === 3 && Number(versionMatch[2]) >= 11), 'Python 3.11+ is required');
// Read production configuration before changing HOME. This resolves the original
// credential/auth locations in memory; no credential is copied into the fixture.
const load = name => import(pathToFileURL(join(code, 'dist', `${name}.js`)));
const { loadConfig, writePrivateJson, gatewayToken } = await load('config');
const original = await loadConfig(sourceConfigPath);
await Promise.all([access(helperPath, constants.R_OK), access(policyPath, constants.R_OK)]);

const fixture = await mkdtemp('/tmp/availability-agent-');
const home = join(fixture, 'home'), native = join(fixture, 'native'), state = join(fixture, 'state'), work = join(fixture, 'work');
// The SDK auto-loads `<CODEX_HOME>/agents`; keep the copied role definitions
// elsewhere because they are also registered explicitly below.
const roleDirectory = join(native, 'role-files');
for (const folder of [root, home, native, state, work, roleDirectory]) await mkdir(folder, { recursive: true, mode: 0o700 });
process.env.HOME = home;
process.env.CODEX_HOME = native;
process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
process.env.GATEWAY_TELEMETRY = 'off';
process.env.GATEWAY_ERROR_REPORTS = 'off';
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'HARNESS_GATEWAY_EXECUTOR', 'GATEFOX_EXECUTOR']) delete process.env[key];

const { gatewaySdkRuntime } = await load('gateway-sdk-runtime');
const { AppServerBackends } = await load('app-server-backends');
const { AppServerRouter } = await load('app-server-router');
const { modelCatalog } = await load('catalog');
const { startGateway, createProvider } = await load('server');
const { ProviderError } = await load('providers/provider');
const { AvailabilityService } = await load('availability/service');
const { setNativeRuntimeRootForTests } = await load('native-runtime-status');
setNativeRuntimeRootForTests(join(fixture, 'runtime'));

const requiredRoles = ['implementer', 'tester', 'fallback_implementer', 'other_implementer'];
const roleRoot = resolve(values.roles);
const roleModels = new Map();
for (const role of requiredRoles) {
  const source = join(roleRoot, `${role}.toml`), target = join(roleDirectory, `${role}.toml`);
  const text = await readFile(source, 'utf8');
  const match = text.match(/^model\s*=\s*"([^"]+)"/m);
  assert.ok(match, `Canonical ${role} role has a model`);
  roleModels.set(role, match[1]);
  await copyFile(source, target, constants.COPYFILE_EXCL);
}
const parentProvider = original.providers.find(provider => provider.models[parentAlias]);
assert.ok(parentProvider?.type === 'codex-subscription', 'The parent must be a configured Codex subscription alias');
const providersByRole = new Map();
for (const [role, alias] of roleModels) {
  const provider = original.providers.find(candidate => candidate.models[alias]);
  assert.ok(provider, `Configured provider for ${role} (${alias}) is required`);
  assert.notEqual(provider.id, 'openrouter', 'OpenRouter is forbidden for this E2E');
  providersByRole.set(role, provider);
}
const aliasesByProvider = new Map([[parentProvider.id, new Set([parentAlias])]]);
for (const [role, alias] of roleModels) {
  const id = providersByRole.get(role).id;
  (aliasesByProvider.get(id) ?? aliasesByProvider.set(id, new Set()).get(id)).add(alias);
}
const selectedProviders = original.providers.flatMap(source => {
  const aliases = aliasesByProvider.get(source.id);
  if (!aliases) return [];
  const provider = structuredClone(source), models = {}, metadata = {};
  for (const alias of aliases) {
    models[alias] = source.models[alias];
    const isParent = source.id === parentProvider.id && alias === parentAlias;
    metadata[alias] = { ...source.modelMetadata?.[alias], contextWindow: 100_000,
      reasoningEfforts: isParent ? ['low', 'medium', 'high', 'ultra'] : ['low', 'medium', 'high'],
      multiAgentVersion: isParent ? 'v2' : source.modelMetadata?.[alias]?.multiAgentVersion, multiAgentReasoningEffort: isParent ? 'low' : undefined, useResponsesLite: true };
  }
  provider.models = models; provider.modelMetadata = metadata;
  return [provider];
});
const parent = selectedProviders.find(provider => provider.id === parentProvider.id);
assert.ok(parent);
const parentUpstream = parent.models[parentAlias];
const serverConfig = { version: 1, port: 0, stateDirectory: state, timeoutMs: 240_000,
  // This isolated test deliberately enables the real, absolute Spendwatch source
  // so subscription quota is fresh even when the production gateway omits it.
  availability: { spendwatch: originalSpendwatch }, providers: selectedProviders };
const clientConfig = structuredClone(serverConfig);
const configPath = join(fixture, 'gateway.json');
const resumeMarker = `RESUME_${randomUUID()}`;
const proof = `PROOF_${randomUUID()}`, proofFile = join(work, 'worker-only-proof.txt');
await writeFile(proofFile, proof, { mode: 0o600 });

const helperCommand = `${JSON.stringify(pythonPath)} ${JSON.stringify(helperPath)} --config ${JSON.stringify(configPath)} --roles-dir ${JSON.stringify(roleDirectory)}`;
const canonicalPolicy = await readFile(policyPath, 'utf8');
const policySha = createHash('sha256').update(canonicalPolicy).digest('hex');
const renderedPolicy = canonicalPolicy.replace(
  /python3 "\$HOME\/Projects\/manager\/scripts\/macos\/model-availability-context\.py"/g,
  helperCommand,
);
assert.notEqual(renderedPolicy, canonicalPolicy, 'Policy must contain the canonical availability helper command');
const nativeConfig = `model = ${JSON.stringify(parentAlias)}\nmodel_catalog_json = ${JSON.stringify(join(native, 'models.json'))}\nweb_search = "disabled"\ndeveloper_instructions = ${JSON.stringify(renderedPolicy)}\n[features]\nremote_control = false\n[analytics]\nenabled = false\n[agents]\ndefault_subagent_model = ${JSON.stringify(parentAlias)}\n${requiredRoles.map(role => `[agents.${role}]\ndescription = ${JSON.stringify(`Canonical ${role} fixture role`)}\nconfig_file = ${JSON.stringify(join(roleDirectory, `${role}.toml`))}\n`).join('')}`;

const workerFailure = scenario === 'worker-failure';
const evidence = { scenario, parentModel: parentAlias, realGatewaySdk: true, syntheticAvailabilityInjection: scenario === 'local-unhealthy' || scenario === 'unknown-source',
  syntheticFailureInjection: workerFailure,
  policySha,
  availabilityWarmed: false, warmedLocalModel: 'unknown', warmedSubscriptionFacts: 'unknown', availabilityRequestsAfterParent: 0,
  helperCommands: 0, childStartedAfterHelper: false, childCommandItems: 0,
  parentCompleted: false, childCompleted: false, parentReportedProof: false, childReportedProof: false,
  childCount: 0, routed: [], paidOpenRouterCalls: 0, nativeOpenAIParentTested: false, developerInstructionsLoaded: false,
  parentSandbox: 'workspace-write', parentNetworkAccess: true, passed: false };
evidence.quotaCollectorUsesOriginalHome = true;
evidence.helperInterpreterResolved = true;
evidence.helperInterpreterModern = true;
let gateway, proxy, backend, proxyPort, phase = 'setup', parentThreadId, childInferenceStarted = false;
let parentCompletion;
let parentTurnStarted = false, latestSourceRequestedAt = 0, firstChildAt;
const childThreads = new Set();
const heldStatusCalls = new Set(), resumeCalls = new Set();
const injectedChildThreads = new Set();
let helperChecksAtPreviousChild = 0, sourceGetsAtPreviousChild = 0;
let latestHelperCompletedAt = 0, failedWorkerTerminalAt = 0;
const progress = stage => console.log(`availability_e2e:${stage}`);

function forward(req, res, targetPort) {
  const upstream = httpRequest({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers }, upstream => {
    res.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'proxy_unavailable' } })); });
  req.pipe(upstream);
}
async function availabilityOverride(req, res, targetPort) {
  if (parentTurnStarted) {
    evidence.availabilityRequestsAfterParent++;
    latestSourceRequestedAt = Date.now();
  }
  if (scenario === 'unknown-source') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'availability_source_unreachable' } })); return; }
  if (scenario === 'healthy' || scenario === 'held-worker' || (workerFailure && !evidence.injectedFailureAttempted)) { forward(req, res, targetPort); return; }
  const response = await fetch(`http://127.0.0.1:${targetPort}${req.url}`, { headers: req.headers });
  const report = await response.json();
  const local = report.providers?.find(row => row.id === providersByRole.get('implementer').id);
  assert.ok(local, 'The actual availability response must name the local primary provider');
  if (workerFailure) {
    assert.ok(evidence.injectedFailureAttempted, 'The fallback availability read must follow the injected local failure');
    evidence.injectedFaultReflected = local.status === 'unavailable' && local.reasons?.includes('authentication');
    assert.ok(evidence.injectedFaultReflected, 'The real availability snapshot must reflect the injected authentication failure');
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(report)); return;
  }
  local.status = 'unavailable'; local.reasons = ['unhealthy'];
  local.health = { status: 'unhealthy', observedAt: new Date().toISOString(), fresh: true,
    endpoints: { healthy: 0, total: 2 }, servedModels: [], missingModels: [] };
  res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(report));
}
const until = async (check, label, limit = 240_000) => {
  const end = Date.now() + limit;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(100); }
  throw Error(`${label} timed out`);
};
const messages = thread => thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'agentMessage').map(item => item.text ?? '');
const commandExitCode = item => item.exitCode ?? item.exit_code ?? item.result?.exitCode ?? item.result?.exit_code;
const commandThreadId = (event, item) => item.threadId ?? item.thread_id ?? event.params?.threadId ?? event.params?.thread_id;
const commandText = item => item.command ?? item.commandLine ?? item.command_line ?? item.commandExecution?.command ?? '';
const itemHasHelper = item => typeof commandText(item) === 'string' && (commandText(item).includes(helperPath) || commandText(item).includes('model-availability-context.py'));
const commandReadProof = item => commandExitCode(item) === 0 && typeof commandText(item) === 'string' && commandText(item).includes(proofFile)
  && typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.includes(proof);
const helperOutcome = output => {
  try {
    const parsed = JSON.parse(String(output ?? '').trim());
    return parsed?.object === 'model-availability-context' && ['available', 'unknown'].includes(parsed.status)
      ? { status: parsed.status, reason: typeof parsed.reason === 'string' ? parsed.reason : 'none' } : { status: 'invalid', reason: 'invalid' };
  } catch { return { status: 'invalid', reason: 'invalid' }; }
};
const quotaSummary = report => (report?.providers ?? []).flatMap(row => row?.quota ? [{ id: row.id, source: row.quota.source ?? 'unknown', fresh: row.quota.fresh === true,
  windows: Array.isArray(row.quota.windows) ? row.quota.windows.length : 0 }] : []);
const positiveQuota = (report, providerId) => report?.providers?.find(row => row.id === providerId && row.quota?.fresh === true
  && Number(row.quota.remainingPercent) > 0 && Array.isArray(row.quota.windows) && row.quota.windows.length > 0
  && row.quota.windows.every(window => Number(window.usedPercent) < 100 && Date.parse(window.resetsAt) > Date.now()));
const exhaustedQuota = (report, providerId) => report?.providers?.find(row => row.id === providerId && row.quota?.fresh === true
  && (Number(row.quota.remainingPercent) === 0 || row.quota.windows?.some(window => Number(window.usedPercent) >= 100)));

try {
  progress('setup');
  const runtime = await gatewaySdkRuntime(packagePath); assert.ok(runtime?.executorIdentity, 'Use a verified installed gateway SDK');
  const spendwatchEnvironment = { ...process.env, HOME: originalHome };
  delete spendwatchEnvironment.CODEX_HOME;
  const availability = new AvailabilityService({ spendwatch: async (command, provider) => {
    const run = await execText(command, ['capacity-current', '--provider', provider, '--json'], { env: spendwatchEnvironment });
    return run.ok ? run.stdout : undefined;
  } });
  gateway = await startGateway(serverConfig, (provider, ...callbacks) => {
    const delegate = createProvider(provider, ...callbacks);
    return { emitsTransport: delegate.emitsTransport, async *infer(...args) {
      const [request, , context] = args;
      const isParent = provider.id === parentProvider.id && request.model === parentUpstream;
      const childKey = context?.threadId ?? context?.sessionId ?? 'unidentified-child';
      const localWorker = provider.id === providersByRole.get('implementer').id && request.model === provider.models[roleModels.get('implementer')];
      if (localWorker && !isParent) {
        const names = (request.input ?? []).filter(item => item.type === 'function_call').map(item => [item.namespace, item.name].filter(Boolean).join('.'));
        evidence.localToolNames = [...new Set([...(evidence.localToolNames ?? []), ...names])];
      }
      const injected = workerFailure && !isParent && localWorker;
      const record = { provider: provider.id, model: request.model, parent: isParent, ...(injected ? { injectedFailure: true } : {}) };
      evidence.routed.push(record);
      if (provider.id === 'openrouter') evidence.paidOpenRouterCalls++;
      if (!isParent) {
        if (!childThreads.has(childKey)) {
          assert.notEqual(childKey, 'unidentified-child', 'Worker continuity needs a real SDK child context id');
          childThreads.add(childKey); progress(`first_child:${provider.id}/${request.model}`);
          assert.ok(childThreads.size <= (workerFailure ? 2 : 1), 'This scenario may not start more workers');
          childInferenceStarted = true; const childStartedAt = Date.now(); firstChildAt ??= childStartedAt;
          evidence.childStartedAfterHelper = evidence.helperCommands > helperChecksAtPreviousChild && evidence.availabilityRequestsAfterParent > sourceGetsAtPreviousChild && latestSourceRequestedAt <= childStartedAt;
          assert.ok(evidence.childStartedAfterHelper, 'Parent must execute the availability helper before child inference');
          const allowedChildRoutes = new Set(['implementer', 'tester', 'other_implementer'].map(role => `${providersByRole.get(role).id}\u0000${providersByRole.get(role).models[roleModels.get(role)]}`));
          assert.ok(allowedChildRoutes.has(`${provider.id}\u0000${request.model}`), 'Only the bounded Qwen or Terra child routes may infer');
          if (workerFailure && childThreads.size === 1) assert.ok(localWorker, 'The first worker-failure child must be Qwen');
          if (workerFailure && childThreads.size === 2) {
            const terraProvider = providersByRole.get('other_implementer');
            assert.ok(evidence.injectedFailureAttempted && failedWorkerTerminalAt > 0, 'Terra may start only after the injected Qwen worker terminally fails');
            assert.equal(`${provider.id}\u0000${request.model}`, `${terraProvider.id}\u0000${terraProvider.models[roleModels.get('other_implementer')]}`, 'The second worker-failure child must be Terra');
            assert.ok(latestHelperCompletedAt >= failedWorkerTerminalAt && latestSourceRequestedAt >= failedWorkerTerminalAt && latestSourceRequestedAt <= childStartedAt,
              'The fallback must recheck availability after the failed worker');
            evidence.fallbackRecheckAfterFailure = true;
          }
          helperChecksAtPreviousChild = evidence.helperCommands; sourceGetsAtPreviousChild = evidence.availabilityRequestsAfterParent;
        }
      }
      if (injected) {
        injectedChildThreads.add(childKey); evidence.injectedFailureAttempted = true; evidence.injectedProvider = provider.id;
        throw new ProviderError('authentication', 'Injected local authentication refusal', 401);
      }
      for await (const event of delegate.infer(...args)) {
        if (scenario === 'held-worker' && event.type === 'tool') {
          const tool = event.call.responseTool?.name ?? event.call.function.name.split('.').at(-1);
          let params; try { params = JSON.parse(event.call.function.arguments); } catch { params = {}; }
          if (localWorker && tool === 'send_message' && /hold|held|waiting|paused/i.test(params.message ?? '') && !evidence.resumeDelivered) heldStatusCalls.add(event.call.id);
          if (isParent && ['send_message', 'followup_task'].includes(tool) && (params.message ?? '').includes(resumeMarker)) {
            evidence.resumeIssuedAfterAcknowledgement = evidence.heldAcknowledged === true;
            evidence.resumeIssued = true; resumeCalls.add(event.call.id);
          }
          if (localWorker && tool !== 'send_message' && !evidence.resumeDelivered) evidence.workerToolWhileHeld = true;
          if (localWorker && tool === 'exec_command') evidence.workerCommandAfterResume = evidence.resumeDelivered === true;
        }
        yield event;
      }
    } };
  }, undefined, { availability, copilotTempBase: join(fixture, 'provider-tmp'), onFailure: () => progress('provider_fault') });
  const gatewayPort = gateway.address().port;
  const token = await gatewayToken(state);
  const directWarm = await fetch(`http://127.0.0.1:${gatewayPort}/v1/availability?wait=3000`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(directWarm.status, 200, 'The real availability endpoint must warm before any synthetic scenario');
  const warmReport = await directWarm.json();
  const warmedLocal = warmReport.providers?.find(row => row.id === providersByRole.get('implementer').id);
  evidence.warmedLocalModel = warmedLocal?.health?.status === 'healthy' && warmedLocal.health?.fresh === true ? 'healthy' : 'unknown';
  const subscriptionIds = new Set(selectedProviders.filter(provider => provider.type === 'codex-subscription' || provider.type === 'claude-subscription').map(provider => provider.id));
  evidence.warmedSubscriptionFacts = warmReport.providers?.some(row => subscriptionIds.has(row.id) && row.quota?.fresh === true) ? 'available' : 'unknown';
  evidence.warmedQuotaRows = quotaSummary(warmReport);
  evidence.availabilityWarmed = true;
  if (scenario === 'local-unhealthy' || workerFailure) {
    const fallbackProvider = providersByRole.get('other_implementer').id;
    const exhaustedPrimary = providersByRole.get('fallback_implementer').id;
    const fresh = await until(async () => {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/availability?wait=5000`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) { await response.body?.cancel(); return undefined; }
      const report = await response.json();
      return positiveQuota(report, fallbackProvider) && exhaustedQuota(report, exhaustedPrimary) ? report : undefined;
    }, 'Fresh Terra headroom and exhausted Claude primary', 15_000);
    evidence.warmedSubscriptionFacts = 'available';
    evidence.warmedQuotaRows = quotaSummary(fresh);
    evidence.chosenSubscriptionHeadroomKnown = true;
    evidence.exhaustedPrimaryObserved = true;
  }
  proxy = createServer((req, res) => req.method === 'GET' && new URL(req.url, 'http://loopback').pathname === '/v1/availability'
    ? void availabilityOverride(req, res, gatewayPort).catch(() => { res.writeHead(502); res.end(); }) : forward(req, res, gatewayPort));
  await new Promise((resolveListen, rejectListen) => { proxy.once('error', rejectListen); proxy.listen(0, '127.0.0.1', () => { proxy.off('error', rejectListen); resolveListen(); }); });
  proxyPort = proxy.address().port;
  clientConfig.port = proxyPort;
  await writePrivateJson(configPath, clientConfig);
  const scenarioAvailability = await fetch(`http://127.0.0.1:${proxyPort}/v1/availability?wait=3000`, { headers: { Authorization: `Bearer ${token}` } });
  if (scenario === 'unknown-source') assert.equal(scenarioAvailability.status, 503, 'Unknown-source scenario must make only availability unavailable');
  else assert.equal(scenarioAvailability.status, 200, 'Synthetic availability scenario must preserve a usable report');
  await scenarioAvailability.body?.cancel();
  const preflight = await execText(pythonPath, [helperPath, '--config', configPath, '--roles-dir', roleDirectory], { env: process.env });
  const preflightOutcome = helperOutcome(preflight.stdout);
  evidence.helperPreflight = { executed: preflight.ok, configFlag: true, inputFlag: false, helpFlag: false, ...preflightOutcome };
  if (scenario === 'unknown-source') assert.equal(preflightOutcome.status, 'unknown', 'The unavailable availability source must normalize to unknown');
  else assert.equal(preflightOutcome.status, 'available', 'The direct helper preflight must read the isolated availability endpoint');
  await writePrivateJson(join(state, 'service-plan.json'), { version: 1, config: configPath, sharedExecutors: false,
    components: [{ id: 'native', kind: 'native', command: runtime.executable, args: ['--codex', runtime.executable, '--native-home', native], log: join(state, 'native.log') }] });
  const rows = modelCatalog(clientConfig).models;
  if (values['child-status'] || scenario === 'held-worker') {
    evidence.localCollaborationVersion = rows.find(model => model.slug === roleModels.get('implementer'))?.multi_agent_version ?? null;
    assert.equal(evidence.localCollaborationVersion, 'v2', 'The fixture must preserve the configured local child collaboration capability');
  }
  const row = rows.find(model => model.slug === parentAlias); assert.ok(row, 'Parent model catalog row');
  const nativeRow = { ...row, slug: parentUpstream, multi_agent_version: undefined };
  const catalogPath = join(state, 'catalog.json');
  await writePrivateJson(catalogPath, { models: [nativeRow, ...rows] });
  await writePrivateJson(join(native, 'models.json'), { models: [nativeRow] });
  await writeFile(join(native, 'config.toml'), nativeConfig, { mode: 0o600 });
  const snapshot = { revision: 'availability-e2e', models: rows };
  const catalog = { current: () => snapshot, refresh: async () => snapshot, combined: value => ({ models: [nativeRow, ...value.models] }),
    nativeSlugs: new Set([parentUpstream]), isNative: model => model === parentUpstream };
  const overrides = { name: 'Availability E2E', base_url: `http://127.0.0.1:${proxyPort}/v1`, wire_api: 'responses', requires_openai_auth: false,
    supports_websockets: false, request_max_retries: 0, stream_idle_timeout_ms: 240_000,
    'auth.command': process.execPath, 'auth.args': [join(code, 'dist/cli.js'), 'token', '--config', configPath] };
  const backendSettings = { developer_instructions: renderedPolicy, web_search: 'disabled', analytics: { enabled: false } };
  backend = await AppServerBackends.create(runtime.executable, ['app-server', '--listen', 'stdio://'], clientConfig, backendSettings, overrides, catalog,
    async event => {
      const item = event.params?.item;
      if (scenario === 'held-worker' && event.method === 'item/completed' && item?.type === 'subAgentActivity' && item.kind === 'interacted') {
        if (heldStatusCalls.has(item.id) && item.agentThreadId === parentThreadId) evidence.heldAcknowledged = true;
        if (resumeCalls.has(item.id) && commandThreadId(event, item) === parentThreadId && childThreads.has(item.agentThreadId)) {
          evidence.resumeDelivered = true;
          evidence.resumeTargetMatched = true;
          evidence.resumeDeliveredAfterAcknowledgement = evidence.heldAcknowledged === true;
        }
      }
      if (event.method === 'item/completed' && item?.type === 'commandExecution' && commandThreadId(event, item) === parentThreadId && itemHasHelper(item) && commandExitCode(item) === 0) {
        evidence.helperCommands++;
        latestHelperCompletedAt = Date.now();
        evidence.helperCommandFlags = { config: commandText(item).includes('--config'), input: commandText(item).includes('--input'), help: commandText(item).includes('--help') };
        evidence.helperOutcome = helperOutcome(item.aggregatedOutput);
      }
      if (event.method === 'turn/completed' && event.params?.turn?.id) {
        const threadId = event.params.threadId ?? event.params.thread_id;
        if (workerFailure && event.params.turn.status === 'failed' && injectedChildThreads.has(threadId)) {
          failedWorkerTerminalAt = Date.now(); evidence.failedWorkerTerminal = true;
        }
        parentCompletion = { id: event.params.turn.id, status: event.params.turn.status };
      }
    }, () => {}, configPath);
  backend.resolveRuntime = async () => runtime;
  const router = new AppServerRouter(clientConfig, (method, params, hint) => backend.request(method, params, hint), catalogPath, catalog, native, backend.identity);
  await router.initialize();
  await router.request('initialize', { clientInfo: { name: 'gateway_availability_agents_e2e', version: '1' }, capabilities: { experimentalApi: true } });
  backend.notify({ method: 'initialized', params: {} });
  const nativeSettings = await router.request('config/read', {});
  assert.equal(nativeSettings.config?.developer_instructions, renderedPolicy, 'The private backend must load the rendered policy');
  assert.equal(backend.settings?.developer_instructions, renderedPolicy, 'The gateway generation must receive the rendered policy');
  evidence.developerInstructionsLoaded = true;
  phase = 'parent';
  const parentThread = await router.request('thread/start', { model: parentAlias, cwd: work, sandbox: 'workspace-write', approvalPolicy: 'never',
    config: { model_reasoning_effort: 'ultra', sandbox_workspace_write: { network_access: true } } });
  parentThreadId = parentThread.thread.id;
  const statusInstruction = values['child-status'] ? ' The worker must first send a brief status message to canonical parent path /root using its exposed collaboration send_message tool, then read the file. A status transport error must be reported separately and is not evidence the model cannot perform the read.' : '';
  const normalPrompt = `Delegate this bounded read-only task to the appropriate configured worker according to the configured policy: use exec_command to read ${proofFile} and report its full value. Do not read that file yourself, edit files, or use OpenRouter. If the worker reaches a terminal failure, the configured policy may make one appropriate fallback attempt. Wait for the result and report it.${statusInstruction}`;
  const heldPrompt = `Delegate a bounded task to the appropriate configured worker, but place it on HOLD now. Its future task is to read ${proofFile} with exec_command and report the full value. It must NOT read that file yet: it should only send a held/waiting acknowledgement to parent path /root and return a held report. Wait for that acknowledgement, then report the held state. Do not resume it, replace it, read the file yourself, or use OpenRouter. A later user message will authorize the same worker to continue.`;
  const prompt = scenario === 'held-worker' ? heldPrompt : normalPrompt;
  evidence.availabilityRequestsAfterParent = 0; latestSourceRequestedAt = 0; latestHelperCompletedAt = 0; failedWorkerTerminalAt = 0; firstChildAt = undefined; helperChecksAtPreviousChild = 0; sourceGetsAtPreviousChild = 0; parentTurnStarted = true;
  progress('parent_started');
  let turn = await router.request('turn/start', { threadId: parentThreadId, effort: 'ultra', input: [{ type: 'text', text: prompt }] });
  if (scenario === 'held-worker') {
    await until(() => parentCompletion?.id === turn.turn.id ? parentCompletion : undefined, 'Held parent completion');
    await until(() => evidence.heldAcknowledged, 'Local worker held acknowledgement');
    assert.ok(!evidence.workerToolWhileHeld, 'A held worker acknowledges without executing work tools before authorization');
    evidence.sameChildBeforeResume = childThreads.size === 1;
    turn = await router.request('turn/start', { threadId: parentThreadId, effort: 'ultra', input: [{ type: 'text', text:
      `Resume that same held worker now. Use a followup_task message containing ${resumeMarker}, the current working directory ${work}, and authorization to read ${proofFile} with exec_command. Wait for the actual file proof and the current child task's terminal completion; an earlier held/status report is not completion. Do not interrupt or cancel the worker for cleanup, even if its progress message already contains the proof. Do not create another worker, read the file yourself, edit files, or use OpenRouter.` }] });
  }
  const complete = await until(() => parentCompletion?.id === turn.turn.id ? parentCompletion : undefined, 'Parent completion');
  assert.equal(complete.status, 'completed'); evidence.parentCompleted = true;
  phase = 'inspect';
  progress('inspect');
  // A parent can receive the proof through a status message before the child's
  // final model stream ends. Wait for its real terminal turn; never cancel it
  // merely because the parent's answer arrived first.
  const children = await until(async () => {
    const loaded = await router.request('thread/loaded/list', {}); const observed = [];
    for (const id of loaded.data.filter(id => id !== parentThreadId)) {
      const result = await router.request('thread/read', { threadId: id, includeTurns: true });
      if ((result.thread.parentThreadId ?? result.thread.source?.subAgent?.thread_spawn?.parent_thread_id) === parentThreadId) observed.push(result.thread);
    }
    evidence.childLastTurnStatuses = observed.map(thread => thread.turns.at(-1)?.status ?? 'unknown');
    return observed.length && !evidence.childLastTurnStatuses.includes('inProgress') ? observed : undefined;
  }, 'Child task finalization', 60_000);
  evidence.childCount = children.length;
  assert.equal(evidence.childCount, workerFailure ? 2 : 1, 'This scenario has the expected worker count');
  assert.ok(childInferenceStarted, 'The child must make a real inference request');
  const child = children.find(thread => thread.turns.flatMap(turn => turn.items).some(item => item.type === 'commandExecution' && commandReadProof(item)));
  assert.ok(child, 'A real child must successfully read the proof');
  const childItems = child.turns.flatMap(turn => turn.items);
  if (scenario === 'held-worker') {
    evidence.heldWorkerResumed = evidence.resumeDelivered === true && evidence.workerCommandAfterResume === true;
    assert.ok(evidence.heldWorkerResumed && evidence.sameChildBeforeResume && evidence.heldAcknowledged && evidence.resumeTargetMatched && evidence.resumeDeliveredAfterAcknowledgement && !evidence.workerToolWhileHeld,
      'The same held worker must acknowledge the hold, receive explicit resume, and only then read the proof');
  }
  if (values['child-status']) {
    const statusItems = childItems.filter(item => item.type === 'subAgentActivity' && item.kind === 'interacted' && item.agentThreadId === parentThreadId);
    evidence.childStatusCalls = statusItems.length;
    evidence.childStatusSucceeded = statusItems.length > 0;
    assert.ok(evidence.childStatusSucceeded, 'The live local child must successfully message its parent');
  }
  const parentItems = (await router.request('thread/read', { threadId: parentThreadId, includeTurns: true })).thread.turns.flatMap(turn => turn.items);
  evidence.parentInterruptions = parentItems.filter(item => item.type === 'subAgentActivity' && item.kind === 'interrupted').length;
  evidence.childTurns = child.turns.map(turn => ({ status: turn.status, proofCommand: turn.items.some(item => item.type === 'commandExecution' && commandReadProof(item)), proofReported: turn.items.some(item => item.type === 'agentMessage' && item.text?.includes(proof)) }));
  if (scenario === 'held-worker') assert.equal(evidence.parentInterruptions, 0, 'A held/resumed worker must finish naturally without cleanup interruption');
  evidence.childCommandItems = childItems.filter(item => item.type === 'commandExecution').length;
  evidence.childProofCommand = childItems.some(item => item.type === 'commandExecution' && commandReadProof(item));
  evidence.childReportedProof = messages(child).some(text => text.includes(proof));
  evidence.parentReportedProof = parentItems.filter(item => item.type === 'agentMessage').some(item => item.text?.includes(proof));
  evidence.childCompleted = child.turns.at(-1)?.status === 'completed';
  assert.ok(evidence.helperCommands > 0, 'Parent must invoke the availability helper from a real command item');
  assert.ok(evidence.availabilityRequestsAfterParent > 0, 'Parent helper must request availability after the turn starts');
  assert.ok(evidence.childCommandItems > 0, 'Child must execute a real command');
  assert.ok(evidence.childProofCommand, 'Child must successfully read the proof file with exec_command');
  assert.equal(parentItems.filter(item => item.type === 'commandExecution').some(item => commandText(item).includes(proofFile) || item.aggregatedOutput?.includes(proof)), false, 'Parent commands must not read the proof');
  assert.ok(evidence.childReportedProof && evidence.parentReportedProof, 'Child and parent must report the unpredictable proof');
  assert.ok(evidence.childCompleted, 'The child last turn must complete');
  assert.equal(evidence.paidOpenRouterCalls, 0, 'No paid OpenRouter inference is allowed');
  const chosenRole = requiredRoles.find(role => roleModels.get(role) === child.model);
  assert.ok(chosenRole, 'The successful child must use a registered role');
  const childRoute = evidence.routed.find(route => !route.parent && !route.injectedFailure && route.model === providersByRole.get(chosenRole).models[child.model]);
  assert.ok(childRoute, 'A child route must be observed');
  evidence.childRole = chosenRole ?? 'unknown'; evidence.childModel = child.model;
  if (scenario === 'healthy' || scenario === 'held-worker') assert.equal(childRoute.provider, providersByRole.get('implementer').id, 'Healthy availability selects the named Qwen implementer');
  if (scenario === 'local-unhealthy') {
    assert.equal(childRoute.provider, providersByRole.get('other_implementer').id, 'An injected unhealthy local route falls back to Terra');
    assert.notEqual(childRoute.provider, providersByRole.get('fallback_implementer').id, 'An exhausted Claude primary must not receive the fallback task');
    evidence.exhaustedPrimarySkipped = true;
  }
  if (workerFailure) {
    const failed = children.find(thread => injectedChildThreads.has(thread.id));
    assert.ok(failed && failed.turns.at(-1)?.status === 'failed', 'The injected Qwen child must terminally fail');
    assert.equal(child.model, roleModels.get('other_implementer'), 'The successful fallback must use Terra');
    assert.equal(childRoute.provider, providersByRole.get('other_implementer').id, 'The successful fallback must route through Terra subscription');
    assert.ok(evidence.injectedFailureAttempted && evidence.failedWorkerTerminal && evidence.injectedFaultReflected, 'The injected local failure must be observed in availability');
    assert.ok(evidence.helperCommands >= 2 && evidence.availabilityRequestsAfterParent >= 2, 'Fallback requires a second real availability check');
    assert.ok(evidence.chosenSubscriptionHeadroomKnown && evidence.exhaustedPrimaryObserved, 'Fallback requires fresh Terra headroom and exhausted Claude evidence');
    assert.notEqual(childRoute.provider, providersByRole.get('fallback_implementer').id, 'The exhausted Claude primary must be avoided');
    assert.ok(evidence.fallbackRecheckAfterFailure, 'Fallback must have a post-failure recheck');
    evidence.exhaustedPrimarySkipped = true;
  }
  if (scenario === 'unknown-source') assert.equal(childRoute.provider, providersByRole.get('implementer').id, 'Unknown availability keeps the local default worker');
  evidence.passed = true;
  progress('complete');
} catch (error) {
  evidence.phase = phase;
  evidence.failure = error instanceof assert.AssertionError ? 'assertion' : 'runtime';
  process.stderr.write(error instanceof assert.AssertionError ? 'availability_e2e_assertion_failed\n' : 'availability_e2e_runtime_failed\n');
  process.exitCode = 1;
} finally {
  await backend?.stop().catch(() => {});
  if (proxy) await new Promise(resolveClose => proxy.close(() => resolveClose()));
  if (gateway) await new Promise(resolveClose => gateway.close(() => resolveClose()));
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  await rm(fixture, { recursive: true, force: true });
  console.log(JSON.stringify(evidence));
}
