#!/usr/bin/env node
// Builds the GateFox docs site (https://gatefox.dev) into one folder:
//   index.html, styles.css, app.js, assets/   the hand-written guide, copied as is
//   reference.html                            every topic, grouped, from each page's front matter
//   <name>.html                               each docs/<name>.md rendered to HTML
//   404.html
// Usage: node scripts/build-docs-site.mjs [--out DIR]   (default .state/docs-site)
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const root = fileURLToPath(new URL('..', import.meta.url));
const docs = join(root, 'docs');
export const site = 'https://gatefox.dev';
export const repository = 'https://github.com/edihasaj/gatefox';
const groups = [
  ['Start and daily use', ['cli', 'macos-app', 'app-management', 'macos-permissions', 'speed-controls', 'activity', 'background-commands']],
  ['Clients', ['messages', 'claude-desktop', 'app-server', 'api-mode', 'client-tool-reachability', 'node-repl', 'harness-identity', 'app-server-compaction', 'app-server-forks', 'claude-native-trial', 'codex-unread-trial']],
  ['Accounts, providers and models', ['api-providers', 'claude-sessions', 'copilot-sessions', 'grok-sessions', 'auto-latest-models', 'managed-routing', 'availability', 'upstream-capacity', 'cache-safety', 'provider-reuse', 'provider-updates', 'responses']],
  ['More than one Mac', ['remote', 'native-remote', 'travel-recovery']],
  ['Keep it running', ['services', 'health', 'diagnostics', 'engine-exits', 'reboot-recovery', 'service-install-recovery', 'macos-background-item', 'macos-updates', 'mcp-credentials', 'desktop-update-compatibility', 'desktop-legacy-force-cli', 'native-launcher-verification']],
  ['Architecture and project', ['architecture', 'verification', 'RELEASING', 'rollout', 'component-origins', 'ci', 'ci-cost-policy', 'availability-agent-tests', 'brand', 'docs-site', 'roadmap', 'gatefox-rename']],
];

const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unquote = text => text.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1').replace(/''/g, "'");
const inline = text => escape(text).replace(/`([^`]+)`/g, '<code>$1</code>');
const anchor = label => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** GitHub-style heading slug, so links such as `services.md#moving-to-a-new-release` keep working. */
export const slug = text => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&#?\w+;/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');

/** Splits a page into its front matter (title, summary, read_when hints) and its Markdown body. */
export function readPage(name, text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${name}.md has no front matter`);
  const summary = /^summary:\s*(.+)$/m.exec(match[1]);
  if (!summary) throw new Error(`${name}.md has no summary`);
  const readWhen = [...match[1].matchAll(/^\s+-\s+(.+)$/gm)].map(item => unquote(item[1]));
  const body = text.slice(match[0].length);
  const title = /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? name;
  return { name, title, summary: unquote(summary[1]), readWhen, body };
}

/** Maps a link in a doc to its place on the site: other docs become pages, repository files go to GitHub. */
export function siteLink(href, pages) {
  if (/^([a-z]+:|#|\/\/)/i.test(href)) return href;
  const [path, hash = ''] = href.split('#'); const suffix = hash ? `#${hash}` : '';
  if (path === '' ) return href;
  if (path === '../README.md' || path === 'index.html') return `index.html${suffix}`;
  const doc = /^([A-Za-z0-9_-]+)\.md$/.exec(path);
  if (doc && pages.has(doc[1])) return `${doc[1]}.html${suffix}`;
  const inRepository = resolve('/docs', path).slice(1);
  return `${repository}/blob/main/${inRepository}${suffix}`;
}

/** Absolute URL of a page on the site; the guide is the root. */
export const pageUrl = name => name === 'index' ? `${site}/` : `${site}/${name}.html`;
const bingVerification = 'CB0CFB524B8FF8EF17339F367EA1FA7D';
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

/** Title, description, canonical, robots, Open Graph, Twitter and JSON-LD for one page. */
export function seoTags({ name, title, description, type = 'article', noindex = false, jsonld }) {
  const url = pageUrl(name), image = `${site}/assets/og/${name}.jpg`, full = name === 'index' ? title : `${title} · GateFox`;
  const alt = `${title}: GateFox`;
  return [
    `<title>${escape(full)}</title>`,
    `<meta name="description" content="${escape(description)}">`,
    noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${url}">\n  <meta name="robots" content="index, follow, max-image-preview:large">`,
    `<meta property="og:site_name" content="GateFox">`,
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${escape(full)}">`,
    `<meta property="og:description" content="${escape(description)}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:type" content="image/jpeg">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${escape(alt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escape(full)}">`,
    `<meta name="twitter:description" content="${escape(description)}">`,
    `<meta name="twitter:image" content="${image}">`,
    `<meta name="twitter:image:alt" content="${escape(alt)}">`,
    `<meta name="msvalidate.01" content="${bingVerification}">`,
    `<meta name="theme-color" content="#ba3c19">`,
    `<link rel="manifest" href="site.webmanifest">`,
    `<link rel="apple-touch-icon" href="assets/logo.png">`,
    ...(jsonld ? [`<script type="application/ld+json">${json(jsonld)}</script>`] : []),
  ].map(line => `  ${line}`).join('\n');
}

