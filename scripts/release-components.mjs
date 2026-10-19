import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { nativeSourceDigest } from './native-source.mjs';
import { sdkArchiveSha256 as relaySdkArchiveSha256, sdkCodexVersion as relaySdkCodexVersion, sdkRevision as relaySdkRevision } from './native-relay-sdk.mjs';
import { gatewaySdkArchiveSha256, gatewaySdkCapability, gatewaySdkCodexVersion,
  gatewaySdkLockRepairDigest, gatewaySdkLockSha256, gatewaySdkPatchDigest,
  gatewaySdkRevision, gatewaySdkSourceDigest, gatewaySdkTestRunnerDigest } from './gateway-sdk-source.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = reason => new Error(`Component reuse refused: ${reason}`);
const filesFor = binary => ['CODEX-LICENSE', 'CODEX-NOTICE', 'NOTICE', 'build.json', 'dependencies.json', binary].sort();
const text = bytes => bytes.toString('utf8').split('\0', 1)[0];
function safePath(name) {
  const path = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!path || path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) throw invalid('unsafe archive path');
  return path;
}
function octal(bytes) {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw invalid('unsupported tar number');
  const number = parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw invalid('oversized tar number');
  return number;
}
function checkPax(bytes) {
  const keys = new Set(); let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset); const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (space < offset || !/^[1-9]\d*$/.test(lengthText)) throw invalid('malformed PAX metadata');
    const length = Number(lengthText); const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || end <= space + 1 || bytes[end - 1] !== 10) throw invalid('malformed PAX length');
    const record = bytes.subarray(space + 1, end - 1); const equal = record.indexOf(61);
    const key = record.subarray(0, equal).toString('ascii');
    if (equal < 1 || keys.has(key) || !['mtime', 'LIBARCHIVE.xattr.com.apple.provenance',
      'SCHILY.xattr.com.apple.provenance'].includes(key)) throw invalid('unsupported PAX metadata');
    keys.add(key); offset = end;
  }
}
function tarEntries(bytes) {
  const entries = new Map(); let offset = 0; let pendingPax = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (pendingPax || bytes.length - offset < 1024 || !bytes.subarray(offset).every(byte => byte === 0)) throw invalid('malformed tar ending');
      return entries;
    }
    const stored = octal(header.subarray(148, 156));
    const sum = header.reduce((value, byte, index) => value + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (stored !== sum) throw invalid('tar header checksum mismatch');
    const prefix = text(header.subarray(345, 500)); const base = text(header.subarray(0, 100));
    const name = safePath(prefix ? `${prefix}/${base}` : base); const size = octal(header.subarray(124, 136));
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > bytes.length) throw invalid('truncated tar entry');
    const data = bytes.subarray(offset + 512, offset + 512 + size); const type = header[156] || 48;
    if (type === 120) {
      if (pendingPax || size > 16384) throw invalid('oversized or stacked PAX metadata');
      checkPax(data); pendingPax = true;
    } else {
      if (![48, 53].includes(type) || (type === 53 && size !== 0)) throw invalid('archive contains a link or unsupported entry');
      if (entries.has(name)) throw invalid('duplicate archive entry');
      entries.set(name, { directory: type === 53, data }); pendingPax = false;
    }
    offset = next;
  }
  throw invalid('tar ending is missing');
}
function json(entries, name) {
  const entry = entries.get(name);
  if (!entry || entry.directory || entry.data.length > 1024 * 1024) throw invalid('missing release metadata');
  try { return JSON.parse(entry.data.toString('utf8')); } catch { throw invalid('invalid release metadata'); }
}

/** The components a release can carry, with the subdirectory and binary each one owns. */
const componentKinds = {
  native: { subdirectory: 'native', binary: 'gateway-native-relay' },
  gatewaySdk: { subdirectory: 'gateway-sdk', binary: 'gateway-codex' },
};
const componentOrder = ['native', 'gatewaySdk'];

/** Decide which components come from a previous published bundle and which are built here.
 * `freshNative` keeps reusing the gateway SDK while the relay comes from the local build.
 * `reuseNativeFrom` takes the relay from its own separately authenticated original archive
 * instead, and always arrives with the SDK reuse pair so the gateway SDK also comes from an
 * original archive rather than a fresh build.
 */
