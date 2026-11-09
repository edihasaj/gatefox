#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { installRoot } from './install-root.mjs';
import { appAsset, appBundle, backendAsset, installedApp } from './release-names.mjs';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { extractProductionBackend } from './macos-app-production.mjs';
import { rejectSymlinkedPath, rejectSymlinks } from './sign-macos-app.mjs';
import { assertFreeSpace, releaseDiskSpaceRequirements } from './disk-space.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha256Pattern = /^[a-f0-9]{64}$/;
const sha1Pattern = /^[a-f0-9]{40}$/i;

export const usage = `Usage: node scripts/release-macos-app.mjs --backend-archive /absolute/release.tar.gz --backend-sha256 SHA256 --identity SHA1 [options]

Build, sign, notarize, validate, and optionally publish a production macOS app.

Options:
  --keychain /absolute/signing.keychain-db  Signing keychain
  --profile asc-notary                      Notary keychain profile (default: asc-notary)
  --previous-app /absolute/GateFox.app        Signed app to upgrade (publish only)
  --installed-release /absolute/gateway-release Existing CLI release (publish only)
  --publish                                 Create and publish the GitHub draft release
  --prerelease                              Publish for selected-machine rollout; automatic updaters ignore it
`;

export function parseArgs(argv) {
  const values = {
    profile: 'asc-notary', publish: false, prerelease: false,
    previousApp: installedApp(join(homedir(), 'Applications')),
    installedRelease: join(installRoot(join(homedir(), '.local')), 'current'),
  };
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
    else if (option === '--previous-app') values.previousApp = value();
    else if (option === '--installed-release') values.installedRelease = value();
    else if (option === '--publish') values.publish = true;
    else if (option === '--prerelease') values.prerelease = true;
    else if (option === '--help') values.help = true;
    else throw new Error(`Unknown option: ${option}`);
  }
  if (values.help) return values;
  if (values.prerelease && !values.publish) throw new Error('--prerelease requires --publish');
  for (const name of ['backendArchive', 'keychain', 'previousApp', 'installedRelease']) {
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

export function defaultRun(command, args, { cwd = root, allowFailure = false, spawn = spawnSync } = {}) {
  const result = spawn(command, args, { cwd, encoding: 'utf8', timeout: 20 * 60_000 });
  if (result.error || (!allowFailure && result.status !== 0)) {
    const name = basename(command);
    const script = /^node(?:\.exe)?$/i.test(name) && args[0] ? ` ${args[0]}` : '';
    const outcome = result.signal ? `signal ${result.signal}` : `exit status ${result.status ?? 'unknown'}`;
    const tail = scrubFailureTail([result.stderr, result.stdout].filter(Boolean).join('\n'), homedir());
    throw new Error(`${name}${script} failed with ${outcome}. Last output:\n${tail || '(no safe output)'}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function scrubFailureTail(output, home) {
  const unsafe = /token|password|secret|authorization|bearer|api[_-]?key|cookie|[a-z][a-z0-9+.-]*:\/\/[^/\s]*@|\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}|\bsk-[A-Za-z0-9_-]{10,}|\bxox[abposr]-|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.|^\s*(?:export\s+)?[A-Z][A-Z0-9_]*=/i;
  const safeLines = [];
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const begin = /^-----BEGIN ([A-Z0-9 ]+)-----$/.exec(lines[index]);
    if (!begin) { safeLines.push(lines[index]); continue; }
    const end = `-----END ${begin[1]}-----`;
    while (index < lines.length && lines[index] !== end) index += 1;
    if (index === lines.length) break;
  }
  return safeLines.slice(-20).filter(line => !unsafe.test(line))
    .map(line => home ? line.replaceAll(home, '~').slice(0, 300) : line.slice(0, 300)).join('\n');
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

export function validateBackendArchive({ archive, sha256, version, source, directory }) {
  if (!isAbsolute(archive) || !sha256Pattern.test(sha256)) throw new Error('Invalid canonical backend archive');
  if (!existsSync(archive)) throw new Error('Backend archive is missing');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  rejectSymlinkedPath(directory);
  const extraction = mkdtempSync(join(directory, '.backend-'));
  try {
    const backend = extractProductionBackend({ archive, sha256, version, source, destination: join(extraction, 'backend') });
    for (const component of ['native/gateway-native-relay', 'gateway-sdk/gateway-codex']) {
      if (!backend.entries.has(`package/${component}`)) {
        throw new Error('App distribution requires the native relay and gateway SDK; build the backend with --with-native --with-gateway-sdk');
      }
    }
    return { version: backend.version };
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
    backendAsset: backendAsset(version), backendSha256,
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

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP_UNIX = new Set([3, 19]);
const ZIP_FILE = 0o100000;
const ZIP_DIRECTORY = 0o040000;

function safeZipPath(name) {
  const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!normalized || normalized.includes('\\') || normalized.startsWith('/') || /[\0-\x1f\x7f]/.test(normalized) ||
      normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Signed ZIP has an unsafe entry');
  }
  return normalized;
}

function appleDoublePath(name, directory) {
  if ((name === '__MACOSX' || name === `__MACOSX/${appBundle}`) && directory) return true;
  if (name === `__MACOSX/._${appBundle}` && !directory) return true;
  if (!name.startsWith(`__MACOSX/${appBundle}/`)) return false;
  if (directory) return true;
  return basename(name).startsWith('._');
}

function appleDouble(bytes, local, compressed, uncompressed, method, nameLength, extraLength) {
  const start = local + 30 + nameLength + extraLength;
  const payload = bytes.subarray(start, start + compressed);
  let data;
  try { data = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: 16 * 1024 * 1024 }); }
  catch { throw new Error('Invalid AppleDouble ZIP metadata'); }
  if (data.length !== uncompressed || data.length < 26 || data.readUInt32BE(0) !== 0x00051607 ||
      data.readUInt32BE(4) !== 0x00020000) throw new Error('Invalid AppleDouble ZIP metadata');
}

export function inspectFinalZip(archive) {
  const info = statSync(archive);
  if (!info.isFile() || info.size < 22 || info.size > 2 * 1024 * 1024 * 1024) throw new Error('Invalid signed ZIP size');
  const bytes = readFileSync(archive);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === ZIP_EOCD) { eocd = index; break; }
  }
  if (eocd < 0 || bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6)) throw new Error('Signed ZIP has multiple disks');
  const entries = bytes.readUInt16LE(eocd + 10);
  const size = bytes.readUInt32LE(eocd + 12);
  const offset = bytes.readUInt32LE(eocd + 16);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size > eocd) {
    throw new Error('Signed ZIP must not use ZIP64 or overlapping metadata');
  }
  if (entries > 100_000) throw new Error('Signed ZIP has too many entries');
  const names = new Map(); let cursor = offset; let appEntries = 0; let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > offset + size || bytes.readUInt32LE(cursor) !== ZIP_CENTRAL) throw new Error('Invalid signed ZIP directory');
    const flags = bytes.readUInt16LE(cursor + 8);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const method = bytes.readUInt16LE(cursor + 10);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const disk = bytes.readUInt16LE(cursor + 34);
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const attributes = bytes.readUInt32LE(cursor + 38);
    const local = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > offset + size || flags & 1 || disk || local + 30 > offset || bytes.readUInt32LE(local) !== ZIP_LOCAL ||
        ![0, 8].includes(method) || compressed > 1024 * 1024 * 1024 || uncompressed > 1024 * 1024 * 1024 ||
        (total += uncompressed) > 2 * 1024 * 1024 * 1024) throw new Error('Unsafe signed ZIP entry');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const normalized = safeZipPath(name);
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const localName = bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8');
    if (local + 30 + localNameLength + localExtraLength + compressed > offset || localName !== name ||
        bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw new Error('Unsafe signed ZIP entry');
    const directory = name.endsWith('/');
    if (names.has(normalized) || (normalized === appBundle && !directory)) throw new Error('Signed ZIP has duplicate entries');
    names.set(normalized, directory);
    const creator = madeBy >>> 8;
    const type = (attributes >>> 16) & 0o170000;
    if (ZIP_UNIX.has(creator) && type !== (directory ? ZIP_DIRECTORY : ZIP_FILE)) throw new Error('Signed ZIP contains a link or special file');
    if ((normalized === appBundle && directory) || name.startsWith(`${appBundle}/`)) appEntries++;
    else if (!appleDoublePath(normalized, directory)) throw new Error('Signed ZIP has an unexpected top-level entry');
    if (appleDoublePath(normalized, directory) && !directory) {
      appleDouble(bytes, local, compressed, uncompressed, method, localNameLength, localExtraLength);
    }
    cursor = end;
  }
  for (const [name] of names) {
    for (let slash = name.indexOf('/'); slash >= 0; slash = name.indexOf('/', slash + 1)) {
      if (names.get(name.slice(0, slash)) === false) throw new Error('Signed ZIP has a file-directory collision');
    }
  }
  if (!appEntries || cursor !== offset + size) throw new Error('Signed ZIP is incomplete');
}

export function validateFinalZip({ archive, directory, run = defaultRun }) {
  inspectFinalZip(archive);
  const extraction = mkdtempSync(join(directory, '.signed-app-'));
  try {
    run('ditto', ['-x', '-k', archive, extraction]);
    const app = join(extraction, appBundle);
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
  const backendAssetName = backendAsset(version);
  const appAssetName = appAsset(version);
  const backend = join(directory, backendAssetName);
  const app = join(directory, appAssetName);
  copyCanonicalBackend(backendArchive, backend, backendSha256);
  if (resolve(signedArchive) !== resolve(app)) copyFileSync(signedArchive, app, 0);
  const appSha256 = digestFile(app);
  const metadata = makeMetadata({ version, source, appAsset: appAssetName, appSha256, backendAsset: backendAssetName, backendSha256 });
  const metadataPath = join(directory, 'app-update.json');
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const sums = join(directory, 'SHA256SUMS');
  writeFileSync(sums, [appAssetName, backendAssetName, 'app-update.json'].map(name => `${digestFile(join(directory, name))}  ${name}`).join('\n') + '\n',
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

export function assertRemoteTag(run, cwd, tag, head) {
  const result = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { cwd, allowFailure: true });
  if (result.status !== 0) throw new Error(`Unable to verify remote tag ${tag}`);
  const refs = new Map(result.stdout.trim().split('\n').filter(Boolean).map(line => line.split(/\s+/, 2)).map(([hash, ref]) => [ref, hash]));
  const direct = refs.get(`refs/tags/${tag}`);
  if (!direct) return;
  const target = refs.get(`refs/tags/${tag}^{}`) ?? direct;
  if (target !== head) throw new Error(`Remote tag ${tag} does not resolve to release HEAD`);
}

export function releaseAssets(run, tag, cwd) {
  const probe = run('gh', ['release', 'view', tag, '--json', 'isDraft,assets'], { cwd, allowFailure: true });
  if (probe.status === 0) throw new Error(`GitHub release ${tag} already exists; refusing to overwrite its assets`);
}

export function verifyUploadedAssets(run, tag, stage, cwd, prerelease = false) {
  const response = JSON.parse(output(run, 'gh', ['release', 'view', tag, '--json', 'isDraft,isPrerelease,assets'], { cwd }));
  if (prerelease && response.isPrerelease !== true) throw new Error('Selected-machine release must remain a prerelease');
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

/** The release tag: the standard `vVERSION` from 1.8.0, `app-vVERSION` before (the tag 1.7.5 and older updaters read). */
export function releaseTag(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 1 || major === 1 && minor >= 8 ? `v${version}` : `app-v${version}`;
}

/** The version's CHANGELOG.md section, without its heading, or a one-line fallback. */
export function releaseNotes(version, cwd = root) {
  const text = existsSync(join(cwd, 'CHANGELOG.md')) ? readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8') : '';
  const start = text.search(new RegExp(`^## ${version.replaceAll('.', '\\.')}(?: |$)`, 'm'));
  if (start < 0) return `GateFox macOS app ${version}\n`;
  const body = text.slice(text.indexOf('\n', start) + 1), next = body.search(/^## /m);
  return `${(next < 0 ? body : body.slice(0, next)).trim()}\n`;
}

export function publishRelease({ version, head, stage, cwd = root, run = defaultRun, beforePublish = () => {}, prerelease = false }) {
  const tag = releaseTag(version);
  const latest = prerelease ? ['--prerelease', '--latest=false'] : tag.startsWith('v') ? ['--latest'] : [];
  releaseAssets(run, tag, cwd);
  const notes = join(mkdtempSync(join(tmpdir(), 'gatefox-release-')), 'notes.md');
  try {
    writeFileSync(notes, releaseNotes(version, cwd), { flag: 'wx', mode: 0o600 });
    run('gh', ['release', 'create', tag, '--draft', ...(prerelease ? ['--prerelease', '--latest=false'] : []), '--title', `GateFox ${version}`, '--target', head, '--notes-file', notes,
      stage.backend, stage.app, stage.metadata, stage.sums], { cwd });
    verifyUploadedAssets(run, tag, stage, cwd, prerelease);
    beforePublish();
    run('gh', ['release', 'edit', tag, '--draft=false', ...latest], { cwd });
  } finally {
    rmSync(dirname(notes), { recursive: true, force: true });
  }
}

export function runUpdateFixture({ appArchive, backendArchive, previousApp, installedRelease, cwd = root, run = defaultRun }) {
  const fixtureRoot = join(cwd, '.state', `app-update-e2e-${createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`);
  if (existsSync(fixtureRoot)) throw new Error('Update fixture root already exists');
  run(process.execPath, ['scripts/e2e-app-updates.mjs', '--app-archive', appArchive, '--backend-archive', backendArchive,
    '--legacy-app', previousApp, '--installed-release', installedRelease, '--root', fixtureRoot], { cwd });
  return fixtureRoot;
}

/**
 * The deployed release must hand chats to this one without a restart (scripts/check-forward-compat.mjs): it runs that
 * release's own forwarding code against the backend archive and refuses to publish a release it would refuse.
 */
export function runForwardCheck({ backendArchive, installedRelease, cwd = root, run = defaultRun }) {
  run(process.execPath, ['scripts/check-forward-compat.mjs', '--deployed', join(installedRelease, 'package'), '--candidate', backendArchive], { cwd });
}

export function validatePublishFixtureInputs({ previousApp, installedRelease, run = defaultRun }) {
  if (!isAbsolute(previousApp) || !previousApp.endsWith('.app') || !existsSync(previousApp) || !statSync(previousApp).isDirectory()) {
    throw new Error('Publishing requires an existing signed --previous-app bundle');
  }
  if (!isAbsolute(installedRelease) || !existsSync(installedRelease) || !statSync(installedRelease).isDirectory()) {
    throw new Error('Publishing requires an existing --installed-release directory');
  }
  verifySignedApp(run, previousApp);
}

export function releaseMacosApp(options, { cwd = root, run = defaultRun, e2e = runUpdateFixture, forward = runForwardCheck } = {}) {
  assertFreeSpace(join(cwd, '.state'), releaseDiskSpaceRequirements.releaseMacosApp, 'macOS app release');
  const head = assertReleaseContext({ cwd, run });
  const version = assertVersionLockfile({ cwd });
  validateBackendArchive({ archive: options.backendArchive, sha256: options.backendSha256,
    version, source: head, directory: join(cwd, '.state') });
  const stageDirectory = join(cwd, '.state/app-release', version);
  if (existsSync(stageDirectory)) throw new Error(`Release stage already exists: ${stageDirectory}`);
  mkdirSync(stageDirectory, { recursive: true, mode: 0o700 });
  rejectSymlinkedPath(stageDirectory);

  const build = finalJson(output(run, process.execPath, ['scripts/build-macos-app.mjs', '--production',
    '--backend-archive', options.backendArchive, '--backend-sha256', options.backendSha256], { cwd }), 'App builder');
  if (build.backendVersion !== version || build.signedForDistribution !== false) throw new Error('App builder returned an invalid production build');
  validateSignedApp({ app: build.app, version, source: head, backendSha256: options.backendSha256, signed: false });

  const archive = join(stageDirectory, appAsset(version));
  const signArgs = ['scripts/sign-macos-app.mjs', '--app', build.app, '--identity', options.identity,
    ...(options.keychain ? ['--keychain', options.keychain] : []), '--profile', options.profile, '--notarize', '--archive', archive];
  const signed = finalJson(output(run, process.execPath, signArgs, { cwd }), 'App signer');
  if (signed.archive !== archive || signed.signedForDistribution !== true) throw new Error('App signer did not produce the requested final ZIP');
  validateSignedApp({ app: build.app, version, source: head, backendSha256: options.backendSha256 });
  verifySignedApp(run, build.app);
  const extracted = validateFinalZip({ archive, directory: join(cwd, '.state'), run });
  try {
    validateSignedApp({ app: extracted.app, version, source: head, backendSha256: options.backendSha256 });
    verifySignedApp(run, extracted.app);
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
    assertRemoteTag(run, cwd, releaseTag(version), head);
    validateSignedApp({ app: build.app, version, source: head, backendSha256: options.backendSha256 });
    verifyStage(stage, { backendSha256: options.backendSha256, appSha256: stage.metadataValue.appSha256 });
    validatePublishFixtureInputs({ previousApp: options.previousApp, installedRelease: options.installedRelease, run });
    forward({ backendArchive: options.backendArchive, installedRelease: options.installedRelease, cwd, run });
    assertFreeSpace(join(cwd, '.state'), releaseDiskSpaceRequirements.releaseMacosApp, 'macOS app update fixture');
    e2e({ appArchive: stage.app, backendArchive: options.backendArchive, previousApp: options.previousApp,
      installedRelease: options.installedRelease, cwd, run });
    publishRelease({ version, head, stage, cwd, run, prerelease: options.prerelease, beforePublish: () => {
      if (assertReleaseContext({ cwd, run }) !== head) throw new Error('Release HEAD changed before final publication');
      assertRemoteProduction(run, cwd, head);
      assertRemoteTag(run, cwd, releaseTag(version), head);
      validateSignedApp({ app: build.app, version, source: head, backendSha256: options.backendSha256 });
      verifyStage(stage, { backendSha256: options.backendSha256, appSha256: stage.metadataValue.appSha256 });
    } });
  }
  return { version, source: head, directory: stageDirectory, published: options.publish, prerelease: options.prerelease === true };
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
