import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { providerCommand, providerToolContract } from '../../dist/provider-tool-runtime.js';
import { promoteProviderTools } from '../promote-provider-tools.mjs';

const rootRuntimeUrl = new URL('../../dist/provider-tool-runtime.js', import.meta.url).href;
const releases = {
  claude: { version: '2.1.3' },
  copilot: { version: '1.2.3' },
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'provider-tools-promotion-'));
  const candidate = join(root, 'candidate');
  const checkout = join(candidate, 'checkout');
  const defaultRoot = join(candidate, 'provider-tools', providerToolContract);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(checkout, 'dist'), { recursive: true, mode: 0o700 });
  writeFileSync(join(checkout, 'dist/provider-tool-contract.js'),
    `export const providerToolContract = ${JSON.stringify(providerToolContract)};\n`);
  writeFileSync(join(checkout, 'dist/provider-tool-runtime.js'),
    `import { providerToolTree, providerCommand } from ${JSON.stringify(rootRuntimeUrl)};
import { providerToolContract } from "./provider-tool-contract.js";
export { providerToolTree, providerCommand, providerToolContract };
export const providerToolsRoot = () => ${JSON.stringify(defaultRoot)};
`);
  for (const kind of ['claude', 'copilot']) writeCandidateCli(candidate, kind);
  return { root, candidate, defaultRoot, runtimeRoot: join(root, 'runtime') };
}

function writeCandidateCli(candidate, kind) {
  const modules = join(candidate, kind, 'node_modules');
  const executable = join(modules, 'pkg', 'cli');
  mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
  mkdirSync(join(modules, '.bin'), { recursive: true, mode: 0o700 });
  writeFileSync(executable, `#!/bin/sh\nprintf '${kind} fixture\\n'\n`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  symlinkSync('../pkg/cli', join(modules, '.bin', kind));
}

const installedExecutable = (root, provider) => join(realpathSync(root), 'installs', provider.installation, provider.executable);

test('initial promotion installs private immutable provider CLIs and the resolver selects them', async t => {
  const f = fixture(t);
  const providers = await promoteProviderTools(f.candidate, releases, f.runtimeRoot);

  for (const kind of ['claude', 'copilot']) {
    const expected = installedExecutable(f.runtimeRoot, providers[kind]);
    assert.ok(existsSync(expected), `${kind} installation is missing`);
    assert.equal(await providerCommand(kind, f.runtimeRoot), expected);
  }
  const manifest = JSON.parse(readFileSync(join(f.runtimeRoot, 'current.json'), 'utf8'));
  assert.equal(manifest.contract, providerToolContract);
});

test('a missing second provider leaves the previous current manifest byte-for-byte intact', async t => {
  const f = fixture(t);
  await promoteProviderTools(f.candidate, releases, f.runtimeRoot);
  const current = join(f.runtimeRoot, 'current.json');
  const before = readFileSync(current);
  rmSync(join(f.candidate, 'copilot', 'node_modules'), { recursive: true, force: true });

  await assert.rejects(promoteProviderTools(f.candidate, releases, f.runtimeRoot));

  assert.deepEqual(readFileSync(current), before);
  assert.equal(await providerCommand('claude', f.runtimeRoot), installedExecutable(f.runtimeRoot,
    JSON.parse(before.toString('utf8')).providers.claude));
});

test('a corrupted active installation is replaced without deleting its immutable predecessor', async t => {
  const f = fixture(t);
  const initial = await promoteProviderTools(f.candidate, releases, f.runtimeRoot);
  const old = installedExecutable(f.runtimeRoot, initial.claude);
  writeFileSync(old, 'corrupted installed CLI\n', { mode: 0o700 });
  chmodSync(old, 0o700);

  const repaired = await promoteProviderTools(f.candidate, releases, f.runtimeRoot);
  const next = installedExecutable(f.runtimeRoot, repaired.claude);
  assert.notEqual(repaired.claude.installation, initial.claude.installation);
  assert.ok(existsSync(old), 'the prior installation is retained for live sessions');
  assert.equal(readFileSync(old, 'utf8'), 'corrupted installed CLI\n');
  assert.equal(await providerCommand('claude', f.runtimeRoot), next);
});

test('an unchanged verified candidate reuses the active immutable installations', async t => {
  const f = fixture(t);
  const initial = await promoteProviderTools(f.candidate, releases, f.runtimeRoot);
  const repeated = await promoteProviderTools(f.candidate, releases, f.runtimeRoot);

  assert.equal(repeated.claude.installation, initial.claude.installation);
  assert.equal(repeated.copilot.installation, initial.copilot.installation);
  assert.equal(await providerCommand('copilot', f.runtimeRoot), installedExecutable(f.runtimeRoot, initial.copilot));
});

test('the qualified candidate contract supplies its own default private runtime namespace', async t => {
  const f = fixture(t);
  const providers = await promoteProviderTools(f.candidate, releases);

  assert.ok(existsSync(join(f.defaultRoot, 'current.json')));
  assert.equal(await providerCommand('claude', f.defaultRoot), installedExecutable(f.defaultRoot, providers.claude));
});