export function releaseComponentPlan({ withNative, withGatewaySdk, reuseFrom, componentsSha256, reuseNativeFrom, nativeSha256, freshNative }) {
  if (Boolean(reuseFrom) !== Boolean(componentsSha256)) throw new Error('Component reuse requires both --reuse-components-from and --components-sha256');
  if (Boolean(reuseNativeFrom) !== Boolean(nativeSha256)) throw new Error('Native component reuse requires both --reuse-native-from and --native-sha256');
  if (reuseNativeFrom && freshNative) throw new Error('--reuse-native-from and --fresh-native cannot be combined; pick one origin for the relay');
  if (reuseNativeFrom && !(withNative && withGatewaySdk)) throw new Error('--reuse-native-from requires --with-native and --with-gateway-sdk');
  if (reuseNativeFrom && !(reuseFrom && componentsSha256)) {
    throw new Error('--reuse-native-from requires --reuse-components-from and --components-sha256; the relay override never pairs with a freshly built gateway SDK');
  }
  if (freshNative && !(reuseFrom && withNative && withGatewaySdk)) {
    throw new Error('--fresh-native requires --with-native, --with-gateway-sdk and component reuse');
  }
  return {
    // With a separate relay archive, the bundle named by --reuse-components-from only supplies the gateway SDK.
    reuse: reuseFrom ? { native: Boolean(withNative && !freshNative && !reuseNativeFrom), gatewaySdk: Boolean(withGatewaySdk) } : undefined,
    reuseNative: reuseNativeFrom ? { from: reuseNativeFrom, sha256: nativeSha256 } : undefined,
    freshNative: Boolean(withNative && (!reuseFrom || freshNative) && !reuseNativeFrom),
    freshGatewaySdk: Boolean(withGatewaySdk && !reuseFrom),
  };
}

/** Verify one entire published archive before any of its components are written. */
function authenticateArchive(archivePath, expectedSha256, flag) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw invalid(`${flag} must be an exact SHA-256 digest`);
  const archive = readFileSync(archivePath);
  if (digest(archive) !== expectedSha256) throw invalid('archive SHA-256 mismatch');
  const entries = tarEntries(gunzipSync(archive, { maxOutputLength: 768 * 1024 * 1024 }));
  // Releases before the rename use the subscription-gateway archive prefix.
  const roots = [...entries.keys()].filter(name => /^(harness|subscription)-gateway-\d+\.\d+\.\d+-macos-arm64$/.test(name));
  if (roots.length !== 1 || !entries.get(roots[0]).directory) throw invalid('unexpected release root');
  const root = roots[0]; const release = json(entries, `${root}/package/release.json`);
  const pkg = json(entries, `${root}/package/package.json`); const version = root.match(/-(\d+\.\d+\.\d+)-macos/)[1];
  if (release.version !== version || pkg.version !== version || !/^[a-f0-9]{40}$/.test(release.source || '')) throw invalid('release version or commit mismatch');
  const payload = new Map();
  for (const [name, entry] of entries) {
    if (posix.basename(name).startsWith('._')) {
      const companion = posix.join(posix.dirname(name), posix.basename(name).slice(2));
      if (entry.directory || entry.data.length < 26 || entry.data.length > 16384 ||
          entry.data.subarray(0, 8).toString('hex') !== '0005160700020000' || !entries.has(companion)) throw invalid('unexpected AppleDouble metadata');
      continue;
    }
    if (name !== root && !name.startsWith(`${root}/`)) throw invalid('entry is outside the release root');
    if (name !== root && !entries.get(posix.dirname(name))?.directory) throw invalid('missing or conflicting archive directory');
    if (!entry.directory) payload.set(name.slice(root.length + 1), entry.data);
  }
  const manifest = payload.get('checksums.txt');
  if (!manifest || manifest.length > 1024 * 1024) throw invalid('missing checksum manifest');
  const listed = new Set(); const lines = manifest.toString('utf8').trimEnd().split('\n');
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw invalid('malformed checksum manifest');
    const name = safePath(match[2]); const bytes = payload.get(name);
    if (listed.has(name) || name === 'checksums.txt' || !bytes || digest(bytes) !== match[1]) throw invalid('manifest entry is duplicate, missing, or changed');
    listed.add(name);
  }
  if (payload.size !== listed.size + 1) throw invalid('archive contains unmanifested payload files');
  return { entries, root, version, release, payload };
}

