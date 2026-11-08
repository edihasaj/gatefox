import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPage, renderPage, renderReference, siteLink, slug } from '../build-docs-site.mjs';

const page = (name, summary, hints = [], body = '') => readPage(name, `---\nsummary: '${summary}'\nread_when:\n${hints.map(hint => `  - ${hint}\n`).join('')}---\n\n# Title of ${name}\n${body}`);

test('front matter gives the title, summary and read_when hints', () => {
  const remote = page('remote', "One host''s catalog", ['Adding a Mac', 'Using `gateway token`']);
  assert.deepEqual({ ...remote, body: undefined }, { name: 'remote', title: 'Title of remote', summary: "One host's catalog", readWhen: ['Adding a Mac', 'Using `gateway token`'], body: undefined });
  assert.throws(() => readPage('bare', '# No front matter\n'), /no front matter/);
  assert.throws(() => readPage('nosummary', '---\nread_when:\n  - x\n---\n'), /no summary/);
});

test('every page is listed once, unknown pages land in More, and text is escaped', () => {
  const html = renderReference([page('remote', 'Share <one> host'), page('brand-new-topic', 'Uses `code` & more')]);
  assert.equal(html.match(/class="card"/g).length, 2);
  assert.match(html, /id="more-than-one-mac"/);
  assert.match(html, /id="more"/);
  assert.match(html, /Share &lt;one&gt; host/);
  assert.match(html, /Uses <code>code<\/code> &amp; more/);
  assert.match(html, /href="brand-new-topic\.html"/);
});

test('links map to site pages, the guide or the repository', () => {
  const pages = new Set(['services', 'remote']);
  assert.equal(siteLink('services.md#one-managed-service', pages), 'services.html#one-managed-service');
  assert.equal(siteLink('../README.md', pages), 'index.html');
  assert.equal(siteLink('#local', pages), '#local');
  assert.equal(siteLink('https://example.com/x.md', pages), 'https://example.com/x.md');
  assert.match(siteLink('evidence/run.json', pages), /\/blob\/main\/docs\/evidence\/run\.json$/);
  assert.match(siteLink('missing.md', pages), /\/blob\/main\/docs\/missing\.md$/);
});

test('rendered pages carry GitHub-style heading anchors and a table of contents', () => {
  assert.equal(slug('Desktop adapters wait for the app&#39;s next launch'), 'desktop-adapters-wait-for-the-apps-next-launch');
  const html = renderPage(page('services', 'Service', [], '\n## Per-chat rollout: newer\n\nSee [remote](remote.md).\n'), new Set(['services', 'remote']));
  assert.match(html, /<h2 id="per-chat-rollout-newer">/);
  assert.match(html, /href="#per-chat-rollout-newer"/);
  assert.match(html, /href="remote\.html"/);
});

test('every page gets a canonical URL, its own share image and full social tags; the 404 page is noindex', async () => {
  const { seoTags, sitemap, guideHtml, pageUrl } = await import('../build-docs-site.mjs');
  const tags = seoTags({ name: 'services', title: 'One <managed> service', description: 'Service & more' });
  for (const needle of ['<link rel="canonical" href="https://gatefox.dev/services.html">', 'max-image-preview:large',
    'og:image" content="https://gatefox.dev/assets/og/services.jpg"', 'og:image:width" content="1200"', 'twitter:card" content="summary_large_image"',
    'msvalidate.01', '<title>One &lt;managed&gt; service · GateFox</title>', 'content="Service &amp; more"']) assert.ok(tags.includes(needle), needle);
  const missing = seoTags({ name: '404', title: 'Not found', description: 'x', noindex: true });
  assert.match(missing, /name="robots" content="noindex"/); assert.doesNotMatch(missing, /rel="canonical"/);
  assert.equal(pageUrl('index'), 'https://gatefox.dev/');
  const xml = sitemap([{ name: 'services', title: 'S & T' }], '2026-11-08');
  assert.equal(xml.match(/<loc>/g).length, 3, 'the guide, all docs and the page');
  assert.equal(xml.match(/<image:loc>/g).length, 3, 'each with its share image');
  assert.match(xml, /S &amp; T/);
  const guide = guideHtml('<head>\n  <meta name="description" content="old">\n  <title>Old</title>\n  <link rel="icon" href="x">\n</head>');
  assert.doesNotMatch(guide, /<title>Old<\/title>|content="old"/); assert.match(guide, /application\/ld\+json/);
});
