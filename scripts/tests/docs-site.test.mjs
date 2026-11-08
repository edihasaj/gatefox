import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPage, render } from '../build-docs-site.mjs';

const page = (name, summary, hints = []) => readPage(name, `---\nsummary: '${summary}'\nread_when:\n${hints.map(hint => `  - ${hint}\n`).join('')}---\n\n# Title of ${name}\n`);

test('front matter gives the title, summary and read_when hints', () => {
  assert.deepEqual(page('remote', "One host''s catalog", ['Adding a Mac', 'Using `gateway token`']),
    { name: 'remote', title: 'Title of remote', summary: "One host's catalog", readWhen: ['Adding a Mac', 'Using `gateway token`'] });
  assert.throws(() => readPage('bare', '# No front matter\n'), /no front matter/);
  assert.throws(() => readPage('nosummary', '---\nread_when:\n  - x\n---\n'), /no summary/);
});

test('every page is listed once, unknown pages land in More, and text is escaped', () => {
  const html = render([page('remote', 'Share <one> host'), page('brand-new-topic', 'Uses `code` & more')]);
  assert.equal(html.match(/class="card"/g).length, 2);
  assert.match(html, /id="more-than-one-mac"/);
  assert.match(html, /id="more"/);
  assert.match(html, /Share &lt;one&gt; host/);
  assert.match(html, /Uses <code>code<\/code> &amp; more/);
  assert.match(html, /blob\/main\/docs\/brand-new-topic\.md/);
});
