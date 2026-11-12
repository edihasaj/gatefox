// Release data for the gatefox.dev landing page and changelog page.
//
// This module imports nothing — not even `node:*` — so the same file the builder requires is the
// file the builder copies to the site as `release-data.js` and `releases.js` imports in the
// browser. It also touches no network and no disk: the deploy step fetches the real list
// (`gh api repos/edihasaj/gatefox/releases?per_page=100`), hands it to `publishedReleases`, and the
// builder injects the result into the page. A local build can pass the committed snapshot instead.
//
// A release counts as a published macOS app release only when its tag, its version, and the whole
// GateFox (or, before 1.8.0, Harness Gateway) asset set agree, and every download URL points at our
// own repository over HTTPS. Releases that are drafts, prereleases, incomplete, or carry a URL we
// did not build are dropped rather than shown.

export const REPOSITORY = 'edihasaj/gatefox';
export const appUpdateManifestAsset = 'app-update.json';
/** The first version that publishes GateFox names; earlier releases keep the Harness Gateway set. */
const GATEFOX_NAMES_FROM = [1, 8, 0];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const parts = version => {
  const values = VERSION.exec(version)?.slice(1, 4).map(Number);
  return values?.every(Number.isSafeInteger) ? values : undefined;
};
const compare = (a, b) => {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
};
/** Three plain numbers with no leading zeros and no suffix — the only tags the site links. */
export const isCanonicalVersion = version => Boolean(parts(typeof version === 'string' ? version : ''));

/**
 * Our release policy caps minor and patch at 9 (`npm run version:next`). Older releases published
 * before that rule exist with a larger patch, and history must stay visible, so this is opt-in:
 * pass `{ applyVersionPolicy: true }` to keep a future list to the policy.
 */
const withinPolicy = (version, options) =>
  options.applyVersionPolicy !== true || (() => { const p = parts(version); return p[1] <= 9 && p[2] <= 9; })();

/** The app ZIP, `app-update.json` and backend archive a release of this version must carry. */
export function expectedAssets(version, repository) {
  const parsed = parts(version);
  if (!parsed || !REPO.test(String(repository ?? REPOSITORY))) return undefined;
  const legacy = compare(parsed, GATEFOX_NAMES_FROM) < 0;
  const app = legacy ? 'Harness-Gateway' : 'GateFox', backend = legacy ? 'harness-gateway' : 'gatefox';
  return {
    kind: legacy ? 'legacy' : 'gatefox',
    appAsset: `${app}-${version}-macos-arm64.zip`,
    manifestAsset: appUpdateManifestAsset,
    backendAsset: `${backend}-${version}-macos-arm64.tar.gz`,
  };
}

/** The only download URL we will show for one asset, and the shape its asset must have. */
export function downloadUrl(tag, assetName, repository = REPOSITORY) {
  if (!/^v\d+\.\d+\.\d+$/.test(String(tag)) || !/^[A-Za-z0-9._-]+$/.test(String(assetName))) return undefined;
  if (!REPO.test(String(repository))) return undefined;
  return `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
}

/** True only when the URL is exactly the expected GitHub download for this tag and asset. */
function isSafeDownloadUrl(value, tag, assetName, repository) {
  const expected = downloadUrl(tag, assetName, repository);
  if (!expected || typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.href === expected;
}

const isoDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return undefined;
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return undefined;
  const time = new Date(value.includes('T') || value.includes(' ') ? value.replace(' ', 'T') : `${value}T00:00:00Z`);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
};

/** Every `## X.Y.Z — YYYY-MM-DD` section of CHANGELOG.md, oldest first. `Unreleased` is skipped. */
export function parseChangelog(text) {
  if (typeof text !== 'string') return [];
  const entries = [];
  const headings = [...text.matchAll(/^##\s+(.+)$/gm)];
  headings.forEach((heading, index) => {
    const title = heading[1].trim();
    const [headingVersion, headingDate] = title.split(/\s+[—–-]\s+/);
    const version = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(headingVersion.trim())?.[0]?.replace(/^v/, '');
    if (!version) return;
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? text.length;
    const body = text.slice(start, end).trim();
    const date = isoDate(headingDate?.trim());
    entries.push({ version, date, notes: body });
  });
  return entries;
}

/** The changelog section written for this exact version, if the checkout has one. */
export function changelogFor(changelog, version) {
  const entries = typeof changelog === 'string' ? parseChangelog(changelog) : Array.isArray(changelog) ? changelog : [];
  return entries.find(entry => entry?.version === version && typeof entry.notes === 'string');
}

/** The names inside `app-update.json`, when the caller injected them; they must agree with the tag. */
function manifestAgrees(manifest, expected, expectedVersion) {
  if (manifest === undefined || manifest === null) return true;
  if (typeof manifest === 'string') { try { manifest = JSON.parse(manifest); } catch { return false; } }
  if (typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  const value = key => (typeof manifest[key] === 'string' ? manifest[key] : manifest.assets?.[key]?.name ?? manifest[key === 'app' ? 'appAsset' : 'backendAsset']);
  const version = typeof manifest.version === 'string' ? manifest.version.replace(/^v/, '') : undefined;
  const app = value('app'), backend = value('backend');
  return version === expectedVersion && app === expected.appAsset && backend === expected.backendAsset;
}

function asset(list, name, tag, assetName, repository) {
  const matches = list.filter(entry => entry?.name === assetName);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0]?.size) || matches[0].size <= 0 || matches[0].state !== 'uploaded') return { reason: `missing-${name}` };
  if (!matches.every(entry => isSafeDownloadUrl(entry.browser_download_url, tag, assetName, repository))) {
    return { reason: `unsafe-${name}-url` };
  }
  return { asset: matches[0] };
}

/**
 * One record for the site, or null when the release is not a published macOS app release.
 * `changelog` is raw CHANGELOG.md text or `parseChangelog` output; its section wins over the
 * GitHub body, so a version this checkout has not merged yet falls back to the published body.
 * `notes` is Markdown: the caller owns escaping it.
 */
export function normalizeRelease(release, changelog, options = {}) {
  const repository = options.repository ?? REPOSITORY;
  const tag = release?.tag_name, version = typeof tag === 'string' ? tag.slice(1) : '';
  if (!REPO.test(String(repository)) || typeof tag !== 'string' || tag !== `v${version}` || !isCanonicalVersion(version)) return null;
  if (!withinPolicy(version, options)) return null;
  if (release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) return null;
  const declared = typeof release.name === 'string' ? /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release.name.trim())?.[1] : undefined;
  if (declared && declared !== version) return null;
  const expected = expectedAssets(version, repository);
  if (!expected) return null;
  const app = asset(release.assets, 'app', tag, expected.appAsset, repository);
  const manifest = asset(release.assets, 'manifest', tag, expected.manifestAsset, repository);
  const backend = asset(release.assets, 'backend', tag, expected.backendAsset, repository);
  const checksums = asset(release.assets, 'checksums', tag, 'SHA256SUMS', repository);
  if (app.reason || manifest.reason || backend.reason || checksums.reason) return null;
  if (!manifestAgrees(release.appUpdateManifest, expected, version)) return null;
  const publishedAt = isoDate(release.published_at);
  if (!publishedAt) return null;
  const url = `https://github.com/${repository}/releases/tag/${tag}`;
  if (release.html_url !== undefined && release.html_url !== url) return null;
  const entry = changelogFor(changelog, version);
  const notes = (entry && (!entry.date || entry.date.slice(0, 10) === publishedAt.slice(0, 10)) ? entry.notes : release.body) ?? '';
  return {
    version, tag, url, publishedAt,
    appAssetName: expected.appAsset,
    backendAssetName: expected.backendAsset,
    appDownloadUrl: downloadUrl(tag, expected.appAsset, repository),
    backendDownloadUrl: downloadUrl(tag, expected.backendAsset, repository),
    notes: String(notes),
  };
}

