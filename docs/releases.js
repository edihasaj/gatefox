import { parseSnapshot, publishedReleases, releaseCommands } from './release-data.js';

const compare = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};
const anchor = release => 'v' + release.version.replaceAll('.', '-');
const changedUrl = release => 'changelog.html#' + anchor(release);
const dateLabel = value => new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));
const plain = value => String(value).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/[*\x60]/g, '');
const nodes = selector => [...document.querySelectorAll(selector)];

async function fetchJson(url) {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

function applyLatest(release, newer) {
  for (const node of nodes('[data-release-version]')) {
    node.textContent = release.version;
    if (node.tagName === 'A') node.href = changedUrl(release);
  }
  for (const node of nodes('[data-release-date]')) {
    node.textContent = dateLabel(release.publishedAt);
    node.dateTime = release.publishedAt;
  }
  for (const node of nodes('[data-download]')) node.href = release.appDownloadUrl;
  for (const node of nodes('[data-download-version]')) node.textContent = release.version + ' · Apple silicon';
  for (const node of nodes('[data-release-cli]')) node.textContent = releaseCommands(release);
  for (const node of nodes('[data-release-changelog]')) node.href = changedUrl(release);
  for (const node of nodes('[data-release-link]')) node.href = release.url;
  if (newer) for (const node of nodes('[data-release-summary]')) {
    node.textContent = plain(release.notes.split(/\n\s*\n/)[0] || 'See the release notes.');
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function link(href, text) {
  const node = element('a', '', text);
  node.href = href;
  return node;
}

function historyEntry(release) {
  const article = element('article', 'release-entry');
  article.id = anchor(release);
  article.dataset.releaseTag = release.tag;
  const header = element('header', 'release-entry-header');
  const heading = element('h2');
  heading.append(link('#' + article.id, release.version));
  const time = element('time', '', dateLabel(release.publishedAt));
  time.dateTime = release.publishedAt;
  header.append(heading, time);
  const notes = element('div', 'release-notes');
  for (const block of release.notes.split(/\n\s*\n/).filter(Boolean)) {
    const paragraph = element('p', '', plain(block));
    paragraph.style.whiteSpace = 'pre-line';
    notes.append(paragraph);
  }
  const links = element('p', 'release-links');
  links.append(link(release.url, 'GitHub release ↗'), link(release.appDownloadUrl, 'Download for Mac'));
  article.append(header, notes, links);
  return article;
}

function applyHistory(releases) {
  const history = document.querySelector('[data-release-history]');
  if (!history) return;
  const existing = new Map([...history.querySelectorAll('[data-release-tag]')].map(node => [node.dataset.releaseTag, node]));
  for (const release of releases) if (!existing.has(release.tag)) existing.set(release.tag, historyEntry(release));
  const articles = [...existing.values()].sort((a, b) => compare(b.dataset.releaseTag.slice(1), a.dataset.releaseTag.slice(1)));
  for (const article of articles) for (const badge of article.querySelectorAll('.release-latest')) badge.remove();
  const badge = element('span', 'release-latest', 'Latest release');
  articles[0]?.querySelector('.release-entry-header')?.append(badge);
  history.replaceChildren(...articles);
  const nav = document.querySelector('[data-release-nav]');
  if (nav) nav.replaceChildren(...articles.map(article => link('#' + article.id, article.dataset.releaseTag.slice(1))));
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

export async function refreshReleases() {
  const [snapshot, github] = await Promise.all([
    fetchJson('releases.json'),
    fetchJson('https://api.github.com/repos/edihasaj/gatefox/releases?per_page=100'),
  ]);
  const records = new Map((parseSnapshot(snapshot)?.releases || []).map(release => [release.tag, release]));
  for (const release of publishedReleases(github)) records.set(release.tag, release);
  const releases = [...records.values()].sort((a, b) => compare(b.version, a.version));
  if (!releases.length) return;
  const shown = nodes('[data-release-version]').map(node => node.textContent.match(/\d+\.\d+\.\d+/)?.[0]).filter(Boolean).sort((a, b) => compare(b, a))[0];
  if (shown && compare(releases[0].version, shown) < 0) return;
  applyLatest(releases[0], !shown || compare(releases[0].version, shown) > 0);
  applyHistory(releases);
}

// Missing scripts, offline GitHub and rate limits leave the useful pre-rendered page intact.
if (document.querySelector('[data-release-version], [data-release-history], [data-download]')) await refreshReleases();
