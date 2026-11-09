#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { digest, verifiedBackend } from './macos-app-backend.mjs';
import { backendAsset } from './release-names.mjs';

const BACKEND = 'Contents/Resources/backend';
const BUILD_RECEIPT = 'Contents/Resources/app-build.json';
const UPDATE_POLICY = 'Contents/Resources/update-policy.json';
const TEAM = /^TeamIdentifier=([A-Z0-9]+)$/m;
const SHA1 = /^[a-fA-F0-9]{40}$/;
const DEVELOPER_ID_REQUIREMENT = 'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
const MACOS_NAMESPACE_ALIASES = new Map([['/var', '/private/var'], ['/tmp', '/private/tmp']]);
const APP_IDENTIFIER = 'com.edihasaj.harness-gateway.app';
const entitlement = name => fileURLToPath(new URL(`../native/macos/${name}.entitlements`, import.meta.url));

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function parseArgs(argv) {
  const options = { profile: 'asc-notary', notarize: false, archive: null, keychain: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === '--app') options.app = value();
    else if (arg === '--identity') options.identity = value();
    else if (arg === '--keychain') options.keychain = value();
    else if (arg === '--profile') options.profile = value();
    else if (arg === '--notarize') options.notarize = true;
    else if (arg === '--archive') {
      const next = argv[index + 1];
      options.archive = next && !next.startsWith('--') ? argv[++index] : true;
    } else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (!options.app || !isAbsolute(options.app)) throw new Error('--app must be an absolute path');
  if (!options.app.endsWith('.app')) throw new Error('--app must name a .app bundle');
  if (!options.identity || !SHA1.test(options.identity)) {
    throw new Error('--identity must be a Developer ID SHA-1 fingerprint');
  }
  for (const name of ['keychain', 'archive']) {
    if (typeof options[name] === 'string' && !isAbsolute(options[name])) {
      throw new Error(`--${name} must be an absolute path`);
    }
  }
  if (!options.profile || options.profile.includes('\0')) throw new Error('Invalid notary profile');
  return options;
}

export const usage = `Usage: npm run app:sign -- --app /absolute/Harness\\ Gateway.app --identity SHA1 [options]

Options:
  --keychain /absolute/signing.keychain-db  Use this keychain for codesign and notarytool
  --profile asc-notary                      Keychain profile for notarytool (default: asc-notary)
  --notarize                               Submit, staple, validate, and assess Gatekeeper
  --archive [/absolute/GateFox.zip]        Write a final distributable ZIP (default: beside the app)
`;

