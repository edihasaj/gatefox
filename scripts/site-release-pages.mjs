import { Marked } from 'marked';
import { releaseCommands } from './site-releases.mjs';

const repository = 'https://github.com/edihasaj/gatefox';
export const releaseAnchor = version => `v${version.replaceAll('.', '-')}`;
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const dateLabel = value => new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));

/** Release prose can come from GitHub; raw HTML and executable links never become active markup. */
export function releaseNotesHtml(notes) {
  const markdown = new Marked({ gfm: true });
  markdown.use({ renderer: {
    html({ text }) { return escape(text); },
    image({ text }) { return escape(text); },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      let url;
      try {
        url = new URL(href, `${repository}/blob/main/`);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return label;
      } catch { return label; }
      return `<a href="${escape(url.href)}">${label}</a>`;
    },
  } });
  return markdown.parse(String(notes || 'See the GitHub release for details.'));
}

export function releaseSummaryHtml(latest) {
  if (!latest) return `<p class="release-summary"><a href="${repository}/releases/latest">Latest release</a> · <a href="changelog.html">Changelog →</a></p>`;
  return `<aside class="release-summary" aria-label="Latest release">
        <div class="release-meta"><span class="release-channel">Latest release</span><a class="release-version" data-release-version href="changelog.html#${releaseAnchor(latest.version)}">${escape(latest.version)}</a><time data-release-date datetime="${escape(latest.publishedAt)}">${dateLabel(latest.publishedAt)}</time></div>
        <div class="release-preview" data-release-summary data-release-notes>${releaseNotesHtml(latest.notes.split(/\n\s*\n/)[0])}</div>
        <div class="release-links"><a data-release-changelog href="changelog.html#${releaseAnchor(latest.version)}">What changed →</a><a data-release-link href="${escape(latest.url)}">GitHub release ↗</a></div>
      </aside>`;
}

export function releaseHistoryHtml(releases) {
  return releases.map((release, index) => `<article class="release-entry" data-release-tag="${escape(release.tag)}" id="${releaseAnchor(release.version)}">
      <header class="release-entry-header"><h2><a href="#${releaseAnchor(release.version)}">${escape(release.version)}</a></h2>${index === 0 ? '<span class="release-latest">Latest release</span>' : ''}<time datetime="${escape(release.publishedAt)}">${dateLabel(release.publishedAt)}</time></header>
      <div class="release-notes">${releaseNotesHtml(release.notes)}</div>
      <p class="release-links"><a href="${escape(release.url)}">GitHub release ↗</a><a href="${escape(release.appDownloadUrl)}">Download for Mac</a></p>
    </article>`).join('\n');
}

/** The same release drives both download buttons and the copyable install commands. */
export function releaseCli(release) {
  return releaseCommands(release);
}

export function applyReleaseData(html, data) {
  const latest = data.latest;
  let result = html.replace(/<!-- release-summary -->[\s\S]*?<!-- \/release-summary -->|<!-- release-summary -->/, releaseSummaryHtml(latest));
  if (!latest) return result;
  result = result.replace(/(<a\b[^>]*\bdata-download\b[^>]*\bhref=")[^"]*(")/g, (_, before, after) => before + escape(latest.appDownloadUrl) + after);
  result = result.replace(/(<span\b[^>]*\bdata-download-version\b[^>]*>)[\s\S]*?(<\/span>)/g, (_, before, after) => `${before}${escape(latest.version)} · Apple silicon${after}`);
  result = result.replace(/(<span\b[^>]*\bdata-release-version\b[^>]*>)[^<]*(<\/span>)/g, (_, before, after) => before + escape(latest.version) + after);
  result = result.replace(/(<a\b[^>]*\bdata-release-version\b[^>]*\bhref=")[^"]*("[^>]*>)[^<]*(<\/a>)/g, (_, before, middle, after) => `${before}changelog.html#${releaseAnchor(latest.version)}${middle}${escape(latest.version)}${after}`);
  result = result.replace(/<time\b[^>]*\bdata-release-date\b[^>]*>[^<]*<\/time>/g, `<time data-release-date datetime="${escape(latest.publishedAt)}">${dateLabel(latest.publishedAt)}</time>`);
  result = result.replace(/(<a\b[^>]*\bdata-release-changelog\b[^>]*\bhref=")[^"]*(")/g, (_, before, after) => `${before}changelog.html#${releaseAnchor(latest.version)}${after}`);
  result = result.replace(/(<code\b[^>]*\bdata-release-cli\b[^>]*>)[\s\S]*?(<\/code>)/g, (_, before, after) => before + escape(releaseCli(latest)) + after);
  return result;
}
