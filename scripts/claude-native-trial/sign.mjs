// Ad-hoc re-signing of the DISPOSABLE native-trial copy of Claude.app only. The official app is verified before and
// after and is never written. The bundle identifier is preserved. An ad-hoc signature cannot carry the three
// Team-ID-bound restricted entitlements (amfid rejects them with -424), so only those are dropped from the main
// executable; every other entitlement is kept exactly. Nested code keeps all of its original metadata.
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const OFFICIAL_APP = '/Applications/Claude.app';
export const REMOVED_TRIAL_ENTITLEMENTS = Object.freeze([
  'com.apple.application-identifier',
  'com.apple.developer.team-identifier',
  'keychain-access-groups',
]);
export const TRIAL_SIGNING_IDENTITY = 'ad-hoc-local-test-only';
export const DEVELOPER_ID_SIGNING_IDENTITY = 'developer-id-local-test-only';
export const SIGNING_KEYCHAIN = 'Library/Keychains/apple-codesign.keychain-db';
export const ENTITLEMENTS_FILE = 'trial-sign-entitlements.plist';

const TASK_ROOT = /^\/private\/tmp\/claude-native-picker\.[A-Za-z0-9]+$/;
const FINGERPRINT = /^[0-9A-Fa-f]{40}$/;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_TREE_ENTRIES = 200_000;
const MAX_TREE_DEPTH = 64;
// First four bytes of thin 32/64-bit Mach-O (both byte orders) and fat/fat64 archives.
const MACHO_MAGICS = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca']);

