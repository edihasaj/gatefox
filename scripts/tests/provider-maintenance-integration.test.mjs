import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { applyCandidate, maintainProviders, promotedFiles, recoverSourcePromotion } from '../provider-maintenance.mjs';

const releases = {
  codex: { version: '0.163.0', tag: 'rust-v0.163.0', revision: 'a'.repeat(40) },
  claude: { package: '@anthropic-ai/claude-code', version: '2.1.3', tarball: 'https://registry.npmjs.org/@anthropic-ai/claude-code/-/fixture.tgz', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
  copilot: { package: '@github/copilot', version: '2.1.3', tarball: 'https://registry.npmjs.org/@github/copilot/-/fixture.tgz', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
};
const rootProviderToolRuntime = new URL('../../dist/provider-tool-runtime.js', import.meta.url).href;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'provider-maintenance-integration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
  writeFileSync(join(root, '.gitignore'), '.state/\n');
  writeFileSync(join(root, 'unrelated.json'), '{"must":"stay"}\n');
  mkdirSync(join(root, 'scripts/tests'), { recursive: true });
  writeFileSync(join(root, 'scripts/tests/provider-fixture.test.mjs'), 'import test from "node:test";\ntest("fixture", () => {});\n');
  for (const path of promotedFiles) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `original ${path}\n`);
  }
  git(['add', '.']); git(['commit', '-m', 'test: fixture']);
  return { root, git };
}

function installArchiveFetch(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(url, `https://codeload.github.com/openai/codex/legacy.tar.gz/${releases.codex.revision}`);
    return new Response('fixture codex archive', { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
}

function writeCodexSource(source) {
  mkdirSync(join(source, 'codex-rs/core/tests/suite'), { recursive: true });
  writeFileSync(join(source, 'codex-rs/Cargo.toml'), '[workspace.package]\nversion = "0.163.0"\n[workspace]\n');
  writeFileSync(join(source, 'codex-rs/Cargo.lock'), '[[package]]\nname = "local"\nversion = "0.0.0"\n');
  writeFileSync(join(source, 'codex-rs/core/tests/suite/mod.rs'), 'use ctor::ctor;\nmod abort_lifecycle;\nmod other;\n');
  writeFileSync(join(source, 'codex-rs/core/config.schema.json'), JSON.stringify({
    properties: { features: { type: 'object', additionalProperties: false, properties: { toggle: { type: 'boolean' } } } },
  }));
}

function validationRunner({ failAt, mutateCandidate, calls = [] } = {}) {
  return async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (command === 'tar') {
      writeCodexSource(args.at(-1));
      return '';
    }
    if (args.includes('scripts/sync-gateway-sdk-pins.mjs')) {
      writeFileSync(join(options.cwd, 'src/gateway-sdk-build-pins.ts'), '// generated candidate pins\n');
    }
    if (command === 'npm' && args[0] === 'run' && args[1] === 'build') {
      const dist = join(options.cwd, 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(options.cwd, 'src/provider-tool-contract.ts'), '// generated contract\n');
      writeFileSync(join(dist, 'provider-tool-runtime.js'), `export async function providerToolTree(directory) {
  const { providerToolTree } = await import(${JSON.stringify(rootProviderToolRuntime)});
  return providerToolTree(directory);
}
`);
      writeFileSync(join(dist, 'provider-tool-contract.js'), '// candidate contract fixture\n');
    }
    if (args.includes('scripts/build-gateway-sdk.mjs') && !args.includes('--test')) {
      const buildRoot = args.at(args.indexOf('--build-root') + 1);
      assert.ok(buildRoot, 'SDK build must use an immutable build root');
      const artifact = join(buildRoot, 'artifact');
      mkdirSync(artifact, { recursive: true });
      writeFileSync(join(artifact, 'build.json'), '{}\n');
      writeFileSync(join(artifact, 'gateway-codex'), 'fixture SDK\n');
    }
    mutateCandidate?.(command, args, options);
    if (failAt && args.includes(failAt)) throw Error('private candidate diagnostic');
    return '';
  };
}

const validateCli = async (kind, release, directory) => {
  const modules = join(directory, 'node_modules');
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(modules, 'probe.js'), `// ${kind} fixture\n`);
  return { ...release, checks: [kind], license: 'MIT' };
};
const discover = async () => structuredClone(releases);
const generatedBytes = root => new Map(promotedFiles.map(path => [path, readFileSync(join(root, path))]));
const promoteTools = async () => ({});
function candidateWithGeneratedPins(root) {
  const candidate = join(root, '.state/candidate');
  for (const path of promotedFiles) {
    mkdirSync(dirname(join(candidate, path)), { recursive: true });
    writeFileSync(join(candidate, path), `candidate ${path}\n`);
  }
  return candidate;
}

