import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const gatewaySdkOriginalLockSha256 = '1b7f27d5ec01ad9b19bfe8823557418772f851d367e8a6577544a9ab841b8d65';
export const gatewaySdkLockSha256 = '49575eeb44a747925fd1acef51bff88316f728b77d7f63d989835c8623c344cb';
const digest = value => createHash('sha256').update(value).digest('hex');

export function repairGatewaySdkLock(path) {
  const original = readFileSync(path, 'utf8');
  if (digest(original) === gatewaySdkLockSha256) return;
  if (digest(original) !== gatewaySdkOriginalLockSha256) throw Error('Pinned SDK lockfile source does not match');
  let updated = 0;
  const repaired = original.split(/(?=\[\[package\]\])/).map(block => {
    if (!/^\[\[package\]\]/.test(block) || /^source = /m.test(block) || !/^version = "0\.0\.0"$/m.test(block)) return block;
    updated++;
    return block.replace(/^version = "0\.0\.0"$/m, 'version = "0.162.0-alpha.17.2"');
  }).join('');
  if (updated !== 161 || digest(repaired) !== gatewaySdkLockSha256) throw Error('Pinned SDK workspace-version repair does not match');
  writeFileSync(path, repaired);
}
