import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve('.state/release'); const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() && !process.argv.includes('--allow-dirty')) throw new Error('Commit release source first; use --allow-dirty only for installer tests');
const name = `subscription-gateway-${version}-macos-arm64`; const directory = join(root, name);
const runtimeArchive = resolve('.state/release-runtime/node-v24.21.0-darwin-arm64.tar.gz');
const runtimeDigest = createHash('sha256').update(readFileSync(runtimeArchive)).digest('hex');
if (runtimeDigest !== 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057') throw new Error('Official Node runtime checksum mismatch');
mkdirSync(directory, { recursive: true });
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { encoding: 'utf8' }))[0];
execFileSync('tar', ['-xzf', join(root, packed.filename), '-C', directory]);
mkdirSync(join(directory, 'runtime/bin'), { recursive: true });
const runtime = resolve('.state/release-runtime/node-v24.21.0-darwin-arm64');
cpSync(join(runtime, 'bin/node'), join(directory, 'runtime/bin/node'));
cpSync(join(runtime, 'LICENSE'), join(directory, 'runtime/LICENSE'));
cpSync('scripts/install.sh', join(directory, 'install')); chmodSync(join(directory, 'install'), 0o700);
writeFileSync(join(directory, 'package/release.json'), JSON.stringify({ version, node: '24.21.0', nodeArchiveSha256: runtimeDigest, source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }, null, 2));
const files = [];
function walk(path, relative = '') { for (const name of readdirSync(path).sort()) { const child = join(path, name); const entry = relative ? `${relative}/${name}` : name; if (statSync(child).isDirectory()) walk(child, entry); else if (entry !== 'checksums.txt') files.push(entry); } }
walk(directory);
writeFileSync(join(directory, 'checksums.txt'), files.map(file => `${createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')}  ${file}`).join('\n') + '\n');
execFileSync('tar', ['-czf', join(root, `${name}.tar.gz`), '-C', root, name]);
const asset = join(root, `${name}.tar.gz`);
writeFileSync(join(root, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(asset)).digest('hex')}  ${name}.tar.gz\n`);
console.log(JSON.stringify({ asset, checksum: join(root, 'SHA256SUMS'), version, bundledRuntime: true }));
