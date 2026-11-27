// Reorder a list by dragging each row's ⋮⋮ handle, with the mouse or a finger.
// Works like dragging blocks in the page editor: move 6 px to start, an accent line shows
// where the row will land, and the page scrolls near the top and bottom of the screen.
// A tap or click on the handle without moving still counts as a normal click.

import { h } from '../core/util.js';

/**
 * container: the element holding the rows (its direct children that match `row`). Lists can be
 * nested (a row may hold another sortable list); each list only moves its own rows.
 * onMove(from, to): called after a drop; `to` is the index the row ends up at.
 */
export function sortable(container, { row = '.sort-row', handle = '.sort-handle', onMove }) {
  const indicator = h('div', { class: 'sort-drop', 'aria-hidden': 'true' });
  let justDragged = false;

  // The click that follows a drag isn't a tap on the handle.
  container.addEventListener('click', e => {
    if (justDragged && e.target.closest(handle)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  container.addEventListener('pointerdown', e => {
    const hd = e.target.closest(handle);
    if (!hd || !container.contains(hd) || e.button !== 0) return;
    const rows = () => [...container.children].filter(c => c.matches(row));
    // Only rows of this list (a list inside a row, like sub-folders, handles its own rows).
    const el = hd.closest(row);
    if (!el || el.parentElement !== container) return;

    const startX = e.clientX, startY = e.clientY;
    let dragging = false, target = -1, lastY = startY, raf = 0;
    hd.setPointerCapture?.(e.pointerId);

    const dropIndex = y => {
      const list = rows();
      for (let i = 0; i < list.length; i++) {
        const r = list[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return list.length;
    };
    const showAt = idx => {
      target = idx;
      const list = rows();
      const from = list.indexOf(el);
      const same = idx === from || idx === from + 1;
      indicator.hidden = same;
      if (same) return;
      const top = container.getBoundingClientRect().top;
      const y = idx < list.length ? list[idx].getBoundingClientRect().top - 4 : list[list.length - 1].getBoundingClientRect().bottom + 2;
      indicator.style.top = `${y - top - 1}px`;
    };
    const autoScroll = () => {
      const edge = 70;
      const dy = lastY < edge ? -(edge - lastY) / 4 : lastY > innerHeight - edge ? (lastY - (innerHeight - edge)) / 4 : 0;
      if (dy) { window.scrollBy(0, dy); showAt(dropIndex(lastY)); }
      raf = requestAnimationFrame(autoScroll);
    };
    const move = ev => {
      lastY = ev.clientY;
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        dragging = true;
        document.activeElement?.blur?.();
        el.classList.add('dragging');
        container.classList.add('is-dragging');
        container.append(indicator);
        raf = requestAnimationFrame(autoScroll);
      }
      ev.preventDefault();
      showAt(dropIndex(ev.clientY));
    };
    const end = ev => {
      hd.removeEventListener('pointermove', move);
      hd.removeEventListener('pointerup', end);
      hd.removeEventListener('pointercancel', end);
      cancelAnimationFrame(raf);
      if (!dragging) return;
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 0);
      el.classList.remove('dragging');
      container.classList.remove('is-dragging');
      indicator.remove();
      if (ev.type === 'pointercancel' || target < 0) return;
      const from = rows().indexOf(el);
      if (target === from || target === from + 1) return;
      onMove(from, target > from ? target - 1 : target);
    };
    hd.addEventListener('pointermove', move);
    hd.addEventListener('pointerup', end);
    hd.addEventListener('pointercancel', end);
  });
}
