import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Derive reproducible build inputs from an immutable stable source archive. No version literals to maintain. */
export function sdkCandidatePin(source, release, archiveSha256) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version) ||
      !/^[a-f0-9]{40}$/.test(release.revision) || !/^[a-f0-9]{64}$/.test(archiveSha256)) throw Error('Invalid stable SDK identity');
  const manifest = readFileSync(join(source, 'codex-rs/Cargo.toml'), 'utf8');
  const workspace = manifest.split('[workspace.package]')[1]?.split(/^\[/m)[0];
  if (!workspace?.includes(`version = "${release.version}"`)) throw Error('Stable SDK workspace version mismatch');
  const original = readFileSync(join(source, 'codex-rs/Cargo.lock'), 'utf8');
  let workspaceRepairs = 0;
  const repaired = original.split(/(?=\[\[package\]\])/).map(block => {
    if (!/^\[\[package\]\]/.test(block) || /^source = /m.test(block) || !/^version = "0\.0\.0"$/m.test(block)) return block;
    workspaceRepairs++;
    return block.replace(/^version = "0\.0\.0"$/m, `version = "${release.version}"`);
  }).join('');
  const aggregator = readFileSync(join(source, 'codex-rs/core/tests/suite/mod.rs'));
  const anchor = Buffer.from('\nmod abort_lifecycle;'); const index = aggregator.indexOf(anchor);
  if (index < 0 || aggregator.indexOf(anchor, index + 1) >= 0) throw Error('SDK test boundary changed');
  return { version: release.version, revision: release.revision, archiveSha256,
    originalLockSha256: sha256(original), lockSha256: sha256(repaired), workspaceRepairs,
    originalAggregatorSha256: sha256(aggregator),
    compactionAggregatorSha256: sha256(Buffer.concat([aggregator.subarray(0, index), Buffer.from('\nmod compact;\n')])) };
}

/** The upstream JSON schema describes strict feature tables, including their nested maps. */
export function featureTables(schema) {
  const resolve = (value, seen = new Set()) => {
    if (value?.allOf) {
      if (value.allOf.length !== 1) throw Error('Unsupported SDK schema intersection');
      return resolve(value.allOf[0], seen);
    }
    if (!value?.$ref) return value;
    const key = value.$ref.replace(/^#\/definitions\//, '');
    if (!value.$ref.startsWith('#/definitions/') || seen.has(key) || !schema.definitions?.[key]) throw Error('Unsupported SDK schema reference');
    return resolve(schema.definitions[key], new Set([...seen, key]));
  };
  const table = (input, depth = 0) => {
    if (depth > 24) throw Error('SDK schema nesting exceeds limit');
    const value = resolve(input);
    if (value?.anyOf) {
      const choices = value.anyOf.map(entry => resolve(entry)).filter(entry => entry.type !== 'null');
      if (choices.length === 1) return table(choices[0], depth + 1);
      if (choices.some(entry => entry.type === 'object')) throw Error('Unsupported nested SDK table union');
    }
    if (value?.type !== 'object') return undefined;
    const nested = {};
    for (const [name, child] of Object.entries(value.properties ?? {})) {
      const result = table(child, depth + 1); if (result) nested[name] = result;
    }
    if (value.additionalProperties === false) return { fields: Object.keys(value.properties ?? {}), nested };
    if (value.additionalProperties && typeof value.additionalProperties === 'object') {
      const values = table(value.additionalProperties, depth + 1);
      return { nested, ...(values ? { values } : {}) };
    }
    return undefined; // Unrestricted/scalar fields retain the SDK's own validation.
  };
  const features = resolve(schema.properties?.features);
  if (!features?.properties || features.additionalProperties !== false) throw Error('SDK feature schema changed');
  const output = {};
  for (const [name, input] of Object.entries(features.properties)) {
    const value = resolve(input);
    if (value.type === 'boolean') continue;
    const variants = value.anyOf ?? [value];
    const objects = variants.map(entry => resolve(entry)).filter(entry => entry.type === 'object');
    if (objects.length !== 1 || variants.some(entry => !['boolean', 'object'].includes(resolve(entry).type))) throw Error('Unsupported SDK feature shape');
    const result = table(objects[0]);
    if (!result?.fields) throw Error('SDK feature table is not strict');
    output[name] = { ...result, ...(!variants.some(entry => resolve(entry).type === 'boolean') ? { tableOnly: true } : {}) };
  }
  return output;
}

export function writeSdkCandidate(checkout, source, release, archiveSha256) {
  const pin = sdkCandidatePin(source, release, archiveSha256);
  writeFileSync(join(checkout, 'src/gateway-sdk-pin.json'), JSON.stringify(pin, null, 2) + '\n');
  const tables = featureTables(JSON.parse(readFileSync(join(source, 'codex-rs/core/config.schema.json'), 'utf8')));
  writeFileSync(join(checkout, 'src/gateway-feature-schema-data.json'), JSON.stringify(tables, null, 2) + '\n');
  return pin;
}
