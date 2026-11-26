// Starts the app.

import { store } from './core/store.js';
import { h } from './core/util.js';
import { applyTheme } from './ui/theme.js';
import { initInstall } from './ui/install.js';
import { mountShell } from './ui/shell.js';
import { toast } from './ui/dialogs.js';

async function main() {
  applyTheme();
  initInstall();
  await store.open();
  mountShell(document.getElementById('app'));
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    if (!reg) return;
    const offerUpdate = worker => {
      toast('A new version of the app is ready.', {
        action: { label: 'Reload', sticky: true, onClick: () => worker.postMessage('activate') },
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
    // Check for a new version whenever the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(err => console.warn('Offline support is unavailable:', err));

  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

main().catch(err => {
  console.error(err);
  const root = document.getElementById('app');
  root.replaceChildren(h('div', { class: 'fatal' },
    h('h1', { text: "The app couldn't start" }),
    h('p', { text: err?.message || String(err) }),
    h('p', { text: 'Try reloading. If it keeps happening, tell Claude what this message says.' })));
});
