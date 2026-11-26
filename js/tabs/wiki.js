// The Wiki tab. Moving around inside it changes the address (#/wiki/p/ostrich), so the
// phone's back button and the browser's back/forward buttons work.

import { store } from '../core/store.js';
import { getWiki } from '../wiki/model.js';
import { renderWikiView } from '../wiki/views.js';

const APP_TITLE = "Batataman's Reimagined";
const scrollByPath = new Map();   // where you were on each screen, for the back button
let active = null;

export const wikiTab = {
  id: 'wiki', label: 'Wiki', icon: 'book',

  mount(el, path) {
    const ui = { query: '' };
    let current = path || '';
    let freshVisit = false;       // true when a link was tapped (start at the top)
    let token = 0;

    async function show({ keepScroll = false } = {}) {
      const mine = ++token;
      const wiki = await getWiki();
      if (mine !== token) return;   // a newer screen was asked for meanwhile

      const y = window.scrollY;
      const focused = document.activeElement;
      const focusKey = el.contains(focused) ? focused?.dataset?.focusKey : null;
      const selection = focusKey ? [focused.selectionStart, focused.selectionEnd] : null;

      renderWikiView(el, current, wiki, ui);

      if (keepScroll) window.scrollTo(0, y);
      else if (freshVisit || !scrollByPath.has(current)) window.scrollTo(0, 0);
      else window.scrollTo(0, scrollByPath.get(current));
      freshVisit = false;

      if (focusKey) {
        const again = el.querySelector(`[data-focus-key="${focusKey}"]`);
        again?.focus();
        try { again?.setSelectionRange(...selection); } catch { /* not a text field */ }
      }
    }

    const onClick = e => {
      if (e.target.closest('a[href^="#/wiki"]')) freshVisit = true;
    };
    el.addEventListener('click', onClick);

    // Redraw when something changes on this device (import, pull, edits).
    let timer = null;
    const off = store.on(d => {
      if (d?.type === 'connection') return;
      clearTimeout(timer);
      timer = setTimeout(() => show({ keepScroll: true }), 120);
    });

    active = {
      navigate(p) {
        scrollByPath.set(current, window.scrollY);
        current = p || '';
        show();
      },
    };
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    show();

    return () => {
      token++;                      // a draw still loading must not land in the next tab
      scrollByPath.set(current, window.scrollY);
      off();
      clearTimeout(timer);
      el.removeEventListener('click', onClick);
      document.title = APP_TITLE;
      active = null;
    };
  },

  navigate(path) {
    active?.navigate(path);
  },
};
