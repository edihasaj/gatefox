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
import { publishedReleases, snapshotFromReleases } from './site-releases.mjs';
import { auditPreviousAnchors, auditSite, reviewSources } from './review-docs-site.mjs';

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
/** Public URLs whose HTML differs from the currently published gh-pages branch (all pages on a first publish). */
export function changedPages(git, remote) {
  const exists = git('ls-remote', '--heads', remote, 'refs/heads/gh-pages');
  let names;
  if (exists) {
    git('fetch', '-q', '--depth', '1', remote, 'gh-pages');
    names = git('diff', '--name-only', 'FETCH_HEAD', 'HEAD').split('\n');
  } else names = git('ls-files').split('\n');
  return names.filter(name => /^[A-Za-z0-9_-]+\.html$/.test(name) && name !== '404.html')
    .map(name => name === 'index.html' ? `${site}/` : `${site}/${name}`);
}
async function notifyIndexNow(key, urls) {
  const host = new URL(site).host;
  const response = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key, keyLocation: `${site}/${key}.txt`, urlList: urls.slice(0, 10000) }) });
  return response.status;
}
let changed = [], notified = 'skipped';
const work = mkdtempSync(join(process.env.TMPDIR?.startsWith('/tmp') ? process.env.TMPDIR : '/tmp', 'gatefox-pages-'));
try {
  // Published app releases, rather than the checkout's package version, own every public version and download.
  const releasePages = JSON.parse(execFileSync('gh', ['api', 'repos/edihasaj/gatefox/releases?per_page=100', '--paginate', '--slurp'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const releases = publishedReleases(releasePages.flat(), readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'));
  if (!releases.length) throw new Error('No complete published GateFox app release was found; refusing to publish stale download metadata');
  const releaseData = snapshotFromReleases(releases);
  const out = join(work, 'site'); const result = build(out, { releaseData });
  const audit = auditSite(out, site), sourceReview = reviewSources(new URL('../docs', import.meta.url));
  if (audit.broken.length || sourceReview.staleHeadings.length) throw new Error(`Docs review failed: ${JSON.stringify({ broken: audit.broken, staleHeadings: sourceReview.staleHeadings })}`);
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
  changed = changedPages(git, remote);
  const firstPublication = !git('ls-remote', '--heads', remote, 'refs/heads/gh-pages');
  const previous = firstPublication ? [] : git('ls-tree', '-r', '--name-only', 'FETCH_HEAD').split('\n').filter(name => /^[A-Za-z0-9_-]+\.html$/.test(name))
      .map(name => [name, git('show', `FETCH_HEAD:${name}`)]);
  const lostAnchors = auditPreviousAnchors(out, previous);
  if (lostAnchors.length) throw new Error(`Previously published section links would break: ${JSON.stringify(lostAnchors)}`);
  if (push) git('push', '--force', remote, 'gh-pages:gh-pages');
  // After a successful publish, tell IndexNow (Bing and other engines) which pages changed.
  // A failed notification is reported, but the publish itself stands.
  if (push && key && changed.length) notified = await notifyIndexNow(key, changed).catch(error => `failed: ${error.message}`);
  process.stdout.write(JSON.stringify({ pages: result.pages, latestRelease: result.latestRelease, internalLinks: 'checked', longPages: sourceReview.longPages, legacyNameMentions: sourceReview.legacyMentions.length, indexNowKeyFile: Boolean(indexNowKey()), changedPages: changed.length, indexNow: notified, domain: new URL(site).host, remote, branch: 'gh-pages', source, pushed: push }) + '\n');
} finally { rmSync(work, { recursive: true, force: true }); }
