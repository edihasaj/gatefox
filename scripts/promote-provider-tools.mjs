import { cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { withPrivateFileLock } from '../dist/private-file-lock.js';

/** Retain immutable installations so switching the manifest never changes or deletes an existing CLI session. */
export async function promoteProviderTools(candidate, releases, root) {
  // Resolve the contract and hashing rules from the exact candidate that passed the gate, never stale root dist.
  const { providerToolContract, providerToolsRoot, providerToolTree, providerCommand } = await import(pathToFileURL(join(candidate, 'checkout/dist/provider-tool-runtime.js')));
  root ??= providerToolsRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const installs = join(root, 'installs'); mkdirSync(installs, { recursive: true, mode: 0o700 });
  for (const path of [root, installs]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw Error('Provider runtime directory is not private');
  }
  return withPrivateFileLock(join(root, 'promotion'), async () => {
    const providers = {};
    let current;
    try { current = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8')); } catch {}
    for (const kind of ['claude', 'copilot']) {
      const source = realpathSync(join(candidate, kind));
      const modules = join(source, 'node_modules');
      const sourceHash = await providerToolTree(modules);
      const previous = current?.contract === providerToolContract ? current.providers?.[kind] : undefined;
      if (previous?.version === releases[kind].version && previous.treeSha256 === sourceHash) {
        try { await providerCommand(kind, root); providers[kind] = previous; continue; } catch {}
      }
      const installation = `${kind}-${releases[kind].version}-${sourceHash}-${randomUUID()}`;
      const destination = join(installs, installation);
      const executable = relative(source, realpathSync(join(modules, '.bin', kind)));
      if (!executable.startsWith('node_modules/') || executable.includes('..')) throw Error('Provider executable escaped its installation');
      const stage = join(installs, `stage-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 });
      cpSync(modules, join(stage, 'node_modules'), { recursive: true, verbatimSymlinks: true });
      if (await providerToolTree(join(stage, 'node_modules')) !== sourceHash) throw Error('Provider installation changed during promotion');
      renameSync(stage, destination);
      providers[kind] = { version: releases[kind].version, installation, executable, treeSha256: sourceHash };
    }
    const currentPath = join(root, 'current.json'); const stage = join(root, `current-${randomUUID()}.json`);
    // Both provider paths advance in one atomic rename, after both immutable trees have been verified.
    writeFileSync(stage, JSON.stringify({ schemaVersion: 1, contract: providerToolContract, providers }, null, 2) + '\n', { mode: 0o600 });
    renameSync(stage, currentPath);
    return providers;
  });
}
