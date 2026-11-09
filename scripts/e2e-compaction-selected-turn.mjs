import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replaySelectedTurnObserver } from './e2e-compaction-ui-observer.mjs';

/**
 * Whether the package ships the gateway SDK, the executor that compacts inside the user turn (0.4.3 and later). It uses the
 * package's own resolution (dist/gateway-sdk-runtime.js, which validates the artifact and throws when it is present but invalid);
 * a package whose dist cannot be imported that way is checked by the same file layout: a gateway-sdk folder with its receipt.
 */
export async function packageHasGatewaySdk(packageDirectory) {
  const exists = path => access(path).then(() => true, () => false);
  const dist = join(packageDirectory, 'dist/gateway-sdk-runtime.js');
  if (await exists(dist)) {
    const { gatewaySdkRuntime } = await import(pathToFileURL(dist));
    if (typeof gatewaySdkRuntime === 'function') return Boolean(await gatewaySdkRuntime(packageDirectory));
  }
  return await exists(join(packageDirectory, 'gateway-sdk/build.json')) || await exists(join(packageDirectory, 'gateway-sdk/gateway-codex'));
}

/**
 * Resolves --expect from what the package ships. The gateway executor always runs the package's own gateway SDK when it has one
 * (the adapter prefers it over --codex), so a package that has it can only be checked with selected-turn, and one without it can
 * never be.
 */
export async function resolveExpectation(packageDirectory, requested) {
  let present;
  try { present = await packageHasGatewaySdk(packageDirectory); }
  catch (error) { return { error: 'The package ships a gateway-sdk that failed its own validation (' + (error?.message ?? error) + '); reinstall the release before running this check.' }; }
  if (present) {
    const expect = requested ?? 'selected-turn';
    if (expect !== 'selected-turn') return { error: '--expect ' + expect + ' is refused: this package ships gateway-sdk, so the gateway executor compacts inside the user turn and ' + expect + ' cannot pass. Use --expect selected-turn (the release gate), or omit --expect. --codex does not change the gateway executor\'s SDK.' };
    return { expect, present };
  }
  const expect = requested ?? 'automatic';
  if (expect === 'selected-turn') return { error: '--expect selected-turn is refused: this package has no gateway-sdk (a release before 0.4.3), so there is no selected-turn runtime to verify. Use --expect automatic or --expect baseline for a legacy package.' };
  return { expect, present };
}

/** Require the installed package's own receipt and byte validation, not a fixture flag. */
export async function verifySelectedTurnRuntime(packageDirectory) {
  const { gatewaySdkRuntime } = await import(pathToFileURL(join(packageDirectory, 'dist/gateway-sdk-runtime.js')));
  const runtime = await gatewaySdkRuntime(packageDirectory);
  assert.equal(runtime?.selectedModelCompaction, true, 'Installed gateway lacks the selected-turn SDK');
  const receipt = JSON.parse(await readFile(join(packageDirectory, 'gateway-sdk/build.json'), 'utf8'));
  return { version: receipt.version, codexVersion: receipt.codexVersion, revision: receipt.revision,
    sourceSha256: receipt.sourceSha256, patchSha256: receipt.patchSha256, binarySha256: runtime.binarySha256,
    capabilities: receipt.capabilities };
}

/** A separate manual compact turn must fail even if its eventual answer succeeds. */
export function assertSelectedTurnEvents(notifications, threadId, turnId, { compact = true, status = 'completed' } = {}) {
  const sequence = notifications.filter(e => e.params?.threadId === threadId);
  const started = sequence.filter(e => e.method === 'turn/started');
  const completed = sequence.filter(e => e.method === 'turn/completed');
  assert.equal(started.length, 1, 'Expected one real SDK turn start');
  assert.equal(completed.length, 1, 'Expected one real SDK turn completion');
  assert.equal(started[0].params.turn.id, turnId, 'Started ID differs from turn/start ACK');
  assert.equal(completed[0].params.turn.id, turnId, 'Completed ID differs from turn/start ACK');
  assert.equal(completed[0].params.turn.status, status);
  const items = sequence.filter(e => e.params?.item?.type === 'contextCompaction');
  assert.ok(items.every(e => e.params.turnId === turnId), 'Compaction ID differs from turn/start ACK');
  if (compact) {
    assert.ok(items.some(e => e.method === 'item/started'), 'Missing real compaction start');
    if (status === 'completed') assert.ok(items.some(e => e.method === 'item/completed'), 'Missing real compaction completion');
  } else assert.equal(items.length, 0, 'Unexpected compaction');
  const startAt = sequence.indexOf(started[0]), doneAt = sequence.indexOf(completed[0]);
  assert.ok(doneAt > startAt);
  assert.ok(items.every(e => sequence.indexOf(e) > startAt && sequence.indexOf(e) < doneAt), 'Compaction outside the acknowledged turn');
  return { turnId, oneSdkTurn: true, compactItemsOnAcknowledgedTurn: items.length, sdkStatus: status };
}

