import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { featureTables, sdkCandidatePin, sha256 } from '../provider-sdk-candidate.mjs';

test('derives lock repairs and test hashes from stable source without hardcoded package counts', t => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-pin-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'codex-rs/core/tests/suite'), { recursive: true });
  writeFileSync(join(root, 'codex-rs/Cargo.toml'), '[workspace.package]\nversion = "0.163.0"\n[profile.dev]\n');
  const lock = '[[package]]\nname = "local"\nversion = "0.0.0"\n\n[[package]]\nname = "registry"\nversion = "0.0.0"\nsource = "registry"\n';
  writeFileSync(join(root, 'codex-rs/Cargo.lock'), lock);
  writeFileSync(join(root, 'codex-rs/core/tests/suite/mod.rs'), 'use ctor::ctor;\nmod abort_lifecycle;\nmod other;\n');
  const pin = sdkCandidatePin(root, { version: '0.163.0', revision: 'a'.repeat(40) }, 'b'.repeat(64));
  assert.equal(pin.workspaceRepairs, 1);
  assert.equal(pin.lockSha256, sha256(lock.replace('version = "0.0.0"', 'version = "0.163.0"')));
  assert.equal(pin.compactionAggregatorSha256, sha256('use ctor::ctor;\nmod compact;\n'));
  assert.throws(() => sdkCandidatePin(root, { version: '0.164.0', revision: 'a'.repeat(40) }, 'b'.repeat(64)), /version mismatch/);
});
test('derives nested strict fields, reference wrappers, nullable tables and map values', () => {
  const strict = properties => ({ type: 'object', additionalProperties: false, properties });
  const schema = { definitions: { Child: strict({ limit: { type: 'integer' } }), Feature: strict({
    enabled: { type: 'boolean' }, child: { allOf: [{ $ref: '#/definitions/Child' }] },
    optional: { anyOf: [{ type: 'null' }, { $ref: '#/definitions/Child' }] },
    map: { type: 'object', additionalProperties: { $ref: '#/definitions/Child' } },
  }) }, properties: { features: strict({
    toggle: { type: 'boolean' }, safe: { anyOf: [{ type: 'boolean' }, { $ref: '#/definitions/Feature' }] },
    table_only: { $ref: '#/definitions/Child' },
  }) } };
  const result = featureTables(schema);
  assert.equal(result.toggle, undefined); assert.equal(result.table_only.tableOnly, true);
  assert.deepEqual(result.safe.nested.child.fields, ['limit']);
  assert.deepEqual(result.safe.nested.optional.fields, ['limit']);
  assert.deepEqual(result.safe.nested.map.values.fields, ['limit']);
  schema.properties.features.properties.safe = { anyOf: [{ type: 'object' }, { type: 'string' }] };
  assert.throws(() => featureTables(schema), /feature shape/);
});
test('unknown references and intersections block schema promotion', () => {
  for (const child of [{ $ref: '#/definitions/Missing' }, { allOf: [{ type: 'object' }, { type: 'object' }] }]) {
    assert.throws(() => featureTables({ properties: { features: { type: 'object', additionalProperties: false, properties: { child } } } }), /SDK schema/);
  }
});
