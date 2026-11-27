// The app frame: header, tabs (top on wide screens, bottom on phones), Pull/Push, theme, settings.

import { h, clear } from '../core/util.js';
import { store } from '../core/store.js';
import { loadConnection } from '../core/sync.js';
import { APP_NAME } from '../config/app.js';
import { TABS } from '../tabs/index.js';
import { icon, potato } from './icons.js';
import { toggleMode, currentMode, onThemeChange } from './theme.js';
import { openSettings, connectForm } from './settings.js';
import { doPull, doPush } from './syncui.js';

const LAST_TAB = 'brr.lastTab';
const LAST_PATHS = 'brr.lastPaths';

// Addresses look like #/wiki/p/ostrich : the tab id, then a path inside the tab.
function parseHash(hash) {
  const parts = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  return { id: parts[0] || '', path: parts.slice(1).join('/') };
}

function loadLastPaths() {
  try { return JSON.parse(localStorage.getItem(LAST_PATHS) || '{}') || {}; } catch { return {}; }
}

export function mountShell(root) {
  const view = h('main', { id: 'view', class: 'view', role: 'tabpanel', tabindex: '-1' });
  const welcome = h('div', { class: 'welcome-host' });
  const badge = h('span', { class: 'badge', hidden: true });

  const tabButtons = TABS.map(t => h('button', {
    type: 'button', class: 'tab', role: 'tab', id: `tab-${t.id}`, 'aria-controls': 'view',
    dataset: { tab: t.id },
    // A second tap on the open tab goes back to that tab's start.
    onclick: () => go(t.id, t.id === current ? '' : null),
  }, icon(t.icon, { size: 28 }), h('span', { class: 'tab-label', text: t.label })));

  const tablist = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Sections', onkeydown: onTabKey }, tabButtons);

  const themeBtn = h('button', { type: 'button', class: 'icon-btn', onclick: toggleMode });
  const renderThemeBtn = () => {
    const dark = currentMode() === 'dark';
    clear(themeBtn, icon(dark ? 'sun' : 'moon', { size: 24 }));
    themeBtn.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
    themeBtn.title = themeBtn.getAttribute('aria-label');
  };
  renderThemeBtn();
  onThemeChange(renderThemeBtn);

  const header = h('header', { class: 'topbar' },
    h('div', { class: 'brand', title: APP_NAME }, potato(32),
      h('span', { class: 'brand-name' }, h('span', { text: "Batataman's" }), ' ', h('span', { class: 'brand-sub', text: 'Reimagined' }))),
    tablist,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'sync-btn', title: 'Pull: get the latest from GitHub', onclick: doPull },
        icon('pull', { size: 24 }), h('span', { class: 'sync-label', text: 'Pull' })),
      h('button', { type: 'button', class: 'sync-btn', title: 'Push: send this device\'s changes to GitHub', onclick: doPush },
        icon('push', { size: 24 }), h('span', { class: 'sync-label', text: 'Push' }), badge),
      themeBtn,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', onclick: () => openSettings() },
        icon('sliders', { size: 24 })),
    ),
  );

  clear(root, header, h('div', { class: 'stage' }, welcome, view));

  /* ---------- Tabs ---------- */

  let cleanup = null;
  let current = null;
  const lastPaths = loadLastPaths();

  /** Open a tab. path null = where you last were in that tab, '' = the tab's start. */
  function go(id, path = null, { focus = false } = {}) {
    if (!TABS.some(t => t.id === id)) { id = TABS[0].id; path = null; }
    if (path === null) path = lastPaths[id] || '';
    const hash = `#/${id}${path ? `/${path}` : ''}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    render(id, path, focus);
  }

  function render(id, path, focus) {
    lastPaths[id] = path;
    try { localStorage.setItem(LAST_PATHS, JSON.stringify(lastPaths)); } catch { /* storage full or blocked */ }
    const tab = TABS.find(t => t.id === id);
    if (id === current) {
      tab.navigate?.(path);
      return;
    }
    current = id;
    localStorage.setItem(LAST_TAB, id);
    tabButtons.forEach(b => {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    view.setAttribute('aria-labelledby', `tab-${id}`);
    cleanup?.();
    clear(view);
    cleanup = tab.mount(view, path) || null;
    if (focus) tabButtons.find(b => b.dataset.tab === id)?.focus();
  }

  function onTabKey(e) {
    const i = TABS.findIndex(t => t.id === current);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % TABS.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + TABS.length) % TABS.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    go(TABS[next].id, null, { focus: true });
  }

  // Links inside tabs (and the phone's back button) change the address; follow it.
  window.addEventListener('hashchange', () => {
    const { id, path } = parseHash(location.hash);
    if (TABS.some(t => t.id === id)) render(id, path, false);
    else go(TABS[0].id);
  });
  const start = parseHash(location.hash);
  if (TABS.some(t => t.id === start.id)) go(start.id, start.path);
  else go(localStorage.getItem(LAST_TAB) || TABS[0].id);

  /* ---------- Push badge ---------- */

  let pending = 0;
  const refreshBadge = async () => {
    pending = await store.pendingCount();
    badge.hidden = pending === 0;
    badge.textContent = pending > 99 ? '99+' : String(pending);
    badge.setAttribute('aria-label', `${pending} not pushed`);
  };
  let t = null;
  store.on(() => { clearTimeout(t); t = setTimeout(refreshBadge, 150); });
  refreshBadge();

  /* ---------- Welcome / connect card ---------- */

  const renderWelcome = async () => {
    const conn = await loadConnection();
    const dismissed = await store.getMeta('welcomeDismissed', false);
    clear(welcome);
    if (conn || dismissed) return;
    welcome.append(h('section', { class: 'welcome', 'aria-labelledby': 'welcome-h' },
      h('div', { class: 'welcome-text' },
        h('h2', { id: 'welcome-h', text: 'Connect this device to GitHub' }),
        h('p', { text: 'Paste this device\'s access token to sync your wiki, tasks and ideas between your PC, laptop and phone. Everything also works offline without it.' }),
        h('button', {
          type: 'button', class: 'btn btn-quiet btn-small',
          onclick: async () => { await store.setMeta('welcomeDismissed', true); renderWelcome(); },
        }, 'Not now'),
      ),
      connectForm({ compact: true, onSaved: renderWelcome }),
    ));
  };
  renderWelcome();
  store.on(d => { if (d.type === 'connection') renderWelcome(); });
}
