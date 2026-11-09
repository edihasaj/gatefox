import { execFileSync } from 'node:child_process';

/** A clean source checkout has no dist. Always compile before packing, and refuse an incomplete package. */
export function packReleasePackage(destination, { allowDirty = false, run = execFileSync } = {}) {
  run('npm', ['run', 'build'], { stdio: 'inherit' });
  if (!allowDirty && run('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) {
    throw new Error('The release build changed tracked source; commit it before packaging');
  }
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', destination], { encoding: 'utf8' }))[0];
  const files = new Set(packed?.files?.map(file => file.path));
  for (const required of ['dist/cli.js', 'dist/cli-main.js', 'dist/token-command.js', 'dist/native-auth-compat.js', 'dist/config.js', 'dist/catalog.js', 'dist/server.js', 'dist/app-management.js']) {
    if (!files.has(required)) throw new Error(`Release package is missing ${required}`);
  }
  return packed;
}
