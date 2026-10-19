import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export { gatewaySdkLockSha256 } from './gateway-sdk-lock.mjs';

export const gatewaySdkRevision = '740e5af33c71225640e0c1c1555c514c2c93ab74';
export const gatewaySdkArchiveSha256 = '25747823ea4ec852a146cbbe75d805b8df19190ca5b3fb21052d8e1cb75f2f83';
export const gatewaySdkCodexVersion = '0.162.0-alpha.17.2';
/** v3 adds preserved queues after failed gateway turns, including cold resume. */
export const gatewaySdkCapability = 'gateway-executor-v3';
export const gatewaySdkPatch = 'scripts/patches/gateway-executor.patch';
export const gatewaySdkPatches = [gatewaySdkPatch, 'scripts/patches/gateway-queue.patch'];

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
  for (const path of ['scripts/build-gateway-sdk.mjs', 'scripts/gateway-sdk-source.mjs', ...gatewaySdkPatches,
    'scripts/gateway-sdk-lock.mjs', 'scripts/gateway-sdk-test-runner.mjs']) {
    hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}
