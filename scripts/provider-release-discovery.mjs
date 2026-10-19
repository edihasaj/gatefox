const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const invalid = () => Error('Official stable provider release metadata is unavailable or invalid');

export async function officialBytes(url, maximum, fetcher = globalThis.fetch) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Accept: 'application/json', 'User-Agent': 'harness-gateway-maintenance' } });
  if (!response.ok || Number(response.headers.get('content-length')) > maximum) throw invalid();
  const chunks = []; let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximum) throw invalid();
      chunks.push(Buffer.from(chunk));
    }
  } catch { throw invalid(); }
  return Buffer.concat(chunks);
}

export async function discoverProviderReleases({ fetch: fetcher = globalThis.fetch } = {}) {
  const json = async url => {
    try { return JSON.parse((await officialBytes(url, 2 * 1024 * 1024, fetcher)).toString('utf8')); }
    catch { throw invalid(); }
  };
  const github = 'https://api.github.com/repos/openai/codex';
  const release = await json(`${github}/releases/latest`);
  const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^rust-v/, '') : '';
  if (release.draft !== false || release.prerelease !== false || !stable.test(version) || release.tag_name !== `rust-v${version}`) throw invalid();
  let object = (await json(`${github}/git/ref/tags/${release.tag_name}`)).object;
  for (let count = 0; object?.type === 'tag' && count < 4; count++) {
    if (!/^[a-f0-9]{40}$/.test(object.sha)) throw invalid();
    object = (await json(`${github}/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) throw invalid();
  const npm = async name => {
    const endpoint = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const latest = await json(`${endpoint}/latest`);
    if (latest.name !== name || !stable.test(latest.version)) throw invalid();
    const exact = await json(`${endpoint}/${latest.version}`);
    const integrity = exact.dist?.integrity;
    const url = new URL(exact.dist?.tarball ?? 'https://invalid.invalid');
    if (exact.name !== name || exact.version !== latest.version || url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' ||
      url.port || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith(`/${name}/-/`) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity ?? '') ||
      Buffer.from(integrity.slice(7), 'base64').length !== 64 ||
      Buffer.from(integrity.slice(7), 'base64').toString('base64') !== integrity.slice(7)) throw invalid();
    return { package: name, version: exact.version, tarball: url.href, integrity };
  };
  const [claude, copilot] = await Promise.all([npm('@anthropic-ai/claude-code'), npm('@github/copilot')]);
  return { codex: { version, tag: release.tag_name, revision: object.sha }, claude, copilot };
}
