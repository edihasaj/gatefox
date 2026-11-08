#!/usr/bin/env node
// Publishes the docs site to GitHub Pages as a generated `gh-pages` branch.
// Usage: node scripts/deploy-docs-site.mjs --remote https://github.com/OWNER/REPO.git [--push]
// Without --push it builds and commits the branch in a temporary folder and prints what it
// would publish. The branch holds only generated files, so each publish replaces it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { build, site } from './build-docs-site.mjs';

const argument = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const remote = argument('--remote'); const push = process.argv.includes('--push');
if (!remote || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(remote)) {
  process.stderr.write('Pass --remote https://github.com/OWNER/REPO.git (the public repository that serves Pages)\n'); process.exit(2);
}
function indexNowKey() {
  const fromEnv = process.env.COMPASS_INDEXNOW_KEY;
  const file = join(homedir(), '.config/compass/search-provider-credentials.json');
  const key = fromEnv || (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).indexnow_key : undefined);
  if (key !== undefined && !/^[A-Za-z0-9-]{8,128}$/.test(key)) throw new Error('The IndexNow key has an invalid format');
  return key;
}
const work = mkdtempSync(join(process.env.TMPDIR?.startsWith('/tmp') ? process.env.TMPDIR : '/tmp', 'gatefox-pages-'));
try {
  const out = join(work, 'site'); const result = build(out);
  writeFileSync(join(out, 'CNAME'), new URL(site).host + '\n');
  writeFileSync(join(out, '.nojekyll'), '');
  // IndexNow proves ownership with a public /<key>.txt file. The key is shared across Edi's sites
  // and never committed to the source: it comes from COMPASS_INDEXNOW_KEY or the Compass
  // credentials file, and only the generated gh-pages branch carries the file.
  const key = indexNowKey();
  if (key) writeFileSync(join(out, `${key}.txt`), key);
  const git = (...args) => execFileSync('git', ['-C', out, ...args], { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
  git('init', '-q', '-b', 'gh-pages'); git('add', '-A');
  const source = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  git('-c', 'user.name=GateFox docs', '-c', 'user.email=docs@gatefox.dev', 'commit', '-q', '-m', `docs: publish site from ${source}`);
  if (push) git('push', '--force', remote, 'gh-pages:gh-pages');
  process.stdout.write(JSON.stringify({ pages: result.pages, indexNowKeyFile: Boolean(indexNowKey()), domain: new URL(site).host, remote, branch: 'gh-pages', source, pushed: push }) + '\n');
} finally { rmSync(work, { recursive: true, force: true }); }
