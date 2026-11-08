const sections = [...document.querySelectorAll('[data-section]')];
const links = [...document.querySelectorAll('nav a')];
const search = document.querySelector('#search');
const status = document.querySelector('#search-status');

document.querySelectorAll('pre').forEach(pre => {
  const button = document.createElement('button');
  button.className = 'copy';
  button.type = 'button';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy terminal commands');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector('code').textContent);
      button.textContent = 'Copied';
      button.dataset.state = 'success';
    } catch {
      button.textContent = 'Select to copy';
      button.dataset.state = 'error';
      const range = document.createRange();
      range.selectNodeContents(pre.querySelector('code'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setTimeout(() => { button.textContent = 'Copy'; delete button.dataset.state; }, 2000);
  });
  pre.append(button);
});

function filter() {
  const query = search.value.trim().toLowerCase();
  let count = 0;
  let cardCount = 0;
  sections.forEach(section => {
    // A section of topic cards (the All docs page) filters card by card.
    const cards = [...section.querySelectorAll('.card')];
    let matches;
    if (cards.length && !section.querySelector('pre')) {
      let shown = 0;
      cards.forEach(card => { card.hidden = !!query && !card.textContent.toLowerCase().includes(query); if (!card.hidden) shown++; });
      matches = shown > 0 || !query;
      if (query) cardCount += shown;
    } else matches = !query || section.textContent.toLowerCase().includes(query);
    section.hidden = !matches;
    if (matches) count++;
    const link = links.find(link => link.hash === '#' + section.id);
    if (link) link.hidden = !matches;
  });
  status.hidden = !query;
  const found = cardCount || count;
  const unit = cardCount ? 'topic' : 'section';
  status.textContent = count ? `${found} matching ${unit}${found === 1 ? '' : 's'}. Clear search to see everything.` : 'Nothing matches. Try Claude, SSH, or service.';
}
if (search) {
  search.addEventListener('input', filter);
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { search.value = ''; filter(); }
  });
  links.forEach(link => link.addEventListener('click', () => {
    if (search.value) { search.value = ''; filter(); }
  }));
}
// Doc pages have no sections; their sidebar follows the h2 headings instead.
const tracked = sections.length ? sections : [...document.querySelectorAll('.prose h2[id]')];
const observer = new IntersectionObserver(entries => {
  const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
  if (!visible) return;
  links.forEach(link => {
    if (link.hash === '#' + visible.target.id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}, { rootMargin: '-10% 0px -55% 0px' });
tracked.forEach(section => observer.observe(section));

// Point the download button at the newest release's exact, versioned app ZIP.
// Without network access it keeps linking to the Releases page.
const download = document.querySelector('[data-download]');
if (download) {
  fetch('https://api.github.com/repos/edihasaj/gatefox/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(response => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
    .then(release => {
      const app = (release.assets || []).find(asset => /^(GateFox|Harness-Gateway)-\d+\.\d+\.\d+-macos-arm64\.zip$/.test(asset.name));
      if (!app || !/^https:\/\/github\.com\//.test(app.browser_download_url)) return;
      download.href = app.browser_download_url;
      const version = download.querySelector('[data-download-version]');
      if (version) version.textContent = `${String(release.tag_name).replace(/^v/, '')} · Apple silicon`;
    })
    .catch(() => {});
}
