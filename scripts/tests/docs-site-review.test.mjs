import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditPreviousAnchors, auditSite, reviewSources } from '../review-docs-site.mjs';

test('site review checks destinations, old section anchors and required share images', () => {
  const root = mkdtempSync('/tmp/gatefox-doc-links-');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<a href="guide.html#old-heading">Guide</a><a href="https://example.com/">External</a><img src="assets/logo.png">');
  writeFileSync(join(root, 'guide.html'), '<a id="old-heading"></a><h1>New guide</h1>');
  writeFileSync(join(root, 'assets/logo.png'), 'fixture');
  assert.deepEqual(auditSite(root).broken, []);
  assert.deepEqual(auditPreviousAnchors(root, [['guide.html', '<h2 id="old-heading">Old</h2>']]), []);
  writeFileSync(join(root, 'guide.html'), '<a href="missing.html">Missing</a>');
  assert.deepEqual(auditSite(root).broken.map(row => row.reason).sort(), ['missing_anchor', 'missing_page']);
  assert.deepEqual(auditPreviousAnchors(root, [['guide.html', '<h2 id="old-heading">Old</h2>']]), [{ page: 'guide.html', id: 'old-heading' }]);
});

test('source review distinguishes current product headings from compatibility paths and reports long references', () => {
  const root = mkdtempSync('/tmp/gatefox-doc-names-');
  writeFileSync(join(root, 'correct.md'), '# GateFox\n\nKeep `Library/Application Support/Subscription Gateway`.\n\nHarness Gateway is the sidebar subtitle.\n');
  writeFileSync(join(root, 'old.md'), '# Subscription Gateway\n' + '\n'.repeat(501));
  const result = reviewSources(root);
  assert.deepEqual(result.staleHeadings.map(row => row.file), ['old.md']);
  assert.equal(result.longPages[0].file, 'old.md');
  assert.equal(result.legacyMentions.some(row => row.text.includes('Library/Application')), false);
});
