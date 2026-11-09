import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const unescape = value => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
const anchors = html => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => unescape(match[1])));

/** A moved or renamed heading must leave an alias behind for already-published deep links. */
export function auditPreviousAnchors(directory, previousPages) {
  const lost = [];
  for (const [page, previous] of previousPages) {
    const current = existsSync(join(directory, page)) ? anchors(readFileSync(join(directory, page), 'utf8')) : new Set();
    for (const id of anchors(previous)) if (!current.has(id)) lost.push({ page, id });
  }
  return lost;
}

/** Check every generated internal destination, including old section anchors after a doc moves. */
export function auditSite(directory, origin = 'https://gatefox.dev') {
  const pages = readdirSync(directory).filter(name => name.endsWith('.html'));
  const ids = new Map(pages.map(name => [name, anchors(readFileSync(join(directory, name), 'utf8'))]));
  const broken = [];
  for (const page of pages) {
    const html = readFileSync(join(directory, page), 'utf8');
    for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
      const href = unescape(match[1]);
      let url;
      try { url = new URL(href, origin + '/' + page); } catch { broken.push({ page, href, reason: 'invalid_url' }); continue; }
      if (url.origin !== origin) continue;
      const file = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (!existsSync(join(directory, file))) { broken.push({ page, href, reason: 'missing_page' }); continue; }
      if (url.hash && extname(file) === '.html' && !ids.get(file)?.has(decodeURIComponent(url.hash.slice(1)))) broken.push({ page, href, reason: 'missing_anchor' });
    }
    for (const match of html.matchAll(/(?:src|content)="([^"]+)"/g)) {
      let url;
      try { url = new URL(unescape(match[1]), origin + '/' + page); } catch { continue; }
      if (url.origin === origin && url.pathname.startsWith('/assets/') && !existsSync(join(directory, decodeURIComponent(url.pathname.slice(1))))) broken.push({ page, href: match[1], reason: 'missing_asset' });
    }
  }
  return { pages: pages.length, broken };
}

/** Report long references and legacy names; reject stale current product headings, not compatibility identifiers. */
export function reviewSources(directory) {
  if (directory instanceof URL) directory = fileURLToPath(directory);
  const longPages = [], legacyMentions = [], staleHeadings = [];
  for (const file of readdirSync(directory).filter(name => name.endsWith('.md'))) {
    const text = readFileSync(join(directory, file), 'utf8'), lines = text.split('\n');
    if (lines.length > 500) longPages.push({ file, lines: lines.length });
    let fenced = false;
    lines.forEach((line, index) => {
      if (/^\s*```/.test(line)) { fenced = !fenced; return; }
      if (fenced) return;
      const visible = line.replace(/`[^`]+`/g, '');
      if (/\b(?:Subscription Gateway|Harness Gateway)\b/.test(visible)) legacyMentions.push({ file, line: index + 1, text: line.trim() });
      if (/^#{1,2}\s+(?:Subscription Gateway|Harness Gateway)(?:\s+for\s+macOS)?\s*$/.test(visible)) staleHeadings.push({ file, line: index + 1, text: line.trim() });
    });
  }
  longPages.sort((a, b) => b.lines - a.lines);
  return { longPages, legacyMentions, staleHeadings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { build, site } = await import('./build-docs-site.mjs');
  const at = process.argv.indexOf('--out'), out = resolve(at > 0 ? process.argv[at + 1] : join(root, '.state/docs-site'));
  const built = build(out), audit = auditSite(out, site), sources = reviewSources(join(root, 'docs'));
  console.log(JSON.stringify({ ...built, ...audit, ...sources }, null, 2));
  if (audit.broken.length || sources.staleHeadings.length) process.exitCode = 1;
}
