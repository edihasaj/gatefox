import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pin from '../src/gateway-sdk-pin.json' with { type: 'json' };

export const gatewaySdkCompactionTestAggregatorSha256 = pin.compactionAggregatorSha256;
const originalSha256 = pin.originalAggregatorSha256;
const digest = value => createHash('sha256').update(value).digest('hex');
const regularAggregator = path => {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || (info.mode & 0o022)) throw Error('Invalid SDK test aggregator');
};
const atomicAggregator = (sdkDirectory, path, bytes) => {
  // Outside the hashed checkout: a killed write leaves no unrecognized source entry.
  const stage = join(dirname(sdkDirectory), '.gateway-aggregator-next');
  writeFileSync(stage, bytes, { mode: 0o600 }); renameSync(stage, path);
};

/** A killed compaction gate may leave its exact reduced aggregator; restore only authenticated original bytes. */
export function recoverGatewaySdkCompactionTests(sdkDirectory) {
  const path = join(sdkDirectory, 'codex-rs/core/tests/suite/mod.rs');
  const backup = `${path}.gateway-original`;
  let saved;
  try {
    const info = lstatSync(backup);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || (info.mode & 0o022)) throw Error('Invalid SDK test backup');
    saved = readFileSync(backup);
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  regularAggregator(path);
  const current = digest(readFileSync(path));
  if (digest(saved) !== originalSha256) {
    // A crash before the backup finished cannot have reduced the still-authenticated original.
    if (current === originalSha256) { unlinkSync(backup); return; }
    throw Error('SDK compaction test backup changed');
  }
  if (current !== originalSha256 && current !== gatewaySdkCompactionTestAggregatorSha256) throw Error('SDK test aggregator changed outside the gate');
  if (current !== originalSha256) atomicAggregator(sdkDirectory, path, saved);
  unlinkSync(backup);
}

/** Run a synchronous test command with only the original compaction modules.
 * Retain SDK test-binary alias initialization and restore the exact aggregator.
 * The private SDK runtime source, package manifest, and lockfile stay unchanged.
 */
export function withGatewaySdkCompactionTests(sdkDirectory, operation) {
  recoverGatewaySdkCompactionTests(sdkDirectory);
  const path = join(sdkDirectory, 'codex-rs/core/tests/suite/mod.rs');
  regularAggregator(path);
  const original = readFileSync(path);
  if (digest(original) !== originalSha256) throw Error('Pinned SDK test aggregator does not match');
  const anchor = Buffer.from('\nmod abort_lifecycle;');
  const index = original.indexOf(anchor);
  if (index < 0 || original.indexOf(anchor, index + 1) >= 0) throw Error('Pinned SDK test aggregator boundary does not match');
  const reduced = Buffer.concat([original.subarray(0, index), Buffer.from('\nmod compact;\n')]);
  if (digest(reduced) !== gatewaySdkCompactionTestAggregatorSha256) throw Error('Pinned SDK compaction test aggregator does not match');
  try {
    writeFileSync(`${path}.gateway-original`, original, { mode: 0o600, flag: 'wx' });
    atomicAggregator(sdkDirectory, path, reduced);
    return operation();
  } finally {
    atomicAggregator(sdkDirectory, path, original);
    if (digest(readFileSync(path)) !== originalSha256) throw Error('Pinned SDK test aggregator restoration failed');
    unlinkSync(`${path}.gateway-original`);
  }
}
