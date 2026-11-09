import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Copy only the release payload, never installation state or local configuration.
export function verifiedBackend(directory) {
  const root = realpathSync(directory);
  const manifest = readFileSync(join(root, 'checksums.txt'), 'utf8');
  const entries = new Map();
  for (const line of manifest.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error('Invalid backend checksum manifest');
    const [, hash, path] = match;
    if (path.split('/').some(part => !part || part === '.' || part === '..') ||
        !/^(install|package\/.+|runtime\/.+)$/.test(path) || entries.has(path)) {
      throw new Error('Unsafe or duplicate backend manifest path');
    }
    entries.set(path, hash);
  }
  for (const required of ['install', 'package/package.json', 'package/LICENSE', 'package/dist/cli.js',
    'package/release.json', 'runtime/bin/node', 'runtime/LICENSE']) {
    if (!entries.has(required)) throw new Error(`Backend manifest is missing ${required}`);
  }
  const walk = (relative) => {
    const path = join(root, relative);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('Backend payload must not contain symbolic links');
    if (info.isDirectory()) {
      for (const name of readdirSync(path)) walk(`${relative}/${name}`);
    } else if (!info.isFile() || !entries.has(relative)) {
      throw new Error('Backend contains an unlisted file');
    }
  };
  walk('install'); walk('package'); walk('runtime');
  for (const [path, hash] of entries) {
    // The walk above also checks parents, preventing traversal through a symlink.
    if (!lstatSync(resolve(root, path)).isFile() ||
        digest(readFileSync(join(root, path))) !== hash) throw new Error('Backend checksum mismatch');
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package/package.json'), 'utf8'));
  const release = JSON.parse(readFileSync(join(root, 'package/release.json'), 'utf8'));
  if (!['@edihasaj/gatefox', '@edihasaj/harness-gateway', '@edihasaj/subscription-gateway'].includes(pkg.name) ||
      !/^\d+\.\d+\.[0-9]$/.test(pkg.version) || release.version !== pkg.version ||
      !/^[a-f0-9]{40}$/.test(release.source ?? '') || !/^\d+\.\d+\.\d+$/.test(release.node ?? '')) {
    throw new Error('Not a supported GateFox release');
  }
  for (const component of ['native', 'gateway-sdk']) {
    if ([...entries.keys()].some(path => path.startsWith(`package/${component}/`))) {
      for (const name of ['CODEX-LICENSE', 'CODEX-NOTICE', 'NOTICE', 'build.json', 'dependencies.json',
        component === 'native' ? 'gateway-native-relay' : 'gateway-codex']) {
        if (!entries.has(`package/${component}/${name}`)) throw new Error('Incomplete backend component or licenses');
      }
      // The gateway SDK's Code Mode companion is optional, but its receipt and its file always agree here.
      if (component === 'gateway-sdk') {
        let receipt;
        try { receipt = JSON.parse(readFileSync(join(root, 'package/gateway-sdk/build.json'), 'utf8')); }
        catch { throw new Error('Incomplete backend component or licenses'); }
        const declared = receipt?.codeModeHostSha256;
        const named = typeof declared === 'string' && /^[a-f0-9]{64}$/.test(declared);
        if (('codeModeHostSha256' in Object(receipt)) !== named || named !== entries.has('package/gateway-sdk/codex-code-mode-host')) {
          throw new Error('Incomplete backend component or licenses');
        }
      }
    }
  }
  return { root, files: [...entries.keys()], entries, version: pkg.version, node: release.node, manifest };
}

export function copyVerifiedBackend(backend, destination) {
  for (const [path, hash] of backend.entries) {
    const descriptor = openSync(join(backend.root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size > 1024 * 1024 * 1024) throw new Error('Invalid backend payload file');
      const bytes = readFileSync(descriptor);
      if (digest(bytes) !== hash) throw new Error('Backend changed after verification');
      const target = join(destination, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx', mode: info.mode & 0o777 });
    } finally { closeSync(descriptor); }
  }
  writeFileSync(join(destination, 'checksums.txt'), backend.manifest, { flag: 'wx' });
  verifiedBackend(destination);
}
