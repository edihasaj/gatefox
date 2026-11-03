import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { officialBytes } from './provider-release-discovery.mjs';
import { runValidation, validationEnvironment } from './provider-maintenance-process.mjs';

/** Install only in the candidate's private validation prefix. No global installs or provider logins. */
export async function validateProviderCli(kind, release, directory, checkout) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const archive = join(directory, 'candidate.tgz');
  const bytes = await officialBytes(release.tarball, 128 * 1024 * 1024);
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== release.integrity) throw Error('Provider archive integrity mismatch');
  writeFileSync(archive, bytes, { mode: 0o600 });
  const env = validationEnvironment(join(directory, 'home'), { NPM_CONFIG_USERCONFIG: '/dev/null' });
  await runValidation('npm', ['install', '--prefix', directory, '--ignore-scripts=false', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', archive], { cwd: directory, env, timeoutMs: 300_000 });
  const command = join(directory, 'node_modules/.bin', kind === 'claude' ? 'claude' : 'copilot');
  const version = await runValidation(command, ['--version'], { cwd: directory, env });
  if (!new RegExp(`(^|\\s)${release.version.replaceAll('.', '\\.')}($|\\s|\\(|\\.(?=\\s|$))`).test(version)) throw Error('Provider CLI version mismatch');
  const help = await runValidation(command, ['--help'], { cwd: directory, env });
  const flags = kind === 'claude'
    ? ['--tools', '--mcp-config', '--input-format', '--output-format', '--allowedTools']
    : ['--no-auto-update', '--disable-builtin-mcps', '--no-custom-instructions'];
  if (flags.some(flag => !help.includes(flag))) throw Error('Required provider CLI flags changed');
  await runValidation(process.execPath, [join(checkout, 'scripts/probe-provider-cli.mjs'), kind, command, checkout, directory, release.version],
    { cwd: directory, env, timeoutMs: 30_000 });
  // Keep upstream terms with the private candidate. These packages are never redistributed.
  const manifest = JSON.parse(readFileSync(join(directory, 'node_modules', release.package, 'package.json'), 'utf8'));
  if (!manifest.license) throw Error('Provider package license metadata is missing');
  chmodSync(directory, 0o700);
  return { ...release, checks: ['version', 'required_flags', kind === 'copilot' ? 'rpc_v3' : 'stream_json_control'],
    license: manifest.license };
}
