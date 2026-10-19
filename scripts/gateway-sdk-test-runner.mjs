import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pin from '../src/gateway-sdk-pin.json' with { type: 'json' };

export const gatewaySdkCompactionTestAggregatorSha256 = pin.compactionAggregatorSha256;
const originalSha256 = pin.originalAggregatorSha256;
const digest = value => createHash('sha256').update(value).digest('hex');

/** Run a synchronous test command with only the original compaction modules.
 * Retain SDK test-binary alias initialization and restore the exact aggregator.
 * The private SDK runtime source, package manifest, and lockfile stay unchanged.
 */
export function withGatewaySdkCompactionTests(sdkDirectory, operation) {
  const path = join(sdkDirectory, 'codex-rs/core/tests/suite/mod.rs');
  const original = readFileSync(path);
  if (digest(original) !== originalSha256) throw Error('Pinned SDK test aggregator does not match');
  const anchor = Buffer.from('\nmod abort_lifecycle;');
  const index = original.indexOf(anchor);
  if (index < 0 || original.indexOf(anchor, index + 1) >= 0) throw Error('Pinned SDK test aggregator boundary does not match');
  const reduced = Buffer.concat([original.subarray(0, index), Buffer.from('\nmod compact;\n')]);
  if (digest(reduced) !== gatewaySdkCompactionTestAggregatorSha256) throw Error('Pinned SDK compaction test aggregator does not match');
  try {
    writeFileSync(path, reduced);
    return operation();
  } finally {
    writeFileSync(path, original);
    if (digest(readFileSync(path)) !== originalSha256) throw Error('Pinned SDK test aggregator restoration failed');
  }
}
