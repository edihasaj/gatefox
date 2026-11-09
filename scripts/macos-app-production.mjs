import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { digest, verifiedBackend } from './macos-app-backend.mjs';
import { backendName } from './release-names.mjs';

const fail = reason => new Error(`Production app build refused: ${reason}`);
const safePath = value => {
  const path = value.endsWith('/') ? value.slice(0, -1) : value;
  if (!path || path.startsWith('/') || /[\\\0-\x1f\x7f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) throw fail('unsafe archive entry');
  return path;
};
const text = bytes => bytes.toString('utf8').split('\0', 1)[0];
const octal = bytes => {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw fail('unsupported tar number');
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw fail('oversized tar number');
  return result;
};

export function productionOptions(values) {
  if (!values.production) return null;
  if (values.backend || !values['backend-archive'] || !values['backend-sha256']) {
    throw fail('--production requires --backend-archive and --backend-sha256, without --backend');
  }
  if (!isAbsolute(values['backend-archive'])) throw fail('--backend-archive must be absolute');
  if (!/^[a-f0-9]{64}$/.test(values['backend-sha256'])) throw fail('--backend-sha256 must be lowercase SHA-256');
  return { archive: values['backend-archive'], sha256: values['backend-sha256'] };
}

export function requireProductionSource({ runGit, root }) {
  if (runGit(['branch', '--show-current'], root).trim() !== 'production') throw fail('source branch must be production');
  if (runGit(['status', '--porcelain'], root).trim()) throw fail('source tree must be clean');
  return runGit(['rev-parse', 'HEAD'], root).trim();
}

function tarEntries(bytes) {
  const entries = new Map(); let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (bytes.length - offset < 1024 || !bytes.subarray(offset).every(byte => byte === 0)) throw fail('malformed tar ending');
      return entries;
    }
    const stored = octal(header.subarray(148, 156));
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (stored !== actual) throw fail('tar checksum mismatch');
    const prefix = text(header.subarray(345, 500));
    const name = safePath(prefix ? `${prefix}/${text(header.subarray(0, 100))}` : text(header.subarray(0, 100)));
    const mode = octal(header.subarray(100, 108));
    if ((mode & ~0o777) !== 0) throw fail('archive entry has unsafe permissions');
    const size = octal(header.subarray(124, 136));
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > bytes.length) throw fail('truncated tar entry');
    const type = header[156] || 48;
    if (![48, 53].includes(type) || (type === 53 && size !== 0)) throw fail('archive contains a link or special file');
    if (entries.has(name)) throw fail('duplicate archive entry');
    entries.set(name, { directory: type === 53, mode, data: bytes.subarray(offset + 512, offset + 512 + size) });
    offset = next;
  }
  throw fail('tar ending is missing');
}

function json(entries, name) {
  const entry = entries.get(name);
  if (!entry || entry.directory || entry.data.length > 1024 * 1024) throw fail('release metadata is missing');
  try { return JSON.parse(entry.data.toString('utf8')); }
  catch { throw fail('release metadata is invalid'); }
}

export function extractProductionBackend({ archive, sha256, version, source, destination }) {
  const info = lstatSync(archive);
  if (!info.isFile() || info.isSymbolicLink()) throw fail('backend archive must be a regular file');
  const compressed = readFileSync(archive);
  if (digest(compressed) !== sha256) throw fail('backend archive SHA-256 mismatch');
  let entries;
  try { entries = tarEntries(gunzipSync(compressed, { maxOutputLength: 768 * 1024 * 1024 })); }
  catch (error) { if (error.message.startsWith('Production app build refused:')) throw error; throw fail('backend archive is not a safe gzip tar'); }
  const root = backendName(version);
  if (!entries.get(root)?.directory || [...entries].some(([name]) => name !== root && !name.startsWith(`${root}/`))) {
    throw fail('backend archive has an unexpected release root');
  }
  const release = json(entries, `${root}/package/release.json`);
  const pkg = json(entries, `${root}/package/package.json`);
  if (release.version !== version || pkg.version !== version || release.source !== source) {
    throw fail('backend version or source does not match this app');
  }
  mkdirSync(destination, { mode: 0o700 });
  for (const [name, entry] of entries) {
    if (name === root) continue;
    const relative = name.slice(root.length + 1);
    const path = join(destination, relative);
    if (entry.directory) mkdirSync(path, { recursive: true, mode: 0o700 });
    else {
      mkdirSync(posix.dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, entry.data, { flag: 'wx', mode: entry.mode & 0o755 });
    }
  }
  const backend = verifiedBackend(destination);
  if (backend.version !== version || JSON.parse(readFileSync(join(destination, 'package/release.json'), 'utf8')).source !== source) {
    throw fail('verified backend does not match app source');
  }
  return backend;
}

export function stageProductionBackend(options) {
  const stage = mkdtempSync(join(tmpdir(), 'gatefox-production-backend-'));
  chmodSync(stage, 0o700);
  try { return { stage, backend: extractProductionBackend({ ...options, destination: join(stage, 'backend') }) }; }
  catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}

export const removeProductionStage = stage => rmSync(stage, { recursive: true, force: true });
