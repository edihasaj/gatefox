import {dirname, join, resolve} from 'node:path';

/** The files the shared-execution check loads from a package's dist. */
const required = ['execution-host.js', 'config.js'];

/** Decodes the single-quoted words of a shell line the way the installer writes them (`'` becomes `'\''`). */
export function quotedWords(text) {
  return [...text.matchAll(/'((?:[^']|'\\'')*)'/g)].map(match => match[1].replaceAll("'\\''", "'"));
}

/** The cli.js an installer-written launcher runs, or undefined when the text is not such a launcher. */
export function launcherCli(text) {
  const line = text.split('\n').find(value => /(^|\s)exec\s/.test(value) && value.includes('/dist/cli.js'));
  if (!line) return undefined;
  const words = quotedWords(line.slice(line.search(/(^|\s)exec\s/)));
  return words.find(word => word.endsWith('/dist/cli.js'));
}

/**
 * Chooses the dist folder that holds `execution-host.js` and `config.js` for the shared-execution check.
 * - `package` (an installed package folder) wins and must have them, or this throws.
 * - Otherwise the package comes from `gateway`: the installed launcher's `current/package`, the package two levels above a
 *   `dist/cli.js` path (as e2e-compaction-switch.mjs does), or `<prefix>/share/subscription-gateway/current/package` beside it.
 * - If none of those has them, the checkout's own `fallback` dist is used.
 * `exists(path)` and `readText(path)` (undefined when unreadable) are injected so the choice stays a pure function.
 * @returns {{directory: string, source: 'package' | 'launcher' | 'gateway-path' | 'install-layout' | 'checkout'}}
 */
export function resolveDistDirectory({package: explicit, gateway, fallback, exists, readText}) {
  const holds = packageDirectory => required.every(name => exists(join(packageDirectory, 'dist', name)));
  if (explicit) {
    const directory = resolve(explicit, 'dist');
    const missing = required.filter(name => !exists(join(directory, name)));
    if (missing.length) throw new Error(`--package has no dist/${missing.join(' or dist/')}: ${resolve(explicit)}`);
    return {directory, source: 'package'};
  }
  if (gateway) {
    const command = resolve(gateway);
    const cli = launcherCli(readText(command) ?? '');
    const candidates = [
      ...(cli ? [['launcher', resolve(dirname(cli), '..')]] : []),
      ['gateway-path', resolve(command, '../..')],
      ['install-layout', resolve(dirname(command), '../share/subscription-gateway/current/package')],
    ];
    for (const [source, packageDirectory] of candidates) if (holds(packageDirectory)) return {directory: join(packageDirectory, 'dist'), source};
  }
  return {directory: resolve(fallback), source: 'checkout'};
}
