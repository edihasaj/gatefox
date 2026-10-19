import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// The relay's pinned SDK archive (rust-v0.163.0-alpha.10.2) declares its workspace version in Cargo.toml while its
// lockfile keeps `0.0.0` for every source-less workspace package, so `cargo test --locked` refuses it. This repairs exactly
// those packages; every external package, source, checksum and dependency block stays byte-identical. The gateway SDK keeps
// its own repair (scripts/gateway-sdk-lock.mjs) for its own pinned archive.
export const relaySdkOriginalLockSha256 = '17cdd862471774ba7aef836aaf0a0a3ed76bd23e503b1fc7278c89d1f2719d03';
export const relaySdkLockSha256 = 'b33f1451bb95430814df699b3a32954d45a44b9764690e2c91c0f166e76d0cf6';
export const relaySdkWorkspacePackages = 160;
export const relaySdkWorkspaceVersion = '0.163.0-alpha.10.2';
const digest = value => createHash('sha256').update(value).digest('hex');

/** The repaired lockfile text, or a refusal when the input is not the pinned original. */
export function repairedRelaySdkLock(original) {
  if (digest(original) === relaySdkLockSha256) return original;
  if (digest(original) !== relaySdkOriginalLockSha256) throw Error('Pinned relay SDK lockfile source does not match');
  let updated = 0;
  const repaired = original.split(/(?=\[\[package\]\])/).map(block => {
    if (!/^\[\[package\]\]/.test(block) || /^source = /m.test(block) || !/^version = "0\.0\.0"$/m.test(block)) return block;
    updated++;
    return block.replace(/^version = "0\.0\.0"$/m, `version = "${relaySdkWorkspaceVersion}"`);
  }).join('');
  if (updated !== relaySdkWorkspacePackages || digest(repaired) !== relaySdkLockSha256) throw Error('Pinned relay SDK workspace-version repair does not match');
  return repaired;
}

export function repairRelaySdkLock(path) {
  const original = readFileSync(path, 'utf8'); const repaired = repairedRelaySdkLock(original);
  if (repaired !== original) writeFileSync(path, repaired);
}
