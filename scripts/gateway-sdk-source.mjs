import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pin from '../src/gateway-sdk-pin.json' with { type: 'json' };
export { gatewaySdkLockSha256 } from './gateway-sdk-lock.mjs';

export const gatewaySdkRevision = pin.revision;
export const gatewaySdkArchiveSha256 = pin.archiveSha256;
export const gatewaySdkCodexVersion = pin.version;
/** v3 adds preserved queues after failed gateway turns, including cold resume. */
export const gatewaySdkCapability = 'gateway-executor-v3';
export const gatewaySdkPatch = 'scripts/patches/gateway-executor.patch';
/** The dynamic-tools patch keeps declared-deferred client tools callable when the selected model cannot search. */
export const gatewaySdkPatches = [gatewaySdkPatch, 'scripts/patches/gateway-queue.patch', 'scripts/patches/gateway-dynamic-tools.patch', 'scripts/patches/gateway-role-context.patch'];

export function gatewaySdkPatchDigest() {
  const hash = createHash('sha256');
  for (const path of gatewaySdkPatches) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}

export function gatewaySdkLockRepairDigest() {
  return createHash('sha256').update(readFileSync('scripts/gateway-sdk-lock.mjs')).digest('hex');
}

export function gatewaySdkTestRunnerDigest() {
  return createHash('sha256').update(readFileSync('scripts/gateway-sdk-test-runner.mjs')).digest('hex');
}

export function gatewaySdkSourceDigest() {
  const hash = createHash('sha256');
  for (const path of ['src/gateway-sdk-pin.json', 'scripts/build-gateway-sdk.mjs', 'scripts/gateway-sdk-source.mjs', ...gatewaySdkPatches,
    'scripts/gateway-sdk-lock.mjs', 'scripts/gateway-sdk-test-runner.mjs']) {
    hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}