/** Every valid published app release, newest first, newest policy aside. Empty when the list holds none. */
export function publishedReleases(list, changelog, options = {}) {
  if (!Array.isArray(list)) return [];
  const newestFirst = (left, right) => {
    const a = parts(left.version), b = parts(right.version);
    for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return b[index] - a[index];
    return String(right.publishedAt).localeCompare(String(left.publishedAt));
  };
  const sorted = list.map(release => normalizeRelease(release, changelog, options)).filter(Boolean).sort(newestFirst);
  return sorted.filter((release, index) => sorted.findIndex(other => other.tag === release.tag) === index);
}

/** The `docs/releases.json` shape the builder commits and a local build can read back. */
export function snapshotFromReleases(releases) {
  const list = Array.isArray(releases) ? releases.filter(Boolean) : [];
  return { repository: REPOSITORY, latest: list[0] ?? null, releases: list };
}

/** A committed snapshot, re-validated: a hand-edited or stale file yields null, not bad links. */
export function parseSnapshot(text, options = {}) {
  let parsed;
  try { parsed = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!parsed || parsed.repository !== (options.repository ?? REPOSITORY) || !Array.isArray(parsed.releases)) return null;
  // A snapshot records the two linked assets only; `app-update.json` was checked when it was written,
  // and the deploy step re-validates every record against the live list.
  const releases = publishedReleases(parsed.releases.map(record => ({
    tag_name: record?.tag, html_url: record?.url, published_at: record?.publishedAt, body: record?.notes, draft: false, prerelease: false,
    assets: [{ name: record?.appAssetName, browser_download_url: record?.appDownloadUrl, size: 1, state: 'uploaded' },
      { name: record?.backendAssetName, browser_download_url: record?.backendDownloadUrl, size: 1, state: 'uploaded' },
      { name: appUpdateManifestAsset, browser_download_url: downloadUrl(record?.tag, appUpdateManifestAsset, options.repository ?? REPOSITORY), size: 1, state: 'uploaded' },
      { name: 'SHA256SUMS', browser_download_url: downloadUrl(record?.tag, 'SHA256SUMS', options.repository ?? REPOSITORY), size: 1, state: 'uploaded' }],
  })), undefined, options);
  const expected = snapshotFromReleases(releases);
  if (parsed.latest !== null && parsed.latest !== undefined && parsed.latest?.version !== expected.latest?.version) return null;
  return expected.releases.length ? expected : null;
}

/** Copyable install commands share exactly the version and archive chosen for the app download. */
export function releaseCommands(release) {
  if (!release) return 'gh release view --repo edihasaj/gatefox';
  const prefix = release.backendAssetName.startsWith('gatefox-') ? 'gatefox' : 'harness-gateway';
  return ['VERSION=' + release.version,
    'gh release download "v$VERSION" -R edihasaj/gatefox \\',
    "  --pattern '" + prefix + "-*-macos-arm64.tar.gz' --pattern SHA256SUMS",
    'shasum -a 256 --ignore-missing -c SHA256SUMS',
    'tar -xzf "' + prefix + '-$VERSION-macos-arm64.tar.gz"',
    '"./' + prefix + '-$VERSION-macos-arm64/install"', 'gateway --version'].join('\n');
}
