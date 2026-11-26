// A small floating list (the "/" block menu and the "[[" page picker).
// The text you're typing keeps the focus; the editor forwards arrow keys, Enter and Escape here.

import { h, clear } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { ICONS } from '../config/icons.js';

let active = null;

/** The open popup, or null. */
export const currentPopup = () => active;

export function closePopup() {
  active?.close();
}

/**
 * items: [{ label, hint, icon, onPick }]. rect: where to show it (a DOMRect, page coordinates
 * are worked out here). Returns { setItems, move, pick, close }.
 */
export function openPopup({ rect, items, title, onClose, emptyText = 'Nothing found' }) {
  closePopup();
  const list = h('ul', { class: 'popup-list', role: 'listbox' });
  const box = h('div', { class: 'popup', role: 'dialog', 'aria-label': title || 'Choose' },
    title ? h('div', { class: 'popup-title', text: title }) : null, list);
  // Keep the focus in the text while clicking the list.
  box.addEventListener('pointerdown', e => e.preventDefault());
  document.body.append(box);

  let current = items;
  let index = 0;

  const render = () => {
    clear(list, current.length
      ? current.map((it, i) => h('li', {
          role: 'option', class: `popup-item${i === index ? ' active' : ''}`, 'aria-selected': String(i === index),
          onclick: () => { index = i; api.pick(); },
          onpointermove: () => { if (index !== i) { index = i; render(); } },
        },
          it.icon ? h('span', { class: 'popup-icon' }, icon(ICONS[it.icon] ? it.icon : 'book', { size: 16 })) : null,
          h('span', { class: 'popup-label', text: it.label }),
          it.hint ? h('span', { class: 'popup-hint', text: it.hint }) : null))
      : h('li', { class: 'popup-empty', text: emptyText }));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  const place = r => {
    const vw = document.documentElement.clientWidth;
    const width = Math.min(300, vw - 16);
    box.style.width = `${width}px`;
    const left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + vw - width - 8));
    box.style.left = `${left}px`;
    // Below the text if there's room, otherwise above.
    const below = r.bottom + 6;
    const height = box.offsetHeight || 240;
    const roomBelow = window.innerHeight - below;
    box.style.top = roomBelow > Math.min(height, 200) || r.top < height
      ? `${below + window.scrollY}px`
      : `${r.top + window.scrollY - height - 6}px`;
  };

  const api = {
    box,
    setItems(next) { current = next; index = 0; render(); },
    move(delta) {
      if (!current.length) return;
      index = (index + delta + current.length) % current.length;
      render();
    },
    pick() {
      const it = current[index];
      api.close();
      it?.onPick?.();
    },
    close() {
      if (active !== api) return;
      active = null;
      box.remove();
      document.removeEventListener('pointerdown', outside, true);
      onClose?.();
    },
    place,
  };
  const outside = e => { if (!box.contains(e.target)) api.close(); };
  document.addEventListener('pointerdown', outside, true);
  active = api;
  render();
  place(rect);
  return api;
}

/** The screen position of the text cursor (or the element if there's no better guess). */
export function caretRect(fallbackEl) {
  const sel = window.getSelection();
  if (sel?.rangeCount) {
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(true);
    const rects = r.getClientRects();
    if (rects.length && rects[rects.length - 1].height) return rects[rects.length - 1];
    // An empty spot (e.g. an empty line): use the element the cursor is in.
    const node = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    if (node && fallbackEl.contains(node)) return node.getBoundingClientRect();
  }
  return fallbackEl.getBoundingClientRect();
}
