// The Ideas tab (part 2c Ideas). Moving around changes the address (#/ideas/s/<section>,
// #/ideas/i/<idea>), so the phone's back button works. The Back button works like the other
// tabs': back to the screen you came from (history.state.ideasDepth > 0), otherwise one level up.

import { store } from '../core/store.js';
import { getWiki } from '../wiki/model.js';
import { getTasks } from '../tasks/model.js';
import { getIdeas } from '../ideas/model.js';
import { renderIdeasView, parseIdeasPath } from '../ideas/views.js';

const APP_TITLE = "Batataman's Reimagined";
const PREFS = 'brr.ideas';
const scrollByPath = new Map();
let active = null;

function loadPrefs() {
  const p = { folded: [] };
  try { Object.assign(p, JSON.parse(localStorage.getItem(PREFS) || '{}')); } catch { /* ignore */ }
  if (!Array.isArray(p.folded)) p.folded = [];
  return p;
}

export const ideasTab = {
  id: 'ideas', label: 'Ideas', icon: 'idea',

  mount(el, path) {
    let current = path || '';
    let freshVisit = false;
    let depth = history.state?.ideasDepth || 0;
    let token = 0;
    let leaveView = null;
    const ui = {
      query: '',
      prefs: loadPrefs(),
      savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify(ui.prefs)); } catch { /* storage blocked */ } },
      isFolded: id => ui.prefs.folded.includes(id),
      toggleFold(id) {
        ui.prefs.folded = ui.isFolded(id) ? ui.prefs.folded.filter(x => x !== id) : [...ui.prefs.folded, id];
        ui.savePrefs();
        show({ keepScroll: true });
      },
      unfold(id) {
        if (!ui.isFolded(id)) return;
        ui.prefs.folded = ui.prefs.folded.filter(x => x !== id);
        ui.savePrefs();
      },
      back(parent) {
        if (depth > 0) history.back();
        else location.replace(`#/ideas${parent ? `/${parent}` : ''}`);
      },
      go(p) {
        freshVisit = true;
        location.hash = `#/ideas${p ? `/${p}` : ''}`;
      },
      leaveTo(p) {
        location.replace(`#/ideas${p ? `/${p}` : ''}`);
      },
      /** Done on an idea: back to where you came from (even in another tab), or to `fallback`. */
      finish(fallback) {
        if (depth > 0) history.back();
        else location.replace(`#/ideas${fallback ? `/${fallback}` : ''}`);
      },
    };

    async function show({ keepScroll = false } = {}) {
      const mine = ++token;
      if (leaveView) {
        const leave = leaveView;
        leaveView = null;
        await leave();
      }
      const [model, tasks, wiki] = await Promise.all([getIdeas(), getTasks(), getWiki()]);
      if (mine !== token) return;

      const y = window.scrollY;
      const focused = document.activeElement;
      const focusKey = el.contains(focused) ? focused?.dataset?.focusKey : null;
      const selection = focusKey ? [focused.selectionStart, focused.selectionEnd] : null;

      leaveView = renderIdeasView(el, current, { model, tasks, wiki, ui }) || null;

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
      const a = e.target.closest('a[href^="#/ideas"]');
      if (a && a.getAttribute('href') !== location.hash) freshVisit = true;
    };
    el.addEventListener('click', onClick);

    // Redraw when something changes on this device; the idea page keeps its own screen while you type.
    let timer = null;
    const editing = () => parseIdeasPath(current).view === 'idea';
    const off = store.on(d => {
      if (d?.type === 'connection' || editing()) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!editing()) show({ keepScroll: true }); }, 120);
    });

    active = {
      navigate(p) {
        clearTimeout(timer);
        scrollByPath.set(current, window.scrollY);
        if (freshVisit) {
          depth += 1;
          history.replaceState({ ...(history.state || {}), ideasDepth: depth }, '', location.hash);
        } else {
          depth = history.state?.ideasDepth || 0;
        }
        current = p || '';
        show();
      },
    };
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    show();

    return () => {
      token++;
      leaveView?.();
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
