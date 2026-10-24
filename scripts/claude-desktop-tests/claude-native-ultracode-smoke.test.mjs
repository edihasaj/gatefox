import assert from 'node:assert/strict';
import test from 'node:test';
import { completedCliRun, settingsProjection, smokeAccepted } from '../claude-native-trial/ultracode-smoke.mjs';

const getSettingsFrame = applied => ({
  type: 'control_response',
  response: {
    subtype: 'success', request_id: 'settings',
    response: { effective: { effortLevel: 'xhigh', ultracode: true }, applied },
  },
});

test('Ultracode smoke distinguishes effective request settings from native active state', () => {
  const result = settingsProjection(getSettingsFrame({
    effort: 'xhigh', ultracode: true, ultracodeRequested: true, ultracodeAvailable: true,
  }));
  assert.deepEqual(result, {
    effective: { effort: 'xhigh', ultracode: true, ultracodeRequested: null, ultracodeAvailable: null },
    active: { effort: 'xhigh', ultracode: true, ultracodeRequested: true, ultracodeAvailable: true },
  });
});

test('Ultracode smoke only passes after native applied state and xhigh wire forwarding', () => {
  const cli = {
    ok: true,
    receipt: {
      settings: settingsProjection(getSettingsFrame({
        effort: 'xhigh', ultracode: true, ultracodeRequested: true, ultracodeAvailable: true,
      })),
    },
  };
  assert.equal(smokeAccepted(cli, { effort: 'xhigh' }), true);
  assert.equal(smokeAccepted(cli, { effort: 'high' }), false);
  cli.receipt.settings.active.ultracodeAvailable = false;
  assert.equal(smokeAccepted(cli, { effort: 'xhigh' }), false);
});

test('Ultracode smoke rejects missing and failed native result frames', () => {
  const complete = { observed: true, success: true, isError: false, fixtureMarker: true };
  assert.equal(completedCliRun({ code: 0 }, false, complete, true), true);
  assert.equal(completedCliRun({ code: 0 }, false, { ...complete, observed: false }, true), false, 'missing result');
  assert.equal(completedCliRun({ code: 0 }, false, { ...complete, success: false }, true), false, 'failed result subtype');
  assert.equal(completedCliRun({ code: 0 }, false, { ...complete, isError: true }, true), false, 'error result');
  assert.equal(completedCliRun({ code: 0 }, false, { ...complete, fixtureMarker: false }, true), false, 'unexpected result text');
});

test('Ultracode smoke acceptance rejects a missing fixture receipt', () => {
  const accepted = { ok: true, receipt: { settings: settingsProjection(getSettingsFrame({
    effort: 'xhigh', ultracode: true, ultracodeRequested: true, ultracodeAvailable: true,
  })) } };
  assert.equal(smokeAccepted(accepted, null), false, 'a result without the fixture receipt cannot pass');
});
