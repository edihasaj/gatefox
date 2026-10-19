import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverProviderReleases, officialBytes } from '../provider-release-discovery.mjs';

const sha = 'a'.repeat(40); const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
function fixture(edit = () => {}) {
  const github = 'https://api.github.com/repos/openai/codex';
  const values = new Map([
    [`${github}/releases/latest`, { draft: false, prerelease: false, tag_name: 'rust-v0.163.0' }],
    [`${github}/git/ref/tags/rust-v0.163.0`, { object: { type: 'commit', sha } }],
  ]);
  for (const name of ['@anthropic-ai/claude-code', '@github/copilot']) {
    const doc = { name, version: '2.1.3', dist: { integrity, tarball: `https://registry.npmjs.org/${name}/-/candidate-2.1.3.tgz` } };
    values.set(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, structuredClone(doc));
    values.set(`https://registry.npmjs.org/${encodeURIComponent(name)}/2.1.3`, structuredClone(doc));
  }
  edit(values, github);
  const fetch = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    assert.ok(values.has(url), `unexpected endpoint ${url}`);
    return new Response(JSON.stringify(values.get(url)), { status: 200 });
  };
  return { values, fetch };
}
test('discovers immutable stable Codex and exact official npm releases', async () => {
  const result = await discoverProviderReleases(fixture());
  assert.deepEqual(result.codex, { version: '0.163.0', tag: 'rust-v0.163.0', revision: sha });
  assert.equal(result.claude.integrity, integrity); assert.equal(result.copilot.package, '@github/copilot');
});
test('peels annotated GitHub tags to a commit', async () => {
  const result = await discoverProviderReleases(fixture((values, github) => {
    values.set(`${github}/git/ref/tags/rust-v0.163.0`, { object: { type: 'tag', sha } });
    values.set(`${github}/git/tags/${sha}`, { object: { type: 'commit', sha: 'b'.repeat(40) } });
  }));
  assert.equal(result.codex.revision, 'b'.repeat(40));
});
test('rejects prereleases, drafts, malformed tags and unresolved tag loops', async () => {
  for (const patch of [{ prerelease: true }, { draft: true }, { tag_name: 'rust-v0.164.0-alpha.1' }, { tag_name: 'v0.163.0' }]) {
    await assert.rejects(discoverProviderReleases(fixture((values, github) => Object.assign(values.get(`${github}/releases/latest`), patch))), /metadata/);
  }
  await assert.rejects(discoverProviderReleases(fixture((values, github) => {
    values.set(`${github}/git/ref/tags/rust-v0.163.0`, { object: { type: 'tag', sha } });
    values.set(`${github}/git/tags/${sha}`, { object: { type: 'tag', sha } });
  })), /metadata/);
});
test('rejects npm prereleases, other origins, wrong identities and weak or invalid integrity', async () => {
  const endpoint = 'https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/2.1.3';
  for (const patch of [{ integrity: 'sha1-aaa' }, { integrity: 'sha512-aaa' }, { tarball: 'http://registry.npmjs.org/@anthropic-ai/claude-code/-/a.tgz' },
    { tarball: 'https://attacker.invalid/a.tgz' }, { tarball: 'https://registry.npmjs.org/@other/pkg/-/a.tgz' },
    { tarball: 'https://registry.npmjs.org/@anthropic-ai/claude-code/-/a.tgz?token=x' }]) {
    await assert.rejects(discoverProviderReleases(fixture(values => Object.assign(values.get(endpoint).dist, patch))), /metadata/);
  }
  await assert.rejects(discoverProviderReleases(fixture(values => { values.get(endpoint).version = '2.1.4'; })), /metadata/);
  await assert.rejects(discoverProviderReleases(fixture(values => { values.get(endpoint.replace('/2.1.3', '/latest')).version = '2.1.4-beta'; })), /metadata/);
});
test('bounds actual streamed bytes and hides invalid response text', async () => {
  await assert.rejects(officialBytes('https://example.invalid', 2, async () => new Response('private body')), /metadata/);
  await assert.rejects(discoverProviderReleases({ fetch: async () => new Response('private body', { status: 500 }) }),
    error => !error.message.includes('private body'));
});
