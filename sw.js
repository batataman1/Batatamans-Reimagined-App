// Offline support. Keeps a copy of the app's files so it opens without internet.
// VERSION and FILES are filled in by dev/build.py. VERSION must change whenever any app file
// changes; the app then offers "Reload" to update.
// Requests to GitHub's API are never cached here.

const VERSION = '8679dd7dfe';
const CACHE = `brr-app-${VERSION}`;
const FILES = [
  "./index.html",
  "./css/app.css",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./js/app.js",
  "./js/config/app.js",
  "./js/config/icons.js",
  "./js/config/themes.js",
  "./js/config/wiki.js",
  "./js/core/db.js",
  "./js/core/exporter.js",
  "./js/core/github.js",
  "./js/core/importer.js",
  "./js/core/store.js",
  "./js/core/sync.js",
  "./js/core/util.js",
  "./js/tabs/index.js",
  "./js/tabs/placeholder.js",
  "./js/tabs/wiki.js",
  "./js/ui/claudeui.js",
  "./js/ui/dialogs.js",
  "./js/ui/icons.js",
  "./js/ui/install.js",
  "./js/ui/settings.js",
  "./js/ui/shell.js",
  "./js/ui/syncui.js",
  "./js/ui/theme.js",
  "./js/wiki/model.js",
  "./js/wiki/text.js",
  "./js/wiki/views.js",
  "./manifest.webmanifest"
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' skips the browser's own cache so the newest files are stored.
    await cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('brr-app-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'activate') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      return (await cache.match('./index.html')) || fetch(req);
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  })());
});
