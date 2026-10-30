// Keep the built gallery as a fallback; online saves are read fresh on each visit.
const gallery = document.querySelector('#public-gallery');
const count = document.querySelector('#artwork-count');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function refreshGallery() {
  try {
    const response = await fetch('/portfolio-data', { cache: 'no-store' });
    if (!response.ok) return;
    const { artworks } = await response.json();
    if (!Array.isArray(artworks) || artworks.some((art) => typeof art.title !== 'string'
      || typeof art.image !== 'string' || !/^\/(?!\/)[a-zA-Z0-9_./-]+\.(?:jpe?g|png|gif|webp)$/i.test(art.image))) return;
    const figures = artworks.map((art, index) => {
      const figure = element('figure');
      const link = element('a');
      link.href = art.image;
      link.setAttribute('aria-label', `View ${art.title} full size`);
      const image = element('img');
      image.src = art.image;
      image.alt = art.title;
      image.loading = index === 0 ? 'eager' : 'lazy';
      image.decoding = 'async';
      link.append(image);
      const caption = element('figcaption');
      const text = element('span', 'caption-text');
      text.append(element('span', 'work-number', `No. ${String(index + 1).padStart(2, '0')}`), element('span', 'work-title', art.title));
      const arrow = element('span', 'work-arrow', '↗');
      arrow.setAttribute('aria-hidden', 'true');
      caption.append(text, arrow);
      figure.append(link, caption);
      return figure;
    });
    gallery.replaceChildren(...(figures.length ? figures : [element('p', 'empty', 'New artwork is on its way. Check back soon.')]));
    count.textContent = `${artworks.length} ${artworks.length === 1 ? 'piece' : 'pieces'}`;
  } catch { /* Local previews and temporary network failures retain the built gallery. */ }
}

await refreshGallery();
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshGallery(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) refreshGallery(); });
