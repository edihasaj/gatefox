#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifiedBackend } from './macos-app-backend.mjs';
import { rejectSymlinkedPath, rejectSymlinks } from './sign-macos-app.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha256Pattern = /^[a-f0-9]{64}$/;
const sha1Pattern = /^[a-f0-9]{40}$/i;

export const usage = `Usage: node scripts/release-macos-app.mjs --backend-archive /absolute/release.tar.gz --backend-sha256 SHA256 --identity SHA1 [options]

Build, sign, notarize, validate, and optionally publish a production macOS app.

Options:
  --keychain /absolute/signing.keychain-db  Signing keychain
  --profile asc-notary                      Notary keychain profile (default: asc-notary)
  --publish                                 Create and publish the GitHub draft release
`;

export function parseArgs(argv) {
  const values = { profile: 'asc-notary', publish: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new Error(`${option} requires a value`);
      return next;
    };
    if (option === '--backend-archive') values.backendArchive = value();
    else if (option === '--backend-sha256') values.backendSha256 = value();
    else if (option === '--identity') values.identity = value();
    else if (option === '--keychain') values.keychain = value();
    else if (option === '--profile') values.profile = value();
    else if (option === '--publish') values.publish = true;
    else if (option === '--help') values.help = true;
    else throw new Error(`Unknown option: ${option}`);
  }
  if (values.help) return values;
  for (const name of ['backendArchive', 'keychain']) {
    if (values[name] && !isAbsolute(values[name])) throw new Error(`--${name.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)} must be an absolute path`);
  }
  if (!values.backendArchive || !values.backendSha256 || !values.identity) {
    throw new Error('--backend-archive, --backend-sha256, and --identity are required');
  }
  if (!sha256Pattern.test(values.backendSha256)) throw new Error('--backend-sha256 must be lowercase SHA-256');
  if (!sha1Pattern.test(values.identity)) throw new Error('--identity must be a Developer ID SHA-1 fingerprint');
  if (!values.profile || values.profile.includes('\0')) throw new Error('Invalid notary profile');
  return values;
}

function defaultRun(command, args, { cwd = root, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 20 * 60_000 });
  if (result.error || (!allowFailure && result.status !== 0)) {
    throw new Error(`${command} failed${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ''}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const output = (run, command, args, options) => run(command, args, options).stdout.trim();
const digestFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path, name) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Invalid ${name}`); }
};

function git(run, args, cwd) {
  return output(run, 'git', args, { cwd });
}

export function assertReleaseContext({ cwd = root, run = defaultRun } = {}) {
  if (git(run, ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd) !== 'production') {
    throw new Error('Release must run from the symbolic production branch');
  }
  if (git(run, ['status', '--porcelain'], cwd)) throw new Error('Release source must be clean and committed');
  const head = git(run, ['rev-parse', '--verify', 'HEAD'], cwd);
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Unable to resolve committed release HEAD');
  return head;
}

export function assertVersionLockfile({ cwd = root } = {}) {
  const packageJson = json(join(cwd, 'package.json'), 'package.json');
  const lockfile = json(join(cwd, 'package-lock.json'), 'package-lock.json');
  const version = packageJson.version;
  if (!/^\d+\.\d+\.[0-9]$/.test(version) || lockfile.version !== version ||
      lockfile.packages?.['']?.version !== version) {
    throw new Error('package.json and package-lock.json must contain the exact supported release version');
  }
  return version;
}

function safeArchiveEntries(text) {
  const entries = text.split('\n').map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) throw new Error('Backend archive is empty');
  const roots = new Set();
  for (const rawEntry of entries) {
    const entry = rawEntry.endsWith('/') ? rawEntry.slice(0, -1) : rawEntry;
    if (!entry || entry.includes('\\') || entry.startsWith('/') ||
        entry.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Backend archive has an unsafe entry');
    }
    roots.add(entry.split('/')[0]);
  }
  if (roots.size !== 1) throw new Error('Backend archive must have one top-level directory');
  return { entries, directory: [...roots][0] };
}

export function validateBackendArchive({ archive, sha256, version, source, directory, run = defaultRun }) {
  if (!isAbsolute(archive) || !sha256Pattern.test(sha256)) throw new Error('Invalid canonical backend archive');
  if (!existsSync(archive) || digestFile(archive) !== sha256) throw new Error('Backend archive SHA-256 does not match');
  const { directory: payload } = safeArchiveEntries(output(run, 'tar', ['-tzf', archive]));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  rejectSymlinkedPath(directory);
  const extraction = mkdtempSync(join(directory, '.backend-'));
  try {
    run('tar', ['-xzf', archive, '-C', extraction]);
    const root = lstatSync(join(extraction, payload));
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Backend archive root must be a real directory');
    const backend = verifiedBackend(join(extraction, payload));
    const release = json(join(backend.root, 'package/release.json'), 'backend release receipt');
    if (backend.version !== version || release.version !== version || release.source !== source) {
      throw new Error('Backend archive version or source does not match production HEAD');
    }
    return { backend, release };
  } finally {
    // This private scratch directory holds only checked release payload bytes.
    rmSync(extraction, { recursive: true, force: true });
  }
}

