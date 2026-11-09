import assert from 'node:assert/strict';
import test from 'node:test';
import { applyReleaseData, releaseHistoryHtml, releaseNotesHtml } from '../site-release-pages.mjs';
import { normalizeRelease, publishedReleases } from '../site-releases.mjs';

const latest = { version: '1.8.3', tag: 'v1.8.3', publishedAt: '2026-11-09T12:32:50Z',
  url: 'https://github.com/edihasaj/gatefox/releases/tag/v1.8.3',
  appDownloadUrl: 'https://github.com/edihasaj/gatefox/releases/download/v1.8.3/GateFox-1.8.3-macos-arm64.zip',
  backendAssetName: 'gatefox-1.8.3-macos-arm64.tar.gz', notes: '- The sidebar shows **GateFox** with Harness Gateway beneath it.' };

test('a published release drives the static download, version, notes and matching install commands', () => {
  const source = '<span data-release-version>v1.7.5</span><!-- release-summary --><a data-download href="https://github.com/edihasaj/gatefox/releases/latest"><span data-download-version>Apple silicon</span></a><pre><code data-release-cli>VERSION=1.7.8</code></pre>';
  const html = applyReleaseData(source, { latest, releases: [latest] });
  assert.ok(html.includes(`href="${latest.appDownloadUrl}"`));
  assert.match(html, /data-release-version>1\.8\.3<\/span>/);
  assert.match(html, /datetime="2026-11-09T12:32:50Z">9 November 2026/);
  assert.match(html, /<strong>GateFox<\/strong>/);
  assert.match(html, /href="changelog\.html#v1-8-3"/);
  assert.match(html, /VERSION=1\.8\.3/);
  assert.match(html, /gatefox-\$VERSION-macos-arm64/);
  assert.match(html, /--ignore-missing/);
  assert.doesNotMatch(html, /1\.7\.[58]|harness-gateway-\$VERSION/);
  const history = releaseHistoryHtml([latest]);
  assert.match(history, /data-release-tag="v1\.8\.3" id="v1-8-3"/);
  assert.ok(history.includes(`href="${latest.appDownloadUrl}"`));
});

test('GitHub release prose cannot execute raw HTML, image handlers or executable links', () => {
  const html = releaseNotesHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[unsafe](javascript:alert(3)) [safe](https://github.com/edihasaj/gatefox) ![alt](https://example.com/a.png)');
  assert.doesNotMatch(html, /<script|<img|href="javascript:/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /href="https:\/\/github\.com\/edihasaj\/gatefox"/);
  assert.match(html, /alt/);
});

const githubRelease = (version, changes = {}) => ({
  tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-11-09T12:32:50Z',
  html_url: `https://github.com/edihasaj/gatefox/releases/tag/v${version}`, body: '- Published body',
  assets: [`GateFox-${version}-macos-arm64.zip`, `gatefox-${version}-macos-arm64.tar.gz`, 'app-update.json', 'SHA256SUMS'].map(name => ({
    name, size: 123, state: 'uploaded', browser_download_url: `https://github.com/edihasaj/gatefox/releases/download/v${version}/${name}`,
  })), ...changes,
});

test('matching dated changelog notes retain their Markdown and versions sort numerically', () => {
  const notes = '# Changelog\n\n## Unreleased\n\n- Not shipped\n\n## 1.8.3 — 2026-11-09\n\n- Exact **shipped** note.\n';
  assert.equal(normalizeRelease(githubRelease('1.8.3'), notes)?.notes.trim(), '- Exact **shipped** note.');
  assert.deepEqual(publishedReleases([githubRelease('1.9.0'), githubRelease('1.10.0'), githubRelease('2.0.0')]).map(row => row.version), ['2.0.0', '1.10.0', '1.9.0']);
});

test('missing publication proof, ambiguous assets and foreign ports cannot become downloads', () => {
  const original = githubRelease('1.8.3');
  assert.equal(normalizeRelease({ ...original, published_at: null, created_at: original.published_at }), null);
  assert.equal(normalizeRelease({ ...original, assets: [...original.assets, original.assets[0]] }), null);
  assert.equal(normalizeRelease({ ...original, assets: original.assets.map((asset, index) => index ? asset : { ...asset, browser_download_url: asset.browser_download_url.replace('github.com/', 'github.com:8443/') }) }), null);
});
