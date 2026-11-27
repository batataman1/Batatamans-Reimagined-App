// The Tasks & Bugs tab (part 2c). Moving around changes the address (#/tasks/f/<folder>,
// #/tasks/t/<task>), so the phone's back button works. The Back button works like the Wiki
// tab's: back to the screen you came from (history.state.tasksDepth > 0), otherwise one level up.

import { store } from '../core/store.js';
import { getWiki } from '../wiki/model.js';
import { getTasks } from '../tasks/model.js';
import { renderTasksView, parseTasksPath } from '../tasks/views.js';

const APP_TITLE = "Batataman's Reimagined";
const PREFS = 'brr.tasks';
const scrollByPath = new Map();
let active = null;

function loadPrefs() {
  const p = { view: 'list', type: 'all', priorities: [], quickType: 'task', sort: 'priority' };
  try { Object.assign(p, JSON.parse(localStorage.getItem(PREFS) || '{}')); } catch { /* ignore */ }
  if (!['list', 'board'].includes(p.view)) p.view = 'list';
  if (!['all', 'task', 'bug'].includes(p.type)) p.type = 'all';
  if (!Array.isArray(p.priorities)) p.priorities = [];
  if (!['task', 'bug'].includes(p.quickType)) p.quickType = 'task';
  if (!['priority', 'difficulty'].includes(p.sort)) p.sort = 'priority';
  return p;
}

export const tasksTab = {
  id: 'tasks', label: 'Tasks & Bugs', icon: 'tasks',

  mount(el, path) {
    let current = path || '';
    let freshVisit = false;
    let depth = history.state?.tasksDepth || 0;
    let token = 0;
    let leaveView = null;
    const ui = {
      query: '',
      prefs: loadPrefs(),
      savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify(ui.prefs)); } catch { /* storage blocked */ } },
      back(parent) {
        if (depth > 0) history.back();
        else location.replace(`#/tasks${parent ? `/${parent}` : ''}`);
      },
      go(p) {
        freshVisit = true;
        location.hash = `#/tasks${p ? `/${p}` : ''}`;
      },
      leaveTo(p) {
        location.replace(`#/tasks${p ? `/${p}` : ''}`);
      },
      /** Done on a task: back to where you came from (even in another tab), or to `fallback`. */
      finish(fallback) {
        if (depth > 0) history.back();
        else location.replace(`#/tasks${fallback ? `/${fallback}` : ''}`);
      },
    };

    async function show({ keepScroll = false } = {}) {
      const mine = ++token;
      if (leaveView) {
        const leave = leaveView;
        leaveView = null;
        await leave();
      }
      const [model, wiki] = await Promise.all([getTasks(), getWiki()]);
      if (mine !== token) return;

      const y = window.scrollY;
      const focused = document.activeElement;
      const focusKey = el.contains(focused) ? focused?.dataset?.focusKey : null;
      const selection = focusKey ? [focused.selectionStart, focused.selectionEnd] : null;
      const boardX = el.querySelector('.tb-board')?.scrollLeft || 0;

      leaveView = renderTasksView(el, current, model, wiki, ui) || null;

      if (keepScroll) {
        window.scrollTo(0, y);
        const b = el.querySelector('.tb-board');
        if (b) b.scrollLeft = boardX;
      } else if (freshVisit || !scrollByPath.has(current)) window.scrollTo(0, 0);
      else window.scrollTo(0, scrollByPath.get(current));
      freshVisit = false;

      if (focusKey) {
        const again = el.querySelector(`[data-focus-key="${focusKey}"]`);
        again?.focus();
        try { again?.setSelectionRange(...selection); } catch { /* not a text field */ }
      }
    }

    const onClick = e => {
      const a = e.target.closest('a[href^="#/tasks"]');
      if (a && a.getAttribute('href') !== location.hash) freshVisit = true;
    };
    el.addEventListener('click', onClick);

    // Redraw when something changes on this device; the task page keeps its own screen while you type.
    let timer = null;
    const editing = () => parseTasksPath(current).view === 'task';
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
          history.replaceState({ ...(history.state || {}), tasksDepth: depth }, '', location.hash);
        } else {
          depth = history.state?.tasksDepth || 0;
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
