// Pieces shared by the wiki's reading screens and the editor.

import { h, clear } from '../core/util.js';
import { store } from '../core/store.js';
import { ICONS } from '../config/icons.js';
import { icon } from '../ui/icons.js';

export const safeIcon = (name, size) => icon(ICONS[name] ? name : 'book', { size });

/**
 * The row above each screen's title: a Back button (PC only) and the path to this screen.
 * Back returns to the screen you came from; if you opened this screen directly,
 * it goes one level up (parent is the address of that level, after #/wiki/).
 */
export function topNav(ui, parent, ...items) {
  const parts = [];
  items.forEach((it, i) => {
    if (i) parts.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '›' }));
    parts.push(it.href ? h('a', { href: it.href, text: it.label }) : h('span', { text: it.label }));
  });
  return h('div', { class: 'wiki-nav' },
    h('button', {
      type: 'button', class: 'btn btn-small back-btn', title: 'Back to where you came from',
      onclick: () => ui.back(parent),
    }, icon('back', { size: 16 }), 'Back'),
    h('nav', { class: 'crumbs', 'aria-label': 'You are here' }, parts));
}

/* Pictures are files on this device (synced through files/ in the data repo). */
const urls = new Map();
store.on(d => {
  if (d?.type === 'file' && d.path) {
    const u = urls.get(d.path);
    if (u) { URL.revokeObjectURL(u); urls.delete(d.path); }
  } else if (d?.type === 'sync') {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
  }
});

/**
 * A picture from this device's files, or a placeholder.
 * Small pictures (textures, pixel art) are scaled up with sharp pixels.
 */
export function fileImage(path, alt, { className = '', placeholder = 'No picture yet', size = 28 } = {}) {
  const box = h('span', { class: `pic ${className}`.trim() });
  const showPlaceholder = text => {
    box.classList.add('is-empty');
    clear(box, h('span', { class: 'pic-empty' }, icon('image', { size }), text ? h('span', { text }) : null));
  };
  if (!path) { showPlaceholder(placeholder); return box; }
  showPlaceholder('');
  (async () => {
    let url = urls.get(path);
    if (!url) {
      const f = await store.getFile(path);
      if (!f?.blob) { showPlaceholder('Picture not on this device yet'); return; }
      url = URL.createObjectURL(f.blob);
      urls.set(path, url);
    }
    const img = h('img', { src: url, alt: alt || '', decoding: 'async' });
    img.addEventListener('load', () => {
      if (img.naturalWidth <= 256 && img.naturalHeight <= 256) img.classList.add('pixel');
    });
    box.classList.remove('is-empty');
    clear(box, img);
  })();
  return box;
}