const softwareJsonLd = {
  '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'GateFox', url: `${site}/`,
  applicationCategory: 'DeveloperApplication', operatingSystem: 'macOS (Apple silicon)',
  description: 'A local gateway that adds Claude, ChatGPT, Copilot and local models to Codex, Claude Code and Claude Desktop.',
  image: `${site}/assets/og/index.jpg`, license: 'https://opensource.org/licenses/MIT', isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  codeRepository: repository, downloadUrl: `${repository}/releases/latest`,
  author: { '@type': 'Person', name: 'Edi Hasaj', url: 'https://edihasaj.com' },
};
const articleJsonLd = page => [{
  '@context': 'https://schema.org', '@type': 'TechArticle', headline: page.title, description: page.summary,
  url: pageUrl(page.name), image: `${site}/assets/og/${page.name}.jpg`, isPartOf: { '@type': 'WebSite', name: 'GateFox', url: `${site}/` },
}, {
  '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'GateFox', item: `${site}/` },
    { '@type': 'ListItem', position: 2, name: 'All docs', item: pageUrl('reference') },
    { '@type': 'ListItem', position: 3, name: page.title, item: pageUrl(page.name) },
  ],
}];

const head = seo => `<!doctype html>
<!-- generated by scripts/build-docs-site.mjs; edit docs/*.md instead -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${seoTags(seo)}
  <link rel="icon" type="image/png" href="assets/favicon.png">
  <link rel="icon" type="image/png" sizes="16x16" href="assets/favicon-16.png">
  <link rel="stylesheet" href="styles.css">
  <script src="app.js" defer></script>
</head>
<body>`;
const brand = `<a class="brand" href="index.html"><img src="assets/logo.png" width="56" height="56" alt="GateFox fox"><span>GateFox</span></a>`;
const footer = (label, note) => `    <footer><img src="assets/favicon.png" width="24" height="24" alt=""><span>GateFox · ${escape(label)}<br><small>${escape(note)}</small></span><a href="#top">Back to top ↑</a></footer>`;

/** The grouped, searchable list of every topic. */
export function renderReference(pages) {
  const byName = new Map(pages.map(page => [page.name, page]));
  const placed = new Set();
  const sections = groups.map(([label, names]) => [label, names.filter(name => byName.has(name)).map(name => { placed.add(name); return byName.get(name); })]);
  const rest = pages.filter(page => !placed.has(page.name));
  if (rest.length) sections.push(['More', rest]);
  const shown = sections.filter(([, list]) => list.length);
  const cards = shown.map(([label, list]) => `    <section id="${anchor(label)}" data-section>
      <div class="section-number">${String(list.length).padStart(2, '0')} TOPICS</div>
      <h2>${escape(label)}</h2>
      <div class="cards">
${list.map(page => `        <a class="card" href="${page.name}.html">
          <strong>${inline(page.title)}</strong>
          <span>${inline(page.summary)}</span>${page.readWhen.length ? `
          <small>Read when: ${page.readWhen.map(inline).join(' · ')}</small>` : ''}
        </a>`).join('\n')}
      </div>
    </section>`).join('\n\n');
  const nav = shown.map(([label], index) => `      <a href="#${anchor(label)}">${String(index + 1).padStart(2, '0')} <span>${escape(label)}</span></a>`).join('\n');
  return `${head({ name: 'reference', title: 'All docs', description: 'Every GateFox topic in one place, grouped, with when to read it: setup, clients, providers, more Macs and operations.', type: 'website' })}
  <a class="skip" href="#guide">Skip to docs</a>
  <aside class="sidebar" aria-label="Docs navigation">
    ${brand}
    <div class="edition">ALL DOCS <span>${pages.length} topics</span></div>
    <label class="search-label" for="search">Find a topic</label>
    <input id="search" type="search" placeholder="Claude, SSH, service…" autocomplete="off">
    <nav>
      <a class="page-link" href="index.html">← <span>Back to the guide</span></a>
${nav}
    </nav>
    <a class="source" href="${repository}">Source on GitHub ↗</a>
  </aside>

  <main id="guide">
    <header class="hero compact" id="top">
      <div class="eyebrow">REFERENCE</div>
      <h1>All docs.</h1>
      <p class="lead">Every topic in one place, with when to read it. New here? Start with the <a href="index.html">guide</a>.</p>
    </header>

    <p id="search-status" role="status" aria-live="polite" hidden></p>

${cards}
${footer('All docs', "Generated from each page's summary.")}
  </main>
</body>
</html>
`;
}