export function finalJson(stdout, name) {
  for (const line of stdout.trim().split('\n').reverse()) {
    try { return JSON.parse(line); } catch { /* Earlier build output is intentionally ignored. */ }
  }
  throw new Error(`${name} did not emit a final JSON result`);
}

function appPolicy(version, source, backendSha256) {
  return {
    schemaVersion: 1, version, source, branch: 'production',
    backendAsset: `harness-gateway-${version}-macos-arm64.tar.gz`, backendSha256,
  };
}

export function validateSignedApp({ app, version, source, backendSha256, signed = true }) {
  if (!isAbsolute(app) || !app.endsWith('.app')) throw new Error('Builder returned an invalid app path');
  const resources = join(app, 'Contents/Resources');
  const receipt = json(join(resources, 'app-build.json'), 'app build receipt');
  const expected = { appVersion: version, backendVersion: version, managementVersion: version, source,
    sourceModified: false, sourceBranch: 'production', production: true, signedForDistribution: signed };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) throw new Error(`App build receipt does not prove ${key}`);
  }
  const policy = json(join(resources, 'update-policy.json'), 'signed update policy');
  if (JSON.stringify(policy) !== JSON.stringify(appPolicy(version, source, backendSha256))) {
    throw new Error('Signed update policy does not match the canonical backend');
  }
  return { receipt, policy };
}

