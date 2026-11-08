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
search.addEventListener('input', filter);
search.addEventListener('keydown', event => {
  if (event.key === 'Escape') { search.value = ''; filter(); }
});

links.forEach(link => link.addEventListener('click', () => {
  if (search.value) { search.value = ''; filter(); }
}));
const observer = new IntersectionObserver(entries => {
  const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
  if (!visible) return;
  links.forEach(link => {
    if (link.hash === '#' + visible.target.id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}, { rootMargin: '-10% 0px -55% 0px' });
sections.forEach(section => observer.observe(section));
