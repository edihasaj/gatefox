import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { nativeSourceDigest } from './native-source.mjs';
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

/** Verify the entire published archive before writing any selected component. */
export function verifyReleaseComponents(archivePath, expectedSha256, selected) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw invalid('--components-sha256 must be an exact SHA-256 digest');
  if (!selected.native && !selected.gatewaySdk) throw invalid('select --with-native or --with-gateway-sdk');
  const archive = readFileSync(archivePath);
  if (digest(archive) !== expectedSha256) throw invalid('archive SHA-256 mismatch');
  const entries = tarEntries(gunzipSync(archive, { maxOutputLength: 768 * 1024 * 1024 }));
  const roots = [...entries.keys()].filter(name => /^subscription-gateway-\d+\.\d+\.\d+-macos-arm64$/.test(name));
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
  const components = {};
  for (const [key, binary] of [['native', 'gateway-native-relay'], ['gatewaySdk', 'gateway-codex']]) {
    if (!selected[key]) continue;
    const subdirectory = key === 'native' ? 'native' : 'gateway-sdk'; const prefix = `package/${subdirectory}/`;
    const names = [...payload.keys()].filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)).sort();
    if (JSON.stringify(names) !== JSON.stringify(filesFor(binary))) throw invalid(`unexpected ${key} component files`);
    const metadata = json(entries, `${root}/${prefix}build.json`);
    if (metadata.version !== version || metadata.profile !== 'release' || metadata.codexVersion !== gatewaySdkCodexVersion ||
        metadata.revision !== gatewaySdkRevision || metadata.archiveSha256 !== gatewaySdkArchiveSha256 ||
        metadata.sourceSha256 !== (key === 'native' ? nativeSourceDigest() : gatewaySdkSourceDigest())) throw invalid(`${key} source or build receipt changed`);
    if (key === 'gatewaySdk' && (metadata.schemaVersion !== 1 || metadata.platform !== 'darwin' || metadata.arch !== 'arm64' ||
        metadata.patchSha256 !== gatewaySdkPatchDigest() || metadata.lockfileRepairSha256 !== gatewaySdkLockRepairDigest() ||
        metadata.lockfileSha256 !== gatewaySdkLockSha256 || metadata.testRunnerSha256 !== gatewaySdkTestRunnerDigest() ||
        !/^[a-f0-9]{64}$/.test(metadata.patchedSdkSha256 || '') ||
        metadata.capabilities?.length !== 1 || metadata.capabilities[0] !== gatewaySdkCapability ||
        metadata.binarySha256 !== digest(payload.get(prefix + binary)))) throw invalid('gateway SDK pins or capability changed');
    const files = names.map(name => { const bytes = payload.get(prefix + name); return { name, size: bytes.length, sha256: digest(bytes) }; });
    components[key] = { buildVersion: metadata.version, sourceSha256: metadata.sourceSha256, files };
  }
  return { provenance: { bundleVersion: version, bundleSha256: expectedSha256, components }, payload };
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
