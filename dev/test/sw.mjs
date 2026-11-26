import { createRequire } from 'node:module';
import fs from 'node:fs';
// Playwright: use the copy installed in this environment, or a normal install.
async function loadPlaywright() {
  for (const base of [process.env.PLAYWRIGHT_DIR, '/opt/npm-tools/node_modules/'].filter(Boolean)) {
    try { return createRequire(base)('playwright'); } catch { /* try next */ }
  }
  return import('playwright');
}
import assert from 'node:assert/strict';
const { chromium } = await loadPlaywright();
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const DIST = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(process.env.BASE || 'http://localhost:8123/');
await page.waitForSelector('.topbar');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
const cached = await page.evaluate(async () => { const k = await caches.keys(); const c = await caches.open(k[0]); return (await c.keys()).length; });
console.log('cached files:', cached);

// Offline reload still works
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('.topbar', { timeout: 10000 });
assert.ok(await page.locator('.tab').count() === 3);
console.log('offline reload OK');
await ctx.setOffline(false);

// Manifest is valid JSON with icons that load
const man = await page.evaluate(async () => { const r = await fetch('manifest.webmanifest'); return r.json(); });
for (const i of man.icons) {
  const ok = await page.evaluate(async src => (await fetch(src)).ok, i.src);
  assert.ok(ok, i.src);
}
console.log('manifest + icons OK');

// New version -> update toast -> Reload
const swPath = `${DIST}/sw.js`;
const original = fs.readFileSync(swPath, 'utf8');
fs.writeFileSync(swPath, original.replace(/const VERSION = '([^']+)'/, "const VERSION = '$1-next'"));
await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
await page.locator('.toast', { hasText: 'A new version of the app is ready' }).waitFor({ timeout: 10000 });
console.log('update toast OK');
await Promise.all([page.waitForEvent('load'), page.locator('.toast button', { hasText: 'Reload' }).click()]);
await page.waitForSelector('.topbar');
const keys = await page.evaluate(() => caches.keys());
assert.ok(keys.length === 1 && keys[0].endsWith('-next'), JSON.stringify(keys));
console.log('reloaded into new version OK');
fs.writeFileSync(swPath, original);
console.log('page errors:', errs.length ? errs : 'none');
await browser.close();
