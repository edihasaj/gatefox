#!/usr/bin/env node
// Publishes the docs site to GitHub Pages as a generated `gh-pages` branch.
// Usage: node scripts/deploy-docs-site.mjs --remote https://github.com/OWNER/REPO.git [--push]
// Without --push it builds and commits the branch in a temporary folder and prints what it
// would publish. The branch holds only generated files, so each publish replaces it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, site } from './build-docs-site.mjs';

const argument = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const remote = argument('--remote'); const push = process.argv.includes('--push');
if (!remote || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(remote)) {
  process.stderr.write('Pass --remote https://github.com/OWNER/REPO.git (the public repository that serves Pages)\n'); process.exit(2);
}
const work = mkdtempSync(join(process.env.TMPDIR?.startsWith('/tmp') ? process.env.TMPDIR : '/tmp', 'gatefox-pages-'));
try {
  const out = join(work, 'site'); const result = build(out);
  writeFileSync(join(out, 'CNAME'), new URL(site).host + '\n');
  writeFileSync(join(out, '.nojekyll'), '');
  const git = (...args) => execFileSync('git', ['-C', out, ...args], { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
  git('init', '-q', '-b', 'gh-pages'); git('add', '-A');
  const source = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
  git('-c', 'user.name=Gatefox docs', '-c', 'user.email=docs@gatefox.dev', 'commit', '-q', '-m', `docs: publish site from ${source}`);
  if (push) git('push', '--force', remote, 'gh-pages:gh-pages');
  process.stdout.write(JSON.stringify({ pages: result.pages, domain: new URL(site).host, remote, branch: 'gh-pages', source, pushed: push }) + '\n');
} finally { rmSync(work, { recursive: true, force: true }); }