/** One rendered doc page with its own table of contents. */
export function renderPage(page, pages) {
  const toc = [];
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens); const id = slug(html);
        if (depth === 2) toc.push([id, html]);
        return `<h${depth} id="${id}">${html}</h${depth}>\n`;
      },
    },
    walkTokens(token) { if (token.type === 'link' || token.type === 'image') token.href = siteLink(token.href, pages); },
  });
  const body = marked.parse(page.body.replace(/^#\s+.+\n/m, ''));
  const nav = toc.map(([id, html], index) => `      <a href="#${id}">${String(index + 1).padStart(2, '0')} <span>${html.replace(/<[^>]+>/g, '')}</span></a>`).join('\n');
  return `${head({ name: page.name, title: page.title, description: page.summary.replace(/`/g, ''), jsonld: articleJsonLd({ ...page, summary: page.summary.replace(/`/g, '') }) })}
  <a class="skip" href="#guide">Skip to content</a>
  <aside class="sidebar" aria-label="Page navigation">
    ${brand}
    <div class="edition">DOCS <span>${escape(page.name)}</span></div>
    <nav>
      <a class="page-link first" href="reference.html">← <span>All docs</span></a>
${nav}
    </nav>
    <a class="source" href="${repository}/blob/main/docs/${page.name}.md">Edit on GitHub ↗</a>
  </aside>

  <main id="guide" class="doc">
    <header class="doc-head" id="top">
      <div class="eyebrow">DOCS</div>
      <h1 id="${slug(escape(page.title))}">${inline(page.title)}</h1>
      <p class="lead">${inline(page.summary)}</p>
    </header>
    <article class="prose">
${body}    </article>
${footer(page.title, 'Part of the GateFox docs.')}
  </main>
</body>
</html>
`;
}

const notFound = () => `${head({ name: '404', title: 'Not found', description: 'This page does not exist.', noindex: true })}
  <main id="guide" class="doc">
    <header class="doc-head" id="top">
      ${brand}
      <h1>Not here.</h1>
      <p class="lead">This page does not exist. Try the <a href="index.html">guide</a> or <a href="reference.html">all docs</a>.</p>
    </header>
  </main>
</body>
</html>
`;

export function readPages() {
  return readdirSync(docs).filter(file => file.endsWith('.md')).sort((a, b) => a.localeCompare(b))
    .map(file => readPage(file.slice(0, -3), readFileSync(join(docs, file), 'utf8')));
}

export const guideSeo = {
  name: 'index', title: 'GateFox · Claude, ChatGPT and Copilot in your coding app', type: 'website', jsonld: softwareJsonLd,
  description: 'Use Claude, ChatGPT, Copilot and local models from Codex, Claude Code and Claude Desktop. Open source, runs on your Mac, sets up in minutes.',
};

/** The guide is hand-written; its head gets the same tags as every generated page. */
export function guideHtml(source) {
  const start = source.indexOf('  <meta name="description"'), end = source.indexOf('  <link rel="icon"');
  if (start < 0 || end < start) throw new Error('docs/index.html head is missing its description or icon links');
  return source.slice(0, start) + seoTags(guideSeo) + '\n' + source.slice(end);
}

export function sitemap(pages, lastmod) {
  const entry = (name, title) => `  <url>
    <loc>${pageUrl(name)}</loc>
    <lastmod>${lastmod}</lastmod>
    <image:image><image:loc>${site}/assets/og/${name}.jpg</image:loc><image:title>${escape(title)}</image:title></image:image>
  </url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${[entry('index', 'GateFox'), entry('reference', 'All docs'), ...pages.map(page => entry(page.name, page.title))].join('\n')}
</urlset>
`;
}

export function build(out) {
  const pages = readPages(); const names = new Set(pages.map(page => page.name));
  rmSync(out, { recursive: true, force: true }); mkdirSync(join(out, 'assets'), { recursive: true });
  for (const file of ['styles.css', 'app.js']) copyFileSync(join(docs, file), join(out, file));
  writeFileSync(join(out, 'index.html'), guideHtml(readFileSync(join(docs, 'index.html'), 'utf8')));
  cpSync(join(docs, 'assets'), join(out, 'assets'), { recursive: true });
  writeFileSync(join(out, 'reference.html'), renderReference(pages));
  for (const page of pages) writeFileSync(join(out, `${page.name}.html`), renderPage(page, names));
  writeFileSync(join(out, '404.html'), notFound());
  writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`);
  writeFileSync(join(out, 'sitemap.xml'), sitemap(pages, new Date().toISOString().slice(0, 10)));
  writeFileSync(join(out, 'site.webmanifest'), JSON.stringify({ name: 'GateFox', short_name: 'GateFox', start_url: '/', display: 'standalone',
    background_color: '#f6f3eb', theme_color: '#ba3c19', icons: [{ src: '/assets/logo.png', sizes: '256x256', type: 'image/png' }] }, null, 2) + '\n');
  return { out, pages: pages.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const at = process.argv.indexOf('--out');
  const out = resolve(at > 0 ? process.argv[at + 1] : join(root, '.state', 'docs-site'));
  process.stdout.write(JSON.stringify(build(out)) + '\n');
}