function command(binary, args) {
  const timeout = binary === 'xcrun' && args[0] === 'notarytool' ? 20 * 60_000 : 30_000;
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(`${binary} failed`);
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function appPath(app, relative) {
  return join(app, ...relative.split('/'));
}

export function rejectSymlinks(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error('App bundle must not contain symbolic links');
  if (!info.isDirectory()) return;
  for (const name of readdirSync(path)) rejectSymlinks(join(path, name));
}

export function rejectSymlinkedPath(path, { allowMissing = false } = {}) {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return;
      if (error.code === 'ENOENT') throw new Error(`Missing path component: ${current}`);
      throw error;
    }
    if (info.isSymbolicLink()) {
      try {
        if (realpathSync(current) === MACOS_NAMESPACE_ALIASES.get(current)) continue;
      } catch { /* A dangling path link is never safe. */ }
      throw new Error(`Path must not contain symbolic links: ${current}`);
    }
  }
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Invalid ${label}`); }
}

function sourceGit(args) {
  return command('git', args).stdout;
}

export function preflightProductionSigning(app, receipt, { runGit = sourceGit } = {}) {
  if (receipt.production !== true) return;
  if (receipt.sourceBranch !== 'production' || receipt.sourceModified !== false ||
      !/^[a-f0-9]{40}$/.test(receipt.source ?? '') ||
      !/^\d+\.\d+\.\d+$/.test(receipt.appVersion ?? '') ||
      receipt.backendVersion !== receipt.appVersion ||
      !/^[a-f0-9]{64}$/.test(receipt.backendSha256 ?? '')) {
    throw new Error('Invalid production app build receipt');
  }
  if (runGit(['branch', '--show-current']).trim() !== 'production' ||
      runGit(['status', '--porcelain']).trim() ||
      runGit(['rev-parse', 'HEAD']).trim() !== receipt.source) {
    throw new Error('Production app signing requires a clean matching production source');
  }
  const policy = readJson(appPath(app, UPDATE_POLICY), 'update policy');
  const expected = {
    schemaVersion: 1, version: receipt.appVersion, source: receipt.source, branch: 'production',
    backendAsset: backendAsset(receipt.appVersion),
    backendSha256: receipt.backendSha256,
  };
  if (JSON.stringify(policy) !== JSON.stringify(expected)) throw new Error('Production update policy does not match app build receipt');
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fileRecord(root, relative) {
  const bytes = readFileSync(join(root, relative));
  return { path: relative, sha256: digest(bytes), size: bytes.length };
}

function signArguments(identity, keychain, target, identifier, entitlements = entitlement('Gateway')) {
  return ['--force', '--timestamp', '--options', 'runtime', '--sign', identity,
    '--identifier', identifier, '--entitlements', entitlements,
    ...(keychain ? ['--keychain', keychain] : []), target];
}

// A component binary and its optional companion host are each signed with their own identifier.
const signingTargets = targets => targets.flatMap(target => target.companion ? [target, target.companion] : [target]);

function componentTargets(app, backend) {
  const targets = [
    { component: 'service', binary: 'Contents/MacOS/GatewayService', receipt: null,
      identifier: 'com.edihasaj.harness-gateway.service' },
    { component: 'updater', binary: 'Contents/MacOS/GatewayUpdateInstaller', receipt: null,
      identifier: 'com.edihasaj.harness-gateway.updater' },
    { component: 'node', binary: `${BACKEND}/runtime/bin/node`, receipt: null,
      identifier: 'com.edihasaj.harness-gateway.node', entitlements: entitlement('Node') },
  ];
  for (const [component, binary] of [['native', 'gateway-native-relay'], ['gateway-sdk', 'gateway-codex']]) {
    const relative = `package/${component}/${binary}`;
    const host = `package/${component}/codex-code-mode-host`;
    if (backend.entries.has(relative)) targets.push({
      component,
      binary: `${BACKEND}/${relative}`,
      receipt: `package/${component}/build.json`,
      identifier: `com.edihasaj.harness-gateway.${component}`,
      // Codex's Code Mode host needs its own identifier plus the JIT entitlements V8 requires; its
      // signed hash is recorded in the same gateway SDK receipt the CLI's goes into.
      ...(component === 'gateway-sdk' && backend.entries.has(host) ? { companion: {
        binary: `${BACKEND}/${host}`,
        identifier: 'com.edihasaj.harness-gateway.code-mode-host',
        entitlements: entitlement('CodeModeHost'),
      } } : {}),
    });
  }
  for (const target of signingTargets(targets)) {
    const path = appPath(app, target.binary);
    if (!lstatSync(path).isFile()) throw new Error(`Missing signing target: ${target.binary}`);
  }
  return targets;
}

function componentReceiptKey(component) {
  return component === 'native' ? 'native' : 'gatewaySdk';
}

function reusedFiles(release, component, build, backendVersion) {
  if (build.version === backendVersion) return null;
  const group = release.reusedComponents?.components?.[componentReceiptKey(component)];
  if (!group || !Array.isArray(group.files)) {
    throw new Error(`release.json has no reused-component receipt for ${component}`);
  }
  return group.files;
}

function matchingReusedFile(files, record) {
  const name = basename(record.path);
  const matches = files.filter(file => file?.name === name && file.size === record.size && file.sha256 === record.sha256);
  if (matches.length !== 1) throw new Error(`release.json receipt does not match ${record.path}`);
  return matches[0];
}

function preflightComponents(app, backend, release) {
  const targets = componentTargets(app, backend);
  return targets.map(target => {
    const before = fileRecord(app, target.binary);
    if (!target.receipt) return { target, before, receipt: null };
    const buildRelative = `${BACKEND}/${target.receipt}`;
    const buildBefore = fileRecord(app, buildRelative);
    const build = readJson(appPath(app, buildRelative), `${target.component} build receipt`);
    if (build.originalBinarySha256 ||
        ('binarySha256' in build && build.binarySha256 !== before.sha256) ||
        (target.component !== 'native' && typeof build.binarySha256 !== 'string')) {
      throw new Error(`Invalid ${target.component} build receipt`);
    }
    const reused = reusedFiles(release, target.component, build, backend.version);
    let companionBefore;
    if (target.companion) {
      companionBefore = fileRecord(app, target.companion.binary);
      if (build.originalCodeModeHostSha256 || typeof build.codeModeHostSha256 !== 'string' ||
          build.codeModeHostSha256 !== companionBefore.sha256) {
        throw new Error(`Invalid ${target.component} code-mode host receipt`);
      }
      if (reused) matchingReusedFile(reused, companionBefore);
    }
    if (reused) {
      matchingReusedFile(reused, before);
      matchingReusedFile(reused, buildBefore);
    }
    return { target, before, buildRelative, buildBefore, build, reused, companionBefore };
  });
}

function resetSignedReceipt(path) {
  const receipt = readJson(path, 'app build receipt');
  receipt.signedForDistribution = false;
  writeJson(path, receipt);
}

function codesignTeam(run, path) {
  const result = run('codesign', ['-dvv', path]);
  const details = `${result.stdout}\n${result.stderr}`;
  const match = TEAM.exec(details);
  if (!match) throw new Error('codesign did not report a signing team');
  return match[1];
}

function verifyTrusted(run, path, { deep = false } = {}) {
  run('codesign', ['--verify', ...(deep ? ['--deep'] : []), '--strict', `-R=${DEVELOPER_ID_REQUIREMENT}`, path]);
}

function verifySeal(run, app, targets, expectedTeam) {
  verifyTrusted(run, app, { deep: true });
  const appTeam = codesignTeam(run, app);
  if (appTeam !== expectedTeam) throw new Error('App and helper signing teams differ');
  for (const target of targets) {
    verifyTrusted(run, appPath(app, target.binary));
    const team = codesignTeam(run, appPath(app, target.binary));
    if (team !== expectedTeam) throw new Error('App and helper signing teams differ');
    run('codesign', ['--verify', '--strict',
      `-R=${DEVELOPER_ID_REQUIREMENT} and identifier "${target.identifier}"`, appPath(app, target.binary)]);
  }
  run('codesign', ['--verify', '--strict', `-R=${DEVELOPER_ID_REQUIREMENT} and identifier "${APP_IDENTIFIER}"`, app]);
  return appTeam;
}

function archiveApp(run, app, archive) {
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  try { chmodSync(archive, 0o600); } catch { /* ditto may be mocked during tests. */ }
}

function externalReceiptPath(app, archive) {
  return archive ? `${archive}.notarization.json` : join(dirname(app), `${basename(app, '.app')}.notarization.json`);
}

function containedBy(parent, path) {
  const fromParent = relative(parent, path);
  return fromParent === '' || (fromParent !== '..' && !fromParent.startsWith('../') && !isAbsolute(fromParent));
}

function absentPath(path) {
  try { lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing output: ${path}`);
}

