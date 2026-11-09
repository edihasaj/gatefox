import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReleaseTempStorage, withReleaseTempStorage } from '../release-temp-storage.mjs';

function fixture() {
  const cwd = join(tmpdir(), `gateway-release-storage-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(cwd, { recursive: true });
  const probe = new ReleaseTempStorage({ cwd });
  return { cwd, namespace: probe.namespace, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function release({ cwd, outputDir, name, content }) {
  return withReleaseTempStorage({ cwd, outputDir }, storage => {
    writeFileSync(join(storage.output, name), content);
    writeFileSync(join(storage.output, 'SHA256SUMS'), `digest  ${name}\n`);
    return { assetName: name };
  });
}

test('keeps only the latest successful default asset outside the checkout', () => {
  const testCase = fixture();
  try {
    const oldName = 'harness-gateway-0.5.8-macos-arm64.tar.gz';
    const old = release({ cwd: testCase.cwd, name: oldName, content: 'old' });
    const newName = 'harness-gateway-0.5.9-macos-arm64.tar.gz';
    const latest = release({ cwd: testCase.cwd, name: newName, content: 'new' });
    assert.ok(latest.asset.startsWith(testCase.namespace));
    assert.deepEqual(readdirSync(join(testCase.namespace, 'latest')).sort(), ['SHA256SUMS', newName]);
    assert.equal(existsSync(old.asset), false);
    assert.equal(existsSync(join(testCase.namespace, 'staging')), true);
  } finally {
    rmSync(testCase.namespace, { recursive: true, force: true });
    testCase.cleanup();
  }
});

test('a GateFox archive replaces an earlier latest output, including a GateFox one', () => {
  const testCase = fixture();
  try {
    release({ cwd: testCase.cwd, name: 'harness-gateway-1.7.8-macos-arm64.tar.gz', content: 'old' });
    release({ cwd: testCase.cwd, name: 'gatefox-1.8.0-macos-arm64.tar.gz', content: 'first' });
    release({ cwd: testCase.cwd, name: 'gatefox-1.8.0-macos-arm64.tar.gz', content: 'rebuilt' });
    assert.deepEqual(readdirSync(join(testCase.namespace, 'latest')).sort(), ['SHA256SUMS', 'gatefox-1.8.0-macos-arm64.tar.gz']);
  } finally {
    rmSync(testCase.namespace, { recursive: true, force: true });
    testCase.cleanup();
  }
});

test('failed work removes its stage and preserves the previous successful asset', () => {
  const testCase = fixture();
  try {
    const name = 'harness-gateway-0.5.8-macos-arm64.tar.gz';
    const successful = release({ cwd: testCase.cwd, name, content: 'good' });
    assert.throws(() => withReleaseTempStorage({ cwd: testCase.cwd }, storage => {
      writeFileSync(join(storage.output, name), 'bad');
      throw new Error('expected build failure');
    }), /expected build failure/);
    assert.equal(existsSync(successful.asset), true);
    assert.deepEqual(readdirSync(join(testCase.namespace, 'staging')), []);
  } finally {
    rmSync(testCase.namespace, { recursive: true, force: true });
    testCase.cleanup();
  }
});

test('refuses live and stale locks before it can prune any staging directory', () => {
  const testCase = fixture();
  try {
    const held = new ReleaseTempStorage({ cwd: testCase.cwd }).acquire();
    assert.throws(() => new ReleaseTempStorage({ cwd: testCase.cwd }).acquire(), /active build lock/);
    held.abort();
    const staleStage = join(testCase.namespace, 'staging', 'build-stale');
    mkdirSync(staleStage);
    writeFileSync(join(staleStage, 'keep'), 'untouched');
    writeFileSync(join(testCase.namespace, 'build.lock'), '{"pid":999999}\n', { mode: 0o600 });
    assert.throws(() => new ReleaseTempStorage({ cwd: testCase.cwd }).acquire(), /stale release build lock/);
    assert.equal(existsSync(join(staleStage, 'keep')), true);
  } finally {
    rmSync(testCase.namespace, { recursive: true, force: true });
    testCase.cleanup();
  }
});

test('retains intentionally selected output directories without broad pruning', () => {
  const testCase = fixture();
  const output = join(testCase.cwd, 'release-assets');
  try {
    mkdirSync(output);
    writeFileSync(join(output, 'keep-me.txt'), 'keep');
    const oldName = 'harness-gateway-0.5.8-macos-arm64.tar.gz';
    release({ cwd: testCase.cwd, outputDir: output, name: oldName, content: 'old' });
    const newName = 'harness-gateway-0.5.9-macos-arm64.tar.gz';
    const latest = release({ cwd: testCase.cwd, outputDir: output, name: newName, content: 'new' });
    assert.equal(latest.asset, join(output, newName));
    assert.deepEqual(readdirSync(output).sort(), ['SHA256SUMS', oldName, newName, 'keep-me.txt']);
  } finally {
    rmSync(testCase.namespace, { recursive: true, force: true });
    testCase.cleanup();
  }
});

test('removes an owned stage containing a generated symlink without following it', () => {
  const testCase = fixture();
  const outside = join(testCase.cwd, 'outside');
  try {
    writeFileSync(outside, 'must remain');
    const storage = new ReleaseTempStorage({ cwd: testCase.cwd }).acquire();
    symlinkSync(outside, join(storage.work, 'generated-link'));
    storage.abort();
    assert.equal(existsSync(outside), true);
    assert.deepEqual(readdirSync(join(testCase.namespace, 'staging')), []);
  } finally {
    rmSync(testCase.namespace, { recursive: true, force: true });
    testCase.cleanup();
  }
});

test('refuses a symlinked shared release namespace parent', () => {
  const testCase = fixture();
  const temp = join(testCase.cwd, 'temp');
  const target = join(testCase.cwd, 'target');
  try {
    mkdirSync(temp); mkdirSync(target);
    symlinkSync(target, join(temp, 'harness-gateway-release'));
    const module = new URL('../release-temp-storage.mjs', import.meta.url).href;
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '--eval',
      `import { ReleaseTempStorage } from ${JSON.stringify(module)}; new ReleaseTempStorage({ cwd: ${JSON.stringify(testCase.cwd)} }).acquire();`],
    { env: { ...process.env, TMPDIR: temp }, stdio: 'pipe' }), /unsafe release namespace parent/);
  } finally {
    testCase.cleanup();
  }
});
