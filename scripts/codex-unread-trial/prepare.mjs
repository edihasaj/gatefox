/** Prepare reviewable paired assets and original bytes. Never writes, signs, or launches an app. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAsarFile } from '../claude-native-trial/asar.mjs';
import { patchPinnedUnreadBundle, supportedUnreadTrial as pin } from './patch.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareUnreadCandidate(app = '/Applications/ChatGPT.app') {
  const source = resolve(app, 'Contents/Resources/app.asar');
  const archive = await readFile(source);
  const version = JSON.parse(readAsarFile(archive, 'package.json')).version;
  const original = { renderer: readAsarFile(archive, pin.asset), conversation: readAsarFile(archive, pin.conversationAsset) };
  const bridgeSource = await readFile(new URL('./read-state-bridge.mjs', import.meta.url), 'utf8');
  // All version and chunk checks happen before creating any output.
  const patched = patchPinnedUnreadBundle({ renderer: original.renderer.toString(), conversation: original.conversation.toString(), bridgeSource, version });
  const root = await mkdtemp('/tmp/hg-unread-candidate-');
  await Promise.all(['original', 'patched'].map(name => mkdir(join(root, name), { mode: 0o700 })));
  const assets = [];
  for (const [key, asset] of [['renderer', pin.asset], ['conversation', pin.conversationAsset]]) {
    const name = basename(asset);
    await writeFile(join(root, 'original', name), original[key], { mode: 0o600 });
    await writeFile(join(root, 'patched', name), patched[key], { mode: 0o600 });
    assets.push({ asset, originalSha256: sha256(original[key]), candidateSha256: sha256(patched[key]) });
  }
  const sources = {};
  for (const name of ['patch.mjs', 'read-state-bridge.mjs', 'receipt-registry.mjs', 'receipt-checkpoints.mjs']) {
    sources[name] = sha256(await readFile(new URL(name, import.meta.url)));
  }
  const manifest = { version, source, sourceArchiveSha256: sha256(archive), assets, sources,
    checkpointMigration: 'Preserve native choices on first observation; reconcile later SDK revision changes. New start/fork responses establish a fresh baseline.',
    checkpointScope: 'SHA-256 of native account identity and execution-host token. IndexedDB transactions fence cross-window responses.',
    installed: false, signed: false, nativeWindowVerified: false,
    rollback: 'Discard the authorized disposable app copy. Leave the original signed application unchanged.',
    boundary: 'Paired renderer assets only. Applying them requires separate authorization and native-window verification.' };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return { root, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { root } = await prepareUnreadCandidate(process.argv[2]);
  console.log(JSON.stringify({ candidate: root, manifest: join(root, 'manifest.json'), installed: false }));
}
