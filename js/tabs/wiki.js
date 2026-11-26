// The Wiki tab. Moving around inside it changes the address (#/wiki/p/ostrich), so the
// phone's back button and the browser's back/forward buttons work.
//
// The on-screen Back button: each history entry reached by tapping a link inside the app is
// tagged with how many steps it is from where you started (history.state.wikiDepth). If that's
// more than 0, Back is the browser's back. Otherwise (the screen was opened directly, from a
// bookmark, a tab button or after a reload) Back goes one level up instead of leaving the app.

import { store } from '../core/store.js';
import { getWiki } from '../wiki/model.js';
import { renderWikiView } from '../wiki/views.js';

const APP_TITLE = "Batataman's Reimagined";
const scrollByPath = new Map();   // where you were on each screen, for the back button
let active = null;

export const wikiTab = {
  id: 'wiki', label: 'Wiki', icon: 'book',

  mount(el, path) {
    let current = path || '';
    let freshVisit = false;       // true when a link was tapped (start at the top)
    let depth = history.state?.wikiDepth || 0;
    let token = 0;
    const ui = {
      query: '',
      back(parent) {
        if (depth > 0) history.back();
        else location.replace(`#/wiki${parent ? `/${parent}` : ''}`);
      },
    };

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
      const a = e.target.closest('a[href^="#/wiki"]');
      if (a && a.getAttribute('href') !== location.hash) freshVisit = true;
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
        if (freshVisit) {
          depth += 1;
          history.replaceState({ ...(history.state || {}), wikiDepth: depth }, '', location.hash);
        } else {
          depth = history.state?.wikiDepth || 0;
        }
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
