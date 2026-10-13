import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const canonical = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const releaseVersionProblem = version => canonical.test(String(version)) ? undefined : `Invalid release version ${version}; the patch tops out at 9, so use x.y.z with z from 0 to 9`;
export function nextReleaseVersion(version) {
  const parts = semver.exec(String(version)); if (!parts) throw new Error(`Invalid release version ${version}; expected x.y.z`);
  const [, major, minor, patch] = parts; const [y, z] = [Number(minor), Number(patch)];
  return z >= 9 ? `${major}.${y + 1}.0` : `${major}.${y}.${z + 1}`;
}
/** Node loads this file by its real path, so the entry point is compared the same way. */
function runDirectly() {
  const entry = process.argv[1]; if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (runDirectly()) {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (process.argv.includes('--check')) { const problem = releaseVersionProblem(version); if (problem) { console.log(problem); process.exit(1); } console.log('ok'); }
  else console.log(nextReleaseVersion(version));
}