function canonicalOutput(app, output) {
  const parent = dirname(output);
  rejectSymlinkedPath(parent);
  const canonical = join(realpathSync(parent), basename(output));
  if (containedBy(app, canonical)) throw new Error('Output must not be inside the app bundle');
  absentPath(canonical);
  return canonical;
}

function privateSibling(output) {
  const directory = mkdtempSync(join(dirname(output), '.harness-gateway-'));
  chmodSync(directory, 0o700);
  return directory;
}

function publishStaged(output, stageDirectory, staged) {
  try {
    absentPath(output);
    linkSync(staged, output);
  } catch {
    throw new Error('Output publication failed');
  } finally {
    rmSync(stageDirectory, { recursive: true, force: true });
  }
}

function publishJson(output, value) {
  const directory = privateSibling(output);
  const staged = join(directory, 'receipt.json');
  try {
    writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    publishStaged(output, directory, staged);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function publishArchive(run, app, output) {
  const directory = privateSibling(output);
  const staged = join(directory, 'archive.zip');
  try {
    archiveApp(run, app, staged);
    publishStaged(output, directory, staged);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function normalizeArchive(app, archive) {
  if (!archive) return null;
  const output = archive === true ? join(dirname(app), `${basename(app, '.app')}.zip`) : archive;
  if (!isAbsolute(output)) throw new Error('--archive must be an absolute path');
  return output;
}

function notarize(run, app, options) {
  const privateDirectory = mkdtempSync(join(tmpdir(), 'harness-gateway-notary-'));
  chmodSync(privateDirectory, 0o700);
  const upload = join(privateDirectory, 'upload.zip');
  let response = null;
  try {
    archiveApp(run, app, upload);
    const result = run('xcrun', ['notarytool', 'submit', upload, '--wait', '--output-format', 'json',
      '--keychain-profile', options.profile, ...(options.keychain ? ['--keychain', options.keychain] : [])]);
    try { response = JSON.parse(result.stdout); }
    catch { throw new Error('notarytool returned invalid JSON'); }
    if (response.status !== 'Accepted') throw new Error('Notarization was not accepted');
    run('xcrun', ['stapler', 'staple', app]);
    run('xcrun', ['stapler', 'validate', app]);
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    return { notarized: true, actualStatus: response.status, submissionId: response.id ?? null,
      submittedAt: new Date().toISOString() };
  } catch (error) {
    return { notarized: false, actualStatus: response?.status ?? 'Failed', submissionId: response?.id ?? null,
      error: error.message, submittedAt: new Date().toISOString() };
  } finally {
    rmSync(privateDirectory, { recursive: true, force: true });
  }
}

export function signMacosApp(options, { run = command, runGit = sourceGit } = {}) {
  const app = options.app;
  if (!app || !isAbsolute(app) || !app.endsWith('.app')) throw new Error('--app must be an absolute .app path');
  rejectSymlinkedPath(app);
  rejectSymlinks(app);
  const canonicalApp = realpathSync(app);
  const archive = normalizeArchive(app, options.archive);
  const archiveFile = archive ? canonicalOutput(canonicalApp, archive) : null;
  const receiptFile = options.notarize ? canonicalOutput(canonicalApp, externalReceiptPath(app, archiveFile)) : null;
  const backendRoot = appPath(app, BACKEND);
  const backend = verifiedBackend(backendRoot);
  const receiptPath = appPath(app, BUILD_RECEIPT);
  const receipt = readJson(receiptPath, 'app build receipt');
  preflightProductionSigning(app, receipt, { runGit });
  if (receipt.signedForDistribution || receipt.signingDerivative) {
    throw new Error('Refusing to sign an already signed derivative');
  }
  const releasePath = join(backendRoot, 'package/release.json');
  const release = readJson(releasePath, 'release receipt');
  const components = preflightComponents(app, backend, release);
  const targets = signingTargets(components.map(({ target }) => target));
  const originalManifestSha256 = sha256(backend.manifest);
  const changed = [];

  try {
    for (const component of components) {
      const { target, before } = component;
      run('codesign', signArguments(options.identity, options.keychain, appPath(app, target.binary),
        target.identifier, target.entitlements));
      const after = fileRecord(app, target.binary);
      changed.push({ before, after });
      let companionAfter;
      if (target.companion) {
        run('codesign', signArguments(options.identity, options.keychain, appPath(app, target.companion.binary),
          target.companion.identifier, target.companion.entitlements));
        companionAfter = fileRecord(app, target.companion.binary);
        changed.push({ before: component.companionBefore, after: companionAfter });
      }
      if (!target.receipt) continue;

      component.build.originalBinarySha256 = before.sha256;
      component.build.binarySha256 = after.sha256;
      if (companionAfter) {
        component.build.originalCodeModeHostSha256 = component.companionBefore.sha256;
        component.build.codeModeHostSha256 = companionAfter.sha256;
      }
      writeJson(appPath(app, component.buildRelative), component.build);
      const buildAfter = fileRecord(app, component.buildRelative);
      changed.push({ before: component.buildBefore, after: buildAfter });
      if (component.reused) {
        const changes = [{ before, after }];
        if (companionAfter) changes.push({ before: component.companionBefore, after: companionAfter });
        for (const change of [...changes, { before: component.buildBefore, after: buildAfter }]) {
          const record = matchingReusedFile(component.reused, change.before);
          record.sha256 = change.after.sha256;
          record.size = change.after.size;
        }
      }
    }

    const releaseBefore = fileRecord(app, `${BACKEND}/package/release.json`);
    writeJson(releasePath, release);
    const releaseAfter = fileRecord(app, `${BACKEND}/package/release.json`);
    changed.push({ before: releaseBefore, after: releaseAfter });

    const checksumsBefore = fileRecord(app, `${BACKEND}/checksums.txt`);
    const checksums = backend.files.map(path => `${digest(readFileSync(join(backendRoot, path)))}  ${path}`).join('\n') + '\n';
    writeFileSync(join(backendRoot, 'checksums.txt'), checksums);
    const checksumsAfter = fileRecord(app, `${BACKEND}/checksums.txt`);
    changed.push({ before: checksumsBefore, after: checksumsAfter });
    verifiedBackend(backendRoot);

    receipt.signingDerivative = {
      originalBackendManifestSha256: originalManifestSha256,
      files: changed.map(({ before, after }) => ({ before, after })),
    };
    receipt.signedForDistribution = false;
    writeJson(receiptPath, receipt);

    const helperTeams = new Set(targets.map(target => codesignTeam(run, appPath(app, target.binary))));
    if (helperTeams.size !== 1) throw new Error('App and helper signing teams differ');
    receipt.signingDerivative.teamIdentifier = helperTeams.values().next().value;
    receipt.signedForDistribution = true;
    writeJson(receiptPath, receipt);
    run('codesign', signArguments(options.identity, options.keychain, app, APP_IDENTIFIER));
    verifySeal(run, app, targets, receipt.signingDerivative.teamIdentifier);
  } catch (error) {
    // A failed final artifact must not claim distribution signing, even if its partial seal is valid.
    resetSignedReceipt(receiptPath);
    throw error;
  }

  const normalizedOptions = { ...options, archive: archiveFile };
  const notarization = options.notarize ? notarize(run, app, normalizedOptions) : null;
  if (notarization && !notarization.notarized) {
    publishJson(receiptFile, { ...notarization, published: false });
    throw new Error(notarization.error);
  }
  try {
    if (archiveFile) publishArchive(run, app, archiveFile);
    if (notarization) publishJson(receiptFile, { ...notarization, published: true });
  } catch (error) {
    if (notarization?.notarized) {
      try { publishJson(receiptFile, { ...notarization, published: false, error: error.message }); }
      catch { /* Never overwrite a raced output while reporting failed publication. */ }
    }
    throw error;
  }
  return { app: canonicalApp, archive: archiveFile, signedForDistribution: true, notarizationReceipt: receiptFile };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(usage);
    else process.stdout.write(`${JSON.stringify(signMacosApp(options))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
