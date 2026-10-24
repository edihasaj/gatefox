import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, relative, sep } from 'node:path';
import { readAsarFile, replaceAsarFile } from './asar.mjs';
import { isolationPrelude } from './isolation.mjs';
import { patchNativeCatalogAsset } from './catalog.mjs';

export const supportedClaudeTrial = Object.freeze({
  version: '2.42304.2',
  asarSha256: 'f0a063c8c2c7fb21eb51bca00f086e5b7355d7208e3d9f28600ea79961830907',
  assetSha256: '7814525a829b7fc39e64971ce985ba374146c53f7f0bcceddcbe153b7409bc01',
  asset: 'Contents/Resources/ion-dist/assets/v1/shared-182-DmmFG2g-.js',
  main: '.vite/build/index.pre.js',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (file, args, input) => execFileSync(file, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });

/** Patches only an already-cloned, pristine app under this trial's /tmp root. Never signs or changes its bundle ID. */
export async function prepareNativeTrial({ sourceApp, copyApp, stateRoot, catalog }) {
  const source = await realpath(sourceApp);
  const copy = await realpath(copyApp);
  const parent = await realpath(resolve(stateRoot, '..'));
  if (!/^\/private\/tmp\/claude-native-picker\.[A-Za-z0-9]+$/.test(parent) || resolve(stateRoot) !== join(parent, 'trial') && resolve(stateRoot) !== join('/tmp', parent.split('/').at(-1), 'trial')) throw Error('Invalid task-owned native trial state root');
  const rel = relative(parent, copy);
  if (!rel || rel.startsWith(`..${sep}`) || resolve(copy) === source || !copy.endsWith('.app')) throw Error('Native trial copy must be separate from the official app and inside its task root');
  const info = await lstat(copy);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw Error('Native trial copy is not an owned directory');
  for (const name of ['Contents/Resources/app.asar', supportedClaudeTrial.asset, 'Contents/Info.plist']) {
    const path = join(copy, name);
    const stat = await lstat(path);
    if (await realpath(path) !== path || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) {
      throw Error('Trial resources must be owned, unlinked regular files without symlink parents');
    }
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
  const version = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(source, 'Contents/Info.plist')]).trim();
  if (version !== supportedClaudeTrial.version) throw Error('This Claude version has no verified native-trial patch');
  const asarPath = app => join(app, 'Contents/Resources/app.asar');
  const sourceAsar = await readFile(asarPath(source));
  const originalAsar = await readFile(asarPath(copy));
  const sourceAsset = await readFile(join(source, supportedClaudeTrial.asset));
  const originalAsset = await readFile(join(copy, supportedClaudeTrial.asset));
  if (digest(sourceAsar) !== supportedClaudeTrial.asarSha256 || !sourceAsar.equals(originalAsar) || digest(sourceAsset) !== supportedClaudeTrial.assetSha256 || !sourceAsset.equals(originalAsset)) throw Error('Claude source or trial resources do not match the verified pristine version');
  const originalInfo = await readFile(join(copy, 'Contents/Info.plist'));
  const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(copy, 'Contents/Info.plist')]));
  const currentHeader = plist.ElectronAsarIntegrity?.['Resources/app.asar'];
  if (currentHeader?.algorithm !== 'SHA256') throw Error('Unsupported Claude archive integrity metadata');
  const main = readAsarFile(originalAsar, supportedClaudeTrial.main).toString('utf8');
  const replacement = Buffer.from(`"use strict";\n${isolationPrelude(resolve(stateRoot))}${main}`);
  const patched = replaceAsarFile(originalAsar, supportedClaudeTrial.main, replacement);
  const asset = patchNativeCatalogAsset(originalAsset.toString('utf8'), catalog);
  currentHeader.hash = patched.headerSha256;
  const nextInfo = run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], JSON.stringify(plist));
  try {
    await writeFile(asarPath(copy), patched.archive);
    await writeFile(join(copy, supportedClaudeTrial.asset), asset);
    await writeFile(join(copy, 'Contents/Info.plist'), nextInfo);
  } catch (error) {
    await writeFile(asarPath(copy), originalAsar);
    await writeFile(join(copy, supportedClaudeTrial.asset), originalAsset);
    await writeFile(join(copy, 'Contents/Info.plist'), originalInfo);
    throw error;
  }
  if (digest(await readFile(asarPath(source))) !== supportedClaudeTrial.asarSha256 || digest(await readFile(join(source, supportedClaudeTrial.asset))) !== supportedClaudeTrial.assetSha256) throw Error('Official Claude resources changed during trial preparation');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
  return { experimental: true, sourceVersion: version, copyApp: copy, stateRoot: resolve(stateRoot),
    originalSignatureVerified: true, resigningPerformed: false, bundleIdentifierChanged: false,
    archiveSha256: digest(patched.archive), assetSha256: digest(Buffer.from(asset)), headerSha256: patched.headerSha256 };
}