function verifySignedApp(run, app) {
  run('codesign', ['--verify', '--deep', '--strict', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
  run('xcrun', ['stapler', 'validate', app]);
}

function safeZipEntries(text) {
  const entries = text.split('\n').map(value => value.trim()).filter(Boolean);
  if (!entries.length) throw new Error('Signed ZIP is empty');
  for (const entry of entries) {
    if (entry.includes('\\') || entry.startsWith('/') || entry.split('/').some(part => part === '.' || part === '..')) {
      throw new Error('Signed ZIP has an unsafe entry');
    }
    if (!entry.startsWith('Harness Gateway.app/')) throw new Error('Signed ZIP has an unexpected top-level entry');
  }
}

export function validateFinalZip({ archive, directory, run = defaultRun }) {
  safeZipEntries(output(run, 'unzip', ['-Z1', archive]));
  const extraction = mkdtempSync(join(directory, '.signed-app-'));
  try {
    run('ditto', ['-x', '-k', archive, extraction]);
    const app = join(extraction, 'Harness Gateway.app');
    if (!existsSync(app)) throw new Error('Signed ZIP did not contain the app');
    rejectSymlinks(app);
    return { app, extraction };
  } catch (error) {
    rmSync(extraction, { recursive: true, force: true });
    throw error;
  }
}

function makeMetadata({ version, source, appAsset, appSha256, backendAsset, backendSha256 }) {
  return { schemaVersion: 1, version, source, branch: 'production', appAsset, appSha256, backendAsset, backendSha256 };
}

function copyCanonicalBackend(input, target, sha256) {
  copyFileSync(input, target, constants.COPYFILE_EXCL);
  if (digestFile(target) !== sha256) throw new Error('Canonical backend copy changed');
}

function writeStage({ directory, version, source, backendArchive, backendSha256, signedArchive }) {
  const backendAsset = `harness-gateway-${version}-macos-arm64.tar.gz`;
  const appAsset = `Harness-Gateway-${version}-macos-arm64.zip`;
  const backend = join(directory, backendAsset);
  const app = join(directory, appAsset);
  copyCanonicalBackend(backendArchive, backend, backendSha256);
  if (resolve(signedArchive) !== resolve(app)) copyFileSync(signedArchive, app, 0);
  const appSha256 = digestFile(app);
  const metadata = makeMetadata({ version, source, appAsset, appSha256, backendAsset, backendSha256 });
  const metadataPath = join(directory, 'app-update.json');
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const sums = join(directory, 'SHA256SUMS');
  writeFileSync(sums, [appAsset, backendAsset, 'app-update.json'].map(name => `${digestFile(join(directory, name))}  ${name}`).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 });
  return { backend, app, metadata: metadataPath, sums, metadataValue: metadata };
}

function verifyStage(stage, expected) {
  if (digestFile(stage.backend) !== expected.backendSha256 || digestFile(stage.app) !== expected.appSha256) {
    throw new Error('Release assets changed after verification');
  }
  if (JSON.stringify(json(stage.metadata, 'app update metadata')) !== JSON.stringify(stage.metadataValue)) {
    throw new Error('Release metadata changed after verification');
  }
}

export function assertRemoteProduction(run, cwd, head) {
  const fetch = run('git', ['fetch', '--no-tags', 'origin', 'production:refs/remotes/origin/production'],
    { cwd, allowFailure: true });
  if (fetch.status !== 0) throw new Error('Unable to freshen origin/production before publishing');
  const result = run('git', ['rev-parse', '--verify', 'refs/remotes/origin/production'], { cwd, allowFailure: true });
  if (result.status !== 0 || result.stdout.trim() !== head) {
    throw new Error('origin/production must point exactly at release HEAD before publishing');
  }
}

export function releaseAssets(run, tag, cwd) {
  const probe = run('gh', ['release', 'view', tag, '--json', 'isDraft,assets'], { cwd, allowFailure: true });
  if (probe.status === 0) throw new Error(`GitHub release ${tag} already exists; refusing to overwrite its assets`);
}

export function verifyUploadedAssets(run, tag, stage, cwd) {
  const response = JSON.parse(output(run, 'gh', ['release', 'view', tag, '--json', 'isDraft,assets'], { cwd }));
  if (!response.isDraft || !Array.isArray(response.assets) || response.assets.length !== 4) {
    throw new Error('GitHub draft release does not contain exactly the expected assets');
  }
  const expected = [stage.backend, stage.app, stage.metadata, stage.sums].map(path => ({
    name: basename(path), size: statSync(path).size, digest: `sha256:${digestFile(path)}`,
  }));
  for (const asset of expected) {
    const found = response.assets.filter(value => value.name === asset.name);
    if (found.length !== 1 || found[0].size !== asset.size || found[0].digest !== asset.digest) {
      throw new Error(`GitHub uploaded asset verification failed for ${asset.name}`);
    }
  }
}

export function publishRelease({ version, head, stage, cwd = root, run = defaultRun }) {
  const tag = `app-v${version}`;
  releaseAssets(run, tag, cwd);
  const notes = join(mkdtempSync(join(tmpdir(), 'harness-gateway-release-')), 'notes.md');
  try {
    writeFileSync(notes, `Harness Gateway macOS app ${version}\n`, { flag: 'wx', mode: 0o600 });
    run('gh', ['release', 'create', tag, '--draft', '--target', head, '--notes-file', notes,
      stage.backend, stage.app, stage.metadata, stage.sums], { cwd });
    verifyUploadedAssets(run, tag, stage, cwd);
    run('gh', ['release', 'edit', tag, '--draft=false'], { cwd });
  } finally {
    rmSync(dirname(notes), { recursive: true, force: true });
  }
}

export function releaseMacosApp(options, { cwd = root, run = defaultRun } = {}) {
  const head = assertReleaseContext({ cwd, run });
  const version = assertVersionLockfile({ cwd });
  const canonicalBackend = validateBackendArchive({ archive: options.backendArchive, sha256: options.backendSha256,
    version, source: head, directory: join(cwd, '.state'), run });
  const stageDirectory = join(cwd, '.state/app-release', version);
  if (existsSync(stageDirectory)) throw new Error(`Release stage already exists: ${stageDirectory}`);
  mkdirSync(stageDirectory, { recursive: true, mode: 0o700 });
  rejectSymlinkedPath(stageDirectory);

  const build = finalJson(output(run, process.execPath, ['scripts/build-macos-app.mjs', '--production',
    '--backend-archive', options.backendArchive, '--backend-sha256', options.backendSha256], { cwd }), 'App builder');
  if (build.backendVersion !== version || build.signedForDistribution !== false) throw new Error('App builder returned an invalid production build');
  validateSignedApp({ app: build.app, version, source: head, backendSha256: options.backendSha256, signed: false });

  const archive = join(stageDirectory, `Harness-Gateway-${version}-macos-arm64.zip`);
  const signArgs = ['scripts/sign-macos-app.mjs', '--app', build.app, '--identity', options.identity,
    ...(options.keychain ? ['--keychain', options.keychain] : []), '--profile', options.profile, '--notarize', '--archive', archive];
  const signed = finalJson(output(run, process.execPath, signArgs, { cwd }), 'App signer');
  if (signed.archive !== archive || signed.signedForDistribution !== true) throw new Error('App signer did not produce the requested final ZIP');
  validateSignedApp({ app: build.app, version, source: head, backendSha256: options.backendSha256 });
  verifySignedApp(run, build.app);
  const extracted = validateFinalZip({ archive, directory: join(cwd, '.state'), run });
  try {
    run(process.execPath, ['scripts/e2e-macos-runtime.mjs', extracted.app], { cwd });
  } finally {
    rmSync(extracted.extraction, { recursive: true, force: true });
  }

  const stage = writeStage({ directory: stageDirectory, version, source: head, backendArchive: options.backendArchive,
    backendSha256: options.backendSha256, signedArchive: archive });
  verifyStage(stage, { backendSha256: options.backendSha256, appSha256: stage.metadataValue.appSha256 });
  if (options.publish) {
    const freshHead = assertReleaseContext({ cwd, run });
    if (freshHead !== head) throw new Error('Release HEAD changed before publishing');
    assertRemoteProduction(run, cwd, head);
    validateSignedApp({ app: build.app, version, source: head, backendSha256: options.backendSha256 });
    verifyStage(stage, { backendSha256: options.backendSha256, appSha256: stage.metadataValue.appSha256 });
    publishRelease({ version, head, stage, cwd, run });
  }
  return { version, source: head, directory: stageDirectory, published: options.publish, backend: canonicalBackend.backend.root };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(usage);
    else process.stdout.write(`${JSON.stringify(releaseMacosApp(options))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