test('a late SDK build regression leaves generated pins byte-for-byte unchanged and records only a fixed blocker', async t => {
  const f = fixture(t); installArchiveFetch(t);
  const before = generatedBytes(f.root);
  await assert.rejects(maintainProviders({
    root: f.root,
    discover,
    validateCli,
    run: validationRunner({ failAt: 'scripts/build-gateway-sdk.mjs' }),
  }), /Provider maintenance blocked at sdk_tests; last verified pins and running processes were preserved/);
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(f.root, path)), bytes, `${path} changed after a failed candidate`);
  const report = JSON.parse(readFileSync(join(f.root, '.state/provider-maintenance/latest.json'), 'utf8'));
  assert.deepEqual({ status: report.status, phase: report.phase }, { status: 'blocked', phase: 'sdk_tests' });
  assert.ok(!JSON.stringify(report).includes('private candidate diagnostic'));
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('latest maintenance state re-sanitizes injected validation metadata and never promotes a failed candidate', async t => {
  const f = fixture(t); installArchiveFetch(t); const before = generatedBytes(f.root);
  const run = validationRunner();
  await assert.rejects(maintainProviders({
    root: f.root,
    discover,
    validateCli,
    run: async (command, args, options) => {
      if (args.includes('scripts/sync-gateway-sdk-pins.mjs')) {
        const injected = Object.assign(Error('PRIVATE_INJECTED_MESSAGE'), {
          failureReason: 'nonzero_exit', exitCode: 9, signal: 'SIGSEGV',
          failureFiles: ['scripts/tests/provider-fixture.test.mjs', '../PRIVATE_PATH'],
          failureLocations: [{ file: 'scripts/tests/provider-fixture.test.mjs', line: 2, column: 3 }, { file: '../PRIVATE_PATH', line: 1, column: 1 }],
          compilerCodes: ['TS1234', { toString: () => 'PRIVATE_CODE' }],
          failureTypes: ['testCodeFailure', 'PRIVATE_FAILURE_TYPE'],
          testTotals: { pass: 1, fail: -1, private: 99 }, token: 'PRIVATE_TOKEN',
        });
        Object.defineProperty(injected, 'failureTypes', { enumerable: true, get() { throw Error('PRIVATE_GETTER'); } });
        throw injected;
      }
      return run(command, args, options);
    },
  }), /blocked at pins/);
  const reportText = readFileSync(join(f.root, '.state/provider-maintenance/latest.json'), 'utf8');
  const report = JSON.parse(reportText);
  assert.deepEqual(report.failureFiles, ['scripts/tests/provider-fixture.test.mjs']);
  assert.deepEqual(report.failureLocations, [{ file: 'scripts/tests/provider-fixture.test.mjs', line: 2, column: 3 }]);
  assert.deepEqual(report.compilerCodes, ['TS1234']); assert.equal(report.failureTypes, undefined);
  assert.deepEqual(report.testTotals, { pass: 1 }); assert.equal(report.failureReason, 'nonzero_exit');
  assert.equal(report.signal, 'SIGSEGV');
  for (const secret of ['PRIVATE_INJECTED_MESSAGE', 'PRIVATE_PATH', 'PRIVATE_CODE', 'PRIVATE_FAILURE_TYPE', 'PRIVATE_TOKEN', 'PRIVATE_GETTER']) assert.ok(!reportText.includes(secret));
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(f.root, path)), bytes, `${path} changed after a blocked candidate`);
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a fully verified candidate promotes exactly the generated pin files', async t => {
  const f = fixture(t); installArchiveFetch(t);
  const result = await maintainProviders({
    root: f.root,
    apply: true,
    discover,
    validateCli,
    promoteTools,
    run: validationRunner({
      mutateCandidate(command, args, options) {
        if (args.includes('npm') || args.includes('build')) writeFileSync(join(options.cwd, 'unrelated.json'), '{"must":"not promote"}\n');
      },
    }),
  });
  assert.equal(result.status, 'applied');
  for (const path of promotedFiles) assert.notEqual(readFileSync(join(f.root, path), 'utf8'), `original ${path}\n`);
  assert.equal(readFileSync(join(f.root, 'unrelated.json'), 'utf8'), '{"must":"stay"}\n');
  assert.deepEqual(f.git(['diff', '--name-only']).split('\n').filter(Boolean).sort(), [...promotedFiles].sort());
});

