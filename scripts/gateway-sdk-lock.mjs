import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pin from '../src/gateway-sdk-pin.json' with { type: 'json' };

export const gatewaySdkOriginalLockSha256 = pin.originalLockSha256;
export const gatewaySdkLockSha256 = pin.lockSha256;
const digest = value => createHash('sha256').update(value).digest('hex');

export function repairGatewaySdkLock(path) {
  const original = readFileSync(path, 'utf8');
  if (digest(original) === gatewaySdkLockSha256) return;
  if (digest(original) !== gatewaySdkOriginalLockSha256) throw Error('Pinned SDK lockfile source does not match');
  let updated = 0;
  const repaired = original.split(/(?=\[\[package\]\])/).map(block => {
    if (!/^\[\[package\]\]/.test(block) || /^source = /m.test(block) || !/^version = "0\.0\.0"$/m.test(block)) return block;
    updated++;
    return block.replace(/^version = "0\.0\.0"$/m, `version = "${pin.version}"`);
  }).join('');
  if (updated !== pin.workspaceRepairs || digest(repaired) !== gatewaySdkLockSha256) throw Error('Pinned SDK workspace-version repair does not match');
  writeFileSync(path, repaired);
}