export async function selectedTurnScenarios(c) {
  const { transport, label = transport, requests, events, timers, proof, steerProof, rpc, start, turn,
    until, save, open, closeAdapter, transcriptHasProof, selectedRequests, setPhaseMode, releasePausedResponses } = c;
  const phase = (name, mode = 'normal', oldModel = 'mock-large') => setPhaseMode(`${label}-${name}`, mode, oldModel);
  const seed = async (name, model = 'fixture/large', mode = 'seed-high', effort = 'low') => {
    phase(name, mode); const thread = await start(model);
    assert.ok((await turn(thread.thread.id, model, 'Seed the isolated selected-turn history.', 'completed', effort)).text.includes(proof));
    return thread.thread.id;
  };
  const lifecycle = (id, result, options) => assertSelectedTurnEvents(events.slice(result.offset), id, result.turnId, options);
  const completed = async (id, name, model, wire, effort = 'low', wireEffort = effort, count = 2, old = 'mock-large') => {
    phase(name, 'blocked-old', old); const at = requests.length;
    const result = await turn(id, model, 'Continue with the explicitly selected model.', 'completed', effort);
    assert.ok(result.text.includes(proof));
    assert.ok(selectedRequests(at, wire, count).every(r => r.containsProof && r.reasoningEffort === wireEffort));
    const evidence = lifecycle(id, result, { compact: count === 2 });
    const transcript = await transcriptHasProof(id);
    assert.equal(transcript.turns.filter(t => t.id === result.turnId).length, 1, 'SDK stored another turn for automatic compaction');
    assert.equal(transcript.reasoningEffort, effort);
    await save({ phase: `${label}-${name}`, passed: true, ...evidence, noOldProviderCalls: true,
      selectedReasoningEffort: effort, wireReasoningEffort: wireEffort, historyPreserved: true });
    return result;
  };
  const held = async (id, name, mode = 'pause-selected-compact') => {
    phase(name, mode); const at = requests.length, offset = events.length;
    const ack = await rpc('turn/start', { threadId: id, model: 'fixture/small', effort: 'high',
      input: [{ type: 'text', text: 'Continue the selected-turn fixture.' }] });
    await until(() => events.slice(offset).find(e => e.method === 'item/started' && e.params.threadId === id && e.params.item.type === 'contextCompaction'), 'Selected compaction start');
    await until(() => requests.length > at, 'Selected compaction request');
    return { at, offset, turnId: ack.turn.id };
  };
  const terminal = async (id, pending, status) => {
    const done = await until(() => events.slice(pending.offset).find(e => e.method === 'turn/completed' && e.params.threadId === id && e.params.turn.id === pending.turnId), 'Selected turn completion');
    assert.equal(done.params.turn.status, status);
    return lifecycle(id, pending, { status });
  };

  await open(transport); phase('native-passthrough');
  assert.equal((await rpc('config/read', { includeLayers: false })).config.model, 'native-fixture');
  const native = await start('native-fixture'); assert.ok(!['gatefox', 'subscription_gateway'].includes(native.modelProvider));
  assert.equal(requests.filter(r => r.phase === `${label}-native-passthrough`).length, 0);
  await save({ phase: `${label}-native-passthrough`, passed: true, nativeProviderPreserved: true, nativeInferenceRequests: 0 });

  const short = await seed('short-seed', 'fixture/large', 'seed-low');
  await completed(short, 'short-downshift', 'fixture/small', 'mock-small', 'high', 'high', 1);
  await completed(short, 'short-upshift', 'fixture/large', 'mock-large', 'max', 'max', 1, 'mock-small');

  const large = await seed('long-max-seed', 'fixture/large', 'seed-high', 'max');
  const downshift = await completed(large, 'same-turn-downshift', 'fixture/small', 'mock-small', 'ultra', 'high');
  const observer = await replaySelectedTurnObserver({ threadId: large, turnId: downshift.turnId, notifications: events.slice(downshift.offset) });
  await save({ phase: `${label}-frontend-association`, passed: observer.available ? observer.passed : true, skipped: !observer.available, ...observer,
    renderedDesktopUiTested: false, appOperated: false });
  await completed(large, 'same-target-follow-up', 'fixture/small', 'mock-small', 'high', 'high', 1);
  // The fixture reports enough current-window usage to force compaction on the larger target too.
  const reverse = await seed('reverse-overflow-seed', 'fixture/small', 'seed-overflow', 'high');
  await completed(reverse, 'same-turn-upshift', 'fixture/large', 'mock-large', 'max', 'max', 2, 'mock-small');

  const failed = await seed('provider-failure-seed', 'fixture/large', 'seed-overflow');
  phase('selected-provider-failure', 'failed-manual'); const failureAt = requests.length;
  const failure = await turn(failed, 'fixture/small', 'Try the currently unavailable selected model.', 'failed', 'high');
  // The SDK retries a failed provider call on its own (one try plus five retries), so the attempt count is its choice:
  // require between one and six attempts, and that every attempt went to the selected model and failed.
  const attempts = requests.slice(failureAt);
  assert.ok(attempts.length >= 1 && attempts.length <= 6 && attempts.every(r => r.model === 'mock-small' && r.outcome === 'usage_limit'));
  assert.ok(failure.terminal.error, 'SDK must report its actual failed turn');
  const failedEvidence = lifecycle(failed, failure, { status: 'failed' }); await transcriptHasProof(failed);
  await save({ phase: `${label}-selected-provider-failure`, passed: true, ...failedEvidence, actualSelectedProvider429: true, noOldProviderCalls: true, historyPreserved: true });
  await completed(failed, 'failure-retry-new-selection', 'fixture/large', 'mock-large', 'max', 'max', 2, 'mock-small');

  const stopped = await seed('stop-seed');
  const waiting = await held(stopped, 'stop-during-selected-compaction', 'pause-manual');
  await rpc('turn/interrupt', { threadId: stopped, turnId: waiting.turnId });
  const stoppedEvidence = await terminal(stopped, waiting, 'interrupted');
  await until(() => timers.size === 0, 'Stopped provider cleanup'); selectedRequests(waiting.at, 'mock-small', 1);
  await transcriptHasProof(stopped);
  await save({ phase: `${label}-stop-during-selected-compaction`, passed: true, ...stoppedEvidence, noExtraUserTurn: true, providerTimers: 0, historyPreserved: true });
  await completed(stopped, 'stop-explicit-retry', 'fixture/small', 'mock-small', 'high');

  const goalThread = await seed('goal-and-steer-seed');
  const goalAt = requests.length;
  await rpc('thread/goal/set', { threadId: goalThread, objective: 'Complete the isolated fixture response.', status: 'paused', origin: 'user', tokenBudget: 1 });
  assert.equal(requests.length, goalAt, 'Paused goal must not initiate another turn');
  const goalTurn = await held(goalThread, 'goal-active-steer-during-compaction');
  await rpc('thread/goal/set', { threadId: goalThread, status: 'active', origin: 'user' });
  assert.equal((await rpc('thread/goal/get', { threadId: goalThread })).goal.status, 'active');
  const steering = await rpc('turn/steer', { threadId: goalThread, expectedTurnId: goalTurn.turnId,
    input: [{ type: 'text', text: `Retain this steering marker: ${steerProof}` }] });
  assert.equal(steering.turnId, goalTurn.turnId);
  releasePausedResponses('blocked-old', 'mock-large');
  const goalEvidence = await terminal(goalThread, goalTurn, 'completed');
  // Pinned SDK answers the admitted input before draining steering queued during compaction.
  const goalRequests = selectedRequests(goalTurn.at, 'mock-small', 3);
  assert.ok(goalRequests.every(r => r.reasoningEffort === 'high' && r.containsProof));
  assert.deepEqual(goalRequests.map(r => r.containsSteer), [false, false, true], 'SDK lost or prematurely drained steering while compacting');
  const goal = await until(async () => { const g = (await rpc('thread/goal/get', { threadId: goalThread })).goal; return g?.status !== 'active' && g; }, 'SDK goal budget completion');
  assert.equal(goal.status, 'budgetLimited', 'SDK must apply its normal goal budget accounting');
  selectedRequests(goalTurn.at, 'mock-small', 3);
  lifecycle(goalThread, goalTurn);
  const goalTranscript = await transcriptHasProof(goalThread); assert.ok(JSON.stringify(goalTranscript.turns).includes(steerProof));
  await save({ phase: `${label}-goal-active-steer-during-compaction`, passed: true, ...goalEvidence,
    activeGoalDuringCompaction: true, actualSdkGoalStatus: goal.status, sameTurnSteering: true, inferenceRequests: 3,
    steeringIncludedInRequests: [false, false, true], steeringPreserved: true, historyPreserved: true });
  await completed(goalThread, 'steered-follow-up', 'fixture/small', 'mock-small', 'high', 'high', 1);
  await closeAdapter(); await open(transport);
  await rpc('thread/resume', { threadId: goalThread, model: 'fixture/small' });
  await completed(goalThread, 'resumed-history-follow-up', 'fixture/small', 'mock-small', 'high', 'high', 1);
  await closeAdapter();
}
