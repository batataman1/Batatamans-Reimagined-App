// The Wiki tab. Moving around inside it changes the address (#/wiki/p/ostrich), so the
// phone's back button and the browser's back/forward buttons work.
//
// The on-screen Back button: each history entry reached by tapping a link inside the app is
// tagged with how many steps it is from where you started (history.state.wikiDepth). If that's
// more than 0, Back is the browser's back. Otherwise (the screen was opened directly, from a
// bookmark, a tab button or after a reload) Back goes one level up instead of leaving the app.

import { store } from '../core/store.js';
import { getWiki } from '../wiki/model.js';
import { renderWikiView, parseWikiPath } from '../wiki/views.js';

const APP_TITLE = "Batataman's Reimagined";
const scrollByPath = new Map();   // where you were on each screen, for the back button
let active = null;

export const wikiTab = {
  id: 'wiki', label: 'Wiki', icon: 'book',

  mount(el, path) {
    let current = path || '';
    let freshVisit = false;       // true when a link was tapped (start at the top)
    let depth = history.state?.wikiDepth || 0;
    let cameFrom = null;          // the screen before the current one, when reached by a link
    let token = 0;
    let leaveView = null;         // what the current screen wants done when you leave it (the editor saves)
    const ui = {
      query: '',
      back(parent) {
        if (depth > 0) history.back();
        else location.replace(`#/wiki${parent ? `/${parent}` : ''}`);
      },
      /** Open another screen as if a link was tapped. */
      go(p) {
        freshVisit = true;
        location.hash = `#/wiki/${p}`;
      },
      /** Replace this screen with another one (it won't come back with Back). */
      leaveTo(p) {
        location.replace(`#/wiki${p ? `/${p}` : ''}`);
      },
      /** Done editing: back to the page you came from, or open the page. */
      finishEdit(id) {
        if (depth > 0 && cameFrom === `p/${id}`) history.back();
        else location.replace(`#/wiki/p/${id}`);
      },
    };

    async function show({ keepScroll = false } = {}) {
      const mine = ++token;
      if (leaveView) {
        const leave = leaveView;
        leaveView = null;
        await leave();
      }
      const wiki = await getWiki();
      if (mine !== token) return;   // a newer screen was asked for meanwhile

      const y = window.scrollY;
      const focused = document.activeElement;
      const focusKey = el.contains(focused) ? focused?.dataset?.focusKey : null;
      const selection = focusKey ? [focused.selectionStart, focused.selectionEnd] : null;

      leaveView = renderWikiView(el, current, wiki, ui) || null;

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
    // The editor keeps its own screen; redrawing it would interrupt typing.
    const editing = () => parseWikiPath(current).view === 'edit';
    const off = store.on(d => {
      if (d?.type === 'connection' || editing()) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!editing()) show({ keepScroll: true }); }, 120);
    });

    active = {
      navigate(p) {
        clearTimeout(timer);        // a redraw of the old screen isn't needed anymore
        scrollByPath.set(current, window.scrollY);
        if (freshVisit) {
          cameFrom = current;
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
      leaveView?.();                // e.g. the editor saves what's left to save
      leaveView = null;
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