export class SignError extends Error {
  constructor(message) {
    super(`native trial signing: ${message}`);
    this.name = 'SignError';
    this.code = 'ERR_NATIVE_TRIAL_SIGN';
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** A copy of `entitlements` without the three Team-ID-bound keys. Every other entry is kept exactly; the input is untouched. */
export function sanitizedTrialEntitlements(entitlements) {
  if (!isPlainObject(entitlements)) throw new SignError('entitlements must be a plain object');
  return Object.fromEntries(Object.entries(structuredClone(entitlements)).filter(([key]) => !REMOVED_TRIAL_ENTITLEMENTS.includes(key)));
}

/** Default command runner. Tests may inject another with the same (file, args, { input, timeout }) -> { stdout, stderr } shape. */
function defaultExec(file, args, { input, timeout = 60000 } = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', input, timeout, maxBuffer: MAX_OUTPUT, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split('\n')[0]?.slice(0, 300) ?? '';
    throw new SignError(`${basename(file)} ${args[0] ?? ''} failed (${result.error ? result.error.code ?? 'error' : `exit ${result.status}`})${detail ? `: ${detail}` : ''}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function assertPrivateOwned(path, what, { directory }) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new SignError(`${what} is not a real ${directory ? 'directory' : 'file'}`);
  if (info.uid !== process.getuid?.()) throw new SignError(`${what} is not owned by the current user`);
  return info;
}

/** Validates and returns the canonical copy path and its task root, or throws. */
async function validateCopy(copyApp) {
  if (typeof copyApp !== 'string' || !copyApp.startsWith('/')) throw new SignError('copy path must be absolute');
  let canonical;
  try {
    canonical = await realpath(copyApp);
  } catch {
    throw new SignError('copy app does not exist');
  }
  if (canonical !== copyApp) throw new SignError('copy path must already be canonical (no symlinks or relative segments)');
  const task = dirname(canonical);
  if (!TASK_ROOT.test(task) || !canonical.endsWith('.app') || basename(canonical).length <= '.app'.length) {
    throw new SignError('copy must be a .app directly inside /private/tmp/claude-native-picker.ID');
  }
  if (await realpath(OFFICIAL_APP).catch(() => undefined) === canonical) throw new SignError('refusing to sign the official app');
  const taskInfo = await assertPrivateOwned(task, 'task directory', { directory: true });
  if ((taskInfo.mode & 0o077) !== 0) throw new SignError('task directory must be private (mode 0700)');
  await assertPrivateOwned(canonical, 'copy app', { directory: true });
  return { copy: canonical, task };
}

const parseJson = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new SignError(`${what} is not valid JSON`);
  }
};

const inside = (root, path) => path === root || path.startsWith(root + sep);

/**
 * codesign --deep rewrites nested signables, so before it runs every entry under the copy is checked without following
 * links: all entries are owned by the current user, regular files are not hardlinked (a link count above one would let
 * signing modify bytes shared with another path, such as the official app), only files, directories and symlinks exist,
 * and every symlink resolves to a real target inside the copy. In-tree links (framework Versions/Current) are allowed,
 * whether relative or absolute; links that escape the copy, dangle or loop are refused.
 */
export async function assertSignableTree(copy) {
  return (await scanSignableTree(copy)).entries;
}

/** True when the first four bytes are a Mach-O or fat-archive magic. Only the header magic is looked at, never the extension. */
export function isMachOMagic(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return false;
  return MACHO_MAGICS.has(Buffer.from(bytes.buffer, bytes.byteOffset, 4).toString('hex'));
}

async function hasMachOMagic(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && isMachOMagic(head);
  } finally {
    await handle.close();
  }
}

/** The preflight walk. Returns the entry count and every regular Mach-O file (absolute, sorted), found without following links. */
async function scanSignableTree(copy) {
  const uid = process.getuid?.();
  let entries = 0;
  const machO = [];
  const walk = async (dir, depth) => {
    if (depth > MAX_TREE_DEPTH) throw new SignError('copy tree nests too deeply');
    for (const name of await readdir(dir)) {
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) throw new SignError('copy tree has too many entries');
      const path = join(dir, name);
      const info = await lstat(path);
      const shown = path.slice(copy.length + 1);
      if (info.uid !== uid) throw new SignError(`${JSON.stringify(shown)} is not owned by the current user`);
      if (info.isSymbolicLink()) {
        const target = resolve(dir, await readlink(path));
        let real;
        try {
          real = await realpath(path);
        } catch {
          throw new SignError(`symlink ${JSON.stringify(shown)} does not resolve to an existing target`);
        }
        if (!inside(copy, real) || (isAbsolute(target) && !inside(copy, target))) {
          throw new SignError(`symlink ${JSON.stringify(shown)} points outside the copy`);
        }
      } else if (info.isDirectory()) {
        await walk(path, depth + 1);
      } else if (info.isFile()) {
        if (info.nlink !== 1) throw new SignError(`${JSON.stringify(shown)} is hardlinked (link count ${info.nlink})`);
        if (info.size >= 4 && await hasMachOMagic(path)) machO.push(path);
      } else {
        throw new SignError(`${JSON.stringify(shown)} is not a regular file, directory or symlink`);
      }
    }
  };
  await walk(copy, 1);
  machO.sort();
  return { entries, machO };
}

/** Every regular Mach-O file under a confined copy, detected by header magic (any extension), after the full preflight. */
export async function listMachOFiles(copy) {
  if (typeof copy !== 'string' || !isAbsolute(copy)) throw new SignError('copy path must be absolute');
  return (await scanSignableTree(copy)).machO;
}

function entitlementsOf(exec, app) {
  const { stdout } = exec('/usr/bin/codesign', ['-d', '--entitlements', ':-', app]);
  if (!stdout.trim()) return {};
  const json = exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: stdout }).stdout;
  const value = parseJson(json, 'entitlements');
  if (!isPlainObject(value)) throw new SignError('entitlements are not a dictionary');
  return value;
}

function signatureOf(exec, app) {
  const { stderr } = exec('/usr/bin/codesign', ['-dv', '--verbose=2', app]);
  const identifier = /^Identifier=(.+)$/m.exec(stderr)?.[1]?.trim();
  if (!identifier) throw new SignError('could not read the code signing identifier');
  return { identifier, runtime: /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/m.test(stderr) };
}

const verify = (exec, app) => exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);

/**
 * Validates the signing identity and keychain before anything runs. The identity is `-` (ad hoc) or the exact 40-digit hex
 * fingerprint of a local certificate; a name or any other string is refused. A keychain may only accompany a certificate
 * and must be the one fixed file `<home>/Library/Keychains/apple-codesign.keychain-db`: canonical, a regular file (not a
 * link), owned by the current user and private. `homeDirectory` is a test seam that defaults to the real home directory.
 */
async function resolveSigning({ identity = '-', keychain, homeDirectory = homedir() }) {
  if (identity === '-') {
    if (keychain !== undefined && keychain !== null) throw new SignError('an ad-hoc signature does not use a keychain');
    return { identity: '-', keychain: undefined, fingerprint: null, label: TRIAL_SIGNING_IDENTITY };
  }
  if (typeof identity !== 'string' || !FINGERPRINT.test(identity)) throw new SignError('signing identity must be "-" or an exact 40-digit hex certificate fingerprint');
  const fingerprint = identity.toUpperCase();
  const resolved = { identity: fingerprint, keychain: undefined, fingerprint, label: DEVELOPER_ID_SIGNING_IDENTITY };
  if (keychain === undefined || keychain === null) return resolved;
  if (typeof homeDirectory !== 'string' || !isAbsolute(homeDirectory)) throw new SignError('home directory must be absolute');
  const fixed = join(homeDirectory, SIGNING_KEYCHAIN);
  if (keychain !== fixed) throw new SignError('only the fixed apple-codesign keychain in the home directory is allowed');
  let info;
  try {
    info = await lstat(fixed);
    if (await realpath(fixed) !== fixed) throw new SignError('signing keychain path must be canonical');
  } catch (error) {
    if (error instanceof SignError) throw error;
    throw new SignError('signing keychain does not exist');
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new SignError('signing keychain is not a regular file');
  if (info.uid !== process.getuid?.()) throw new SignError('signing keychain is not owned by the current user');
  if ((info.mode & 0o077) !== 0) throw new SignError('signing keychain must be private (mode 0600)');
  return { ...resolved, keychain: fixed };
}

/**
 * Re-sign a disposable trial copy, ad hoc by default or with a local Developer ID certificate (`identity` fingerprint,
 * optional fixed `keychain`) so library validation can stay on. Nested code is re-signed with its metadata preserved; the
 * main executable is then signed with the sanitized entitlements file at `<task>/trial-sign-entitlements.plist` (mode
 * 0600). The official app is verified before and after. `options.exec` is a test seam for the command runner.
 */
export async function signNativeTrial(copyApp, { exec = defaultExec, identity, keychain, homeDirectory } = {}) {
  const signing = await resolveSigning({ identity, keychain, homeDirectory });
  const using = ['--sign', signing.identity, ...(signing.keychain ? ['--keychain', signing.keychain] : [])];
  const { copy, task } = await validateCopy(copyApp);
  const { machO } = await scanSignableTree(copy);
  verify(exec, OFFICIAL_APP);

  const before = signatureOf(exec, copy);
  const original = entitlementsOf(exec, copy);
  const sanitized = sanitizedTrialEntitlements(original);
  const removed = REMOVED_TRIAL_ENTITLEMENTS.filter(key => Object.hasOwn(original, key));
  const xml = exec('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(sanitized) }).stdout;

  const file = join(task, ENTITLEMENTS_FILE);
  try {
    await writeFile(file, xml, { flag: 'wx', mode: 0o600 }); // exclusive: a fresh task only, nothing is deleted or followed
  } catch (error) {
    if (error?.code === 'EEXIST') throw new SignError('entitlements artifact already exists; use a fresh task directory');
    throw error;
  }

  const preserve = '--preserve-metadata=identifier,entitlements,flags,runtime';
  // `codesign --deep` does not reach every Mach-O (for example libraries under Frameworks/*/Versions/A/Libraries), and one
  // left on the original Team ID aborts dyld under library validation. Sign every Mach-O leaf first with the same identity
  // and its own metadata preserved (the main executable is a leaf and is re-signed with sanitized entitlements below).
  for (const leaf of machO) exec('/usr/bin/codesign', ['--force', ...using, preserve, leaf], { timeout: 120000 });
  exec('/usr/bin/codesign', ['--force', '--deep', ...using, preserve, copy], { timeout: 300000 });
  exec('/usr/bin/codesign', ['--force', ...using, '--preserve-metadata=identifier,flags,runtime', '--entitlements', file, copy], { timeout: 120000 });
  verify(exec, copy);

  const after = signatureOf(exec, copy);
  if (after.identifier !== before.identifier) throw new SignError('the bundle identifier changed during signing');
  if (before.runtime && !after.runtime) throw new SignError('the hardened runtime flag was lost during signing');
  const finalEntitlements = entitlementsOf(exec, copy);
  if (!isDeepStrictEqual(finalEntitlements, sanitized)) throw new SignError('the signed entitlements differ from the sanitized set');
  verify(exec, OFFICIAL_APP);

  return {
    experimental: true,
    copyApp: copy,
    signingIdentity: signing.label,
    signingFingerprint: signing.fingerprint,
    signingKeychain: signing.keychain ?? null,
    identifier: after.identifier,
    hardenedRuntimePreserved: after.runtime,
    removedEntitlementKeys: removed,
    preservedEntitlementKeys: Object.keys(sanitized).sort(),
    entitlementsFile: file,
    machOFilesSigned: machO.length,
    officialSignatureVerifiedBefore: true,
    officialSignatureVerifiedAfter: true,
    officialAppModified: false,
    bundleIdentifierChanged: false,
  };
}