/** Verify one selected component of an authenticated bundle against its own pins. */
function verifyComponent(bundle, key) {
  const { subdirectory, binary } = componentKinds[key]; const prefix = `package/${subdirectory}/`;
  if (bundle.release.reusedComponents?.components?.[key]) throw invalid(`${key} component was itself reused in that bundle; reuse the archive that built it`);
  const names = [...bundle.payload.keys()].filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)).sort();
  if (JSON.stringify(names) !== JSON.stringify(filesFor(binary))) throw invalid(`unexpected ${key} component files`);
  const metadata = json(bundle.entries, `${bundle.root}/${prefix}build.json`);
  // The relay links its own pinned SDK (the app's newest verified engine); the gateway SDK keeps the gateway pin.
  const pins = key === 'native' ? { codexVersion: relaySdkCodexVersion, revision: relaySdkRevision, archiveSha256: relaySdkArchiveSha256, sourceSha256: nativeSourceDigest() }
    : { codexVersion: gatewaySdkCodexVersion, revision: gatewaySdkRevision, archiveSha256: gatewaySdkArchiveSha256, sourceSha256: gatewaySdkSourceDigest() };
  if (metadata.version !== bundle.version || metadata.profile !== 'release' || metadata.codexVersion !== pins.codexVersion ||
      metadata.revision !== pins.revision || metadata.archiveSha256 !== pins.archiveSha256 ||
      metadata.sourceSha256 !== pins.sourceSha256) throw invalid(`${key} source or build receipt changed`);
  if (key === 'gatewaySdk' && (metadata.schemaVersion !== 1 || metadata.platform !== 'darwin' || metadata.arch !== 'arm64' ||
      metadata.patchSha256 !== gatewaySdkPatchDigest() || metadata.lockfileRepairSha256 !== gatewaySdkLockRepairDigest() ||
      metadata.lockfileSha256 !== gatewaySdkLockSha256 || metadata.testRunnerSha256 !== gatewaySdkTestRunnerDigest() ||
      !/^[a-f0-9]{64}$/.test(metadata.patchedSdkSha256 || '') ||
      metadata.capabilities?.length !== 1 || metadata.capabilities[0] !== gatewaySdkCapability ||
      metadata.binarySha256 !== digest(bundle.payload.get(prefix + binary)))) throw invalid('gateway SDK pins or capability changed');
  const files = names.map(name => { const bytes = bundle.payload.get(prefix + name); return { name, size: bytes.length, sha256: digest(bytes) }; });
  return { buildVersion: metadata.version, sourceSha256: metadata.sourceSha256, origin: { bundleVersion: bundle.version, bundleSha256: bundle.sha256 }, files };
}

/** Verify one published archive and reuse the selected components from it. */
export function verifyReleaseComponents(archivePath, expectedSha256, selected) {
  const sources = {};
  for (const key of componentOrder) if (selected?.[key]) sources[key] = { archivePath, expectedSha256, flag: '--components-sha256' };
  return verifyReleaseComponentSources(sources);
}

/** Authenticate each original archive for exactly the components it supplies, then combine those paths.
 * `sources` maps a component key to `{ archivePath, expectedSha256, flag }`; two archives never overlap.
 */
export function verifyReleaseComponentSources(sources) {
  const keys = componentOrder.filter(key => sources?.[key]);
  if (Object.keys(sources || {}).some(key => !keys.includes(key) && sources[key])) throw invalid('unknown component selection');
  if (!keys.length) throw invalid('select --with-native or --with-gateway-sdk');
  const bundles = new Map();
  for (const key of keys) {
    const { archivePath, expectedSha256, flag } = sources[key];
    const existing = bundles.get(archivePath);
    if (existing) {
      if (existing.sha256 !== expectedSha256) throw invalid('one archive was named with two digests');
      existing.keys.push(key);
    } else bundles.set(archivePath, { archivePath, sha256: expectedSha256, keys: [key], info: undefined, flag });
  }
  for (const bundle of bundles.values()) {
    bundle.info = authenticateArchive(bundle.archivePath, bundle.sha256, bundle.flag);
    bundle.info.sha256 = bundle.sha256;
  }
  const components = {}; const payload = new Map();
  for (const bundle of bundles.values()) {
    for (const key of bundle.keys) {
      const component = verifyComponent(bundle.info, key);
      for (const file of component.files) {
        const path = `package/${componentKinds[key].subdirectory}/${file.name}`;
        if (payload.has(path)) throw invalid('component paths overlap between archives');
        payload.set(path, bundle.info.payload.get(path));
      }
      components[key] = component;
    }
  }
  // Parent provenance stays the SDK bundle's for compatibility; each component also names its own origin.
  const origin = (components.gatewaySdk || components.native).origin;
  return { provenance: { bundleVersion: origin.bundleVersion, bundleSha256: origin.bundleSha256, components }, payload };
}

export function copyReleaseComponents(verified, packageDirectory) {
  const parent = lstatSync(packageDirectory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) ||
      (process.getuid && parent.uid !== process.getuid())) throw invalid('component stage is not a protected owned directory');
  for (const [key, component] of Object.entries(verified.provenance.components)) {
    const subdirectory = key === 'native' ? 'native' : 'gateway-sdk'; const directory = join(packageDirectory, subdirectory);
    mkdirSync(directory, { mode: 0o700 });
    for (const file of component.files) {
      const bytes = verified.payload.get(`package/${subdirectory}/${file.name}`);
      if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw invalid('verified component bytes changed');
      writeFileSync(join(directory, file.name), bytes, { flag: 'wx', mode: file.name.startsWith('gateway-') ? 0o755 : 0o644 });
    }
  }
}
