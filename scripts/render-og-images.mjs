#!/usr/bin/env node
// Renders the 1200x630 JPEG share images into docs/assets/og/ from scripts/og/template.html with abx
// (https://github.com/edihasaj/agent tools). Run after adding a doc page or changing a title or
// summary, then commit the images: `node scripts/render-og-images.mjs`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPages } from './build-docs-site.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'docs', 'assets', 'og');
const template = pathToFileURL(join(root, 'scripts', 'og', 'template.html')).href;
export const specialPages = [
  { name: 'index', kicker: 'A small bridge for your AI accounts', title: 'All your models. One picker.', lead: 'Use Claude, ChatGPT, Copilot and local models from the coding app you already use.', route: true },
  { name: 'reference', kicker: 'Reference', title: 'All docs.', lead: 'Every GateFox topic in one place, with when to read it.' },
];
const abx = (...args) => execFileSync('abx', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

mkdirSync(out, { recursive: true });
const pages = [...specialPages, ...readPages().map(page => ({ name: page.name, kicker: page.name === 'roadmap' ? 'Help wanted' : 'Docs', title: page.title, lead: page.summary.replace(/`/g, '') }))];
abx('viewport', '1200x630');
for (const page of pages) {
  const query = new URLSearchParams({ kicker: page.kicker, title: page.title, lead: page.lead, ...(page.route ? { route: '1' } : {}) });
  abx('goto', `${template}?${query}`);
  const png = join(out, `${page.name}.png`);
  abx('screenshot', '--viewport', png);
  // JPEG keeps 58 images near 6 MB; share previews accept it everywhere.
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '84', png, '--out', join(out, `${page.name}.jpg`)], { stdio: 'ignore' });
  rmSync(png);
}
process.stdout.write(JSON.stringify({ images: pages.length, directory: out }) + '\n');