test('cached verification is invalidated when a candidate pin is changed', async t => {
  const f = fixture(t); installArchiveFetch(t);
  const firstCalls = [];
  const first = await maintainProviders({ root: f.root, discover, validateCli, run: validationRunner({ calls: firstCalls }) });
  assert.equal(first.status, 'verified');
  assert.ok(firstCalls.some(call => call.command === 'tar'));
  writeFileSync(join(first.candidate, 'src/gateway-sdk-pin.json'), '{"tampered":true}\n');

  const secondCalls = [];
  const second = await maintainProviders({ root: f.root, discover, validateCli, run: validationRunner({ calls: secondCalls }) });
  assert.equal(second.status, 'verified');
  assert.ok(secondCalls.some(call => call.command === 'tar'), 'a changed cached candidate must be rebuilt and revalidated');
  assert.notEqual(second.candidate, first.candidate);
});

test('a truncated verification cache is discarded and rebuilt', async t => {
  const f = fixture(t); installArchiveFetch(t);
  const first = await maintainProviders({ root: f.root, discover, validateCli, run: validationRunner() });
  assert.equal(first.status, 'verified');
  writeFileSync(join(f.root, '.state/provider-maintenance/verified.json'), '{');

  const calls = [];
  const second = await maintainProviders({ root: f.root, discover, validateCli, run: validationRunner({ calls }) });
  assert.equal(second.status, 'verified');
  assert.ok(calls.some(call => call.command === 'tar'), 'a malformed cache must not block or bypass a fresh validation');
});

test('a partial old-and-new promotion journal rolls generated pins back byte-for-byte', t => {
  const f = fixture(t);
  const before = generatedBytes(f.root);
  applyCandidate(f.root, candidateWithGeneratedPins(f.root), f.git(['rev-parse', 'HEAD']), { retainJournal: true });
  writeFileSync(join(f.root, promotedFiles[0]), before.get(promotedFiles[0]));
  assert.ok(existsSync(join(f.root, '.state/provider-maintenance/promotion.json')));

  recoverSourcePromotion(f.root);

  for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(f.root, path)), bytes, `${path} was not restored`);
  assert.ok(!existsSync(join(f.root, '.state/provider-maintenance/promotion.json')));
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('a user-edited generated pin survives an incomplete promotion for inspection', t => {
  const f = fixture(t);
  applyCandidate(f.root, candidateWithGeneratedPins(f.root), f.git(['rev-parse', 'HEAD']), { retainJournal: true });
  const path = promotedFiles[0];
  writeFileSync(join(f.root, path), 'user edit that is neither generation\n');

  assert.throws(() => recoverSourcePromotion(f.root), /Generated source changed during provider promotion; files preserved/);
  assert.equal(readFileSync(join(f.root, path), 'utf8'), 'user edit that is neither generation\n');
  assert.ok(existsSync(join(f.root, '.state/provider-maintenance/promotion.json')));
});
