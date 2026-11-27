// Wiki tab (part 2b): starter import, browsing, page view, links, back button, search, phone layout.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
async function loadPlaywright() {
  for (const base of [process.env.PLAYWRIGHT_DIR, '/opt/npm-tools/node_modules/'].filter(Boolean)) {
    try { return createRequire(base)('playwright'); } catch { /* try next */ }
  }
  return import('playwright');
}
const { chromium } = await loadPlaywright();
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const BASE = process.env.BASE || 'http://localhost:8123/';
const SHOTS = process.env.SHOTS || '/tmp/brr-shots/';
const STARTER = new URL('../starter-wiki.json', import.meta.url);
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined, args: ['--no-sandbox'] });
const errors = [];
const dlg = page => page.locator('dialog[open]').last();

async function device(name, opts) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  await page.goto(BASE);
  await page.waitForSelector('.topbar');
  await page.getByRole('button', { name: 'Not now' }).click();
  return page;
}

async function importText(page, text) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await dlg(page).getByRole('button', { name: 'Import from Claude' }).click();
  await dlg(page).locator('textarea').fill(text);
  await dlg(page).getByRole('button', { name: 'Preview changes', exact: true }).click();
  await dlg(page).locator('.import-list').waitFor();
}
const saveImport = async page => {
  await dlg(page).locator('.modal-actions button.btn-primary').click();
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
};
const hash = page => page.evaluate(() => location.hash);
const h1 = page => page.locator('#view h1').first().textContent();
const infoValue = (page, label) => page.locator('.infobox-facts dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]').textContent();

/* ---------------- Desktop ---------------- */
const A = await device('A', { viewport: { width: 1280, height: 860 } });
await A.locator('.notice', { hasText: 'No wiki pages on this device yet' }).waitFor();
await A.screenshot({ path: SHOTS + 'w1-empty.png' });

// The three pages from the 2a sync test, without groups: they show under "Not sorted yet".
await A.evaluate(async () => {
  const { store } = await import('./js/core/store.js');
  for (const [id, name] of [['ostrich', 'Ostrich'], ['termite', 'Termite'], ['monkey', 'Monkey']]) {
    await store.put('wiki', id, { name, category: 'Mob' });
  }
});
await A.locator('.wiki-unsorted .page-row-name', { hasText: 'Termite' }).waitFor();
assert.deepEqual(await A.locator('.wiki-unsorted .page-row-name').allTextContents(), ['Monkey', 'Ostrich', 'Termite']);

// Starter import: 3 updates + new pages, nothing invalid.
const starterText = fs.readFileSync(STARTER, 'utf8');
const starter = JSON.parse(starterText);
await importText(A, starterText);
const badges = await dlg(A).locator('.import-badge').allTextContents();
assert.equal(badges.filter(b => b === 'Update').length, 3, badges.join());
assert.equal(badges.filter(b => b === 'New').length, starter.changes.length - 3);
assert.equal(badges.filter(b => b === 'Problem').length, 0);
await A.screenshot({ path: SHOTS + 'w2-import-preview.png' });
await saveImport(A);
await A.waitForFunction(() => !document.querySelector('.wiki-unsorted'));
await A.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));

const counts = Object.fromEntries(await A.locator('.tile').evaluateAll(ts => ts.map(t => [t.querySelector('.tile-name').textContent, t.querySelector('.tile-count').textContent])));
assert.deepEqual(counts, { Mobs: '5', Items: '6', Blocks: '6', World: '7', 'Effects & Enchantments': '0' });
const ostrichData = await A.evaluate(async () => (await (await import('./js/core/store.js')).store.get('wiki', 'ostrich')).data);
assert.equal(ostrichData.category, null);
assert.equal(ostrichData.subgroup, 'neutral');
await A.screenshot({ path: SHOTS + 'w3-home.png' });

// Group -> sub-group -> page
await A.locator('.tile', { hasText: 'Mobs' }).click();
await A.locator('#view h1', { hasText: /^Mobs$/ }).waitFor();
assert.equal(await hash(A), '#/wiki/g/mobs');
assert.equal(await h1(A), 'Mobs');
// Sub-group tiles: an icon each, and the names of the pages inside.
assert.equal(await A.locator('.tile .tile-icon svg').count(), 4);
assert.equal(await A.locator('.tile', { hasText: 'Neutral' }).locator('.tile-sub').textContent(), 'Brown Bear · Hippo · Ostrich');
assert.equal(await A.locator('.tile', { hasText: 'Boss' }).locator('.tile-sub').textContent(), 'No pages yet');
await A.screenshot({ path: SHOTS + 'w4-group.png' });
await A.locator('.tile', { hasText: 'Neutral' }).click();
await A.locator('#view h1', { hasText: /^Neutral$/ }).waitFor();
assert.deepEqual(await A.locator('.page-row-name').allTextContents(), ['Brown Bear', 'Hippo', 'Ostrich']);
assert.equal(await A.locator('.page-row', { hasText: 'Hippo' }).locator('.tag-planned').count(), 1);
await A.screenshot({ path: SHOTS + 'w5-subgroup.png' });
await A.locator('.page-row', { hasText: 'Ostrich' }).click();
await A.locator('#view h1', { hasText: /^Ostrich$/ }).waitFor();
assert.equal(await hash(A), '#/wiki/p/ostrich');
assert.equal(await h1(A), 'Ostrich');
assert.equal(await infoValue(A, 'Health'), '18 (9 hearts)');
assert.equal(await infoValue(A, 'Category'), 'Mobs › Neutral');
assert.equal(await infoValue(A, 'Version added'), '1.0.0');
assert.match(await A.title(), /^Ostrich · /);
await A.screenshot({ path: SHOTS + 'w6-ostrich.png', fullPage: true });

// Link in a field -> other page; Linked from shows the way back; back button returns.
await A.locator('.infobox .wlink', { hasText: 'Baobab Fruit' }).first().click();
await A.locator('#view h1', { hasText: /^Baobab Fruit$/ }).waitFor();
assert.equal(await hash(A), '#/wiki/p/baobab-fruit');
assert.equal(await h1(A), 'Baobab Fruit');
const linkedFrom = await A.locator('section', { has: A.locator('h2', { hasText: 'Linked from' }) }).locator('.wlink').allTextContents();
assert.ok(linkedFrom.includes('Ostrich') && linkedFrom.includes('Baobab Tree'), linkedFrom.join());
assert.equal(await A.evaluate(() => window.scrollY), 0);
await A.goBack();
await A.waitForFunction(() => location.hash === '#/wiki/p/ostrich' && document.querySelector('#view h1')?.textContent === 'Ostrich');

// The on-screen Back button: back to where you came from (Ostrich -> Neutral -> Mobs -> Wiki).
await A.locator('.infobox .wlink', { hasText: 'Baobab Fruit' }).first().click();
await A.locator('#view h1', { hasText: /^Baobab Fruit$/ }).waitFor();
for (const [where, title] of [['#/wiki/p/ostrich', 'Ostrich'], ['#/wiki/g/mobs/neutral', 'Neutral'], ['#/wiki/g/mobs', 'Mobs']]) {
  await A.getByRole('button', { name: 'Back' }).click();
  await A.waitForFunction(([h, t]) => location.hash === h && document.querySelector('#view h1')?.textContent === t, [where, title]);
}
await A.getByRole('button', { name: 'Back' }).click();
await A.waitForFunction(() => location.hash === '#/wiki' && !!document.querySelector('.search-box'));
// Opened directly (no history in the app): Back goes one level up instead of leaving the app.
await A.goto(BASE + '#/wiki/p/palm-tree');
await A.locator('#view h1', { hasText: /^Palm Tree$/ }).waitFor();
await A.getByRole('button', { name: 'Back' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/g/world/trees' && document.querySelector('#view h1')?.textContent === 'Trees');
await A.getByRole('button', { name: 'Back' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/g/world' && document.querySelector('#view h1')?.textContent === 'World');

// Variants list and the vanilla biome tag
await A.goto(BASE + '#/wiki/p/hollow-logs');
await A.locator('h1', { hasText: 'Hollow Logs' }).waitFor();
assert.equal(await A.locator('.variants li').count(), 13);
await A.screenshot({ path: SHOTS + 'w7-hollow-logs.png', fullPage: true });
await A.goto(BASE + '#/wiki/p/savanna');
await A.locator('.tag-vanilla', { hasText: 'Vanilla biome changed by the mod' }).waitFor();

// Search
await A.goto(BASE + '#/wiki');
await A.locator('.search-box input').fill('rope');
await A.locator('.search-results .page-row').first().waitFor();
assert.equal(await A.locator('.search-results .page-row-name').first().textContent(), 'Rope');
await A.screenshot({ path: SHOTS + 'w8-search.png' });
await A.locator('.search-box input').press('Enter');
await A.waitForFunction(() => location.hash === '#/wiki/p/rope');
await A.locator('#view h1', { hasText: 'Rope' }).waitFor();     // the page draws a moment after the address changes
await A.locator('.search-box input').count().then(n => assert.equal(n, 0));
await A.goBack();
await A.waitForFunction(() => document.querySelector('.search-box input')?.value === 'rope');
await A.locator('.search-box input').fill('termites nest');
await A.locator('.search-results .page-row').first().waitFor();
assert.equal(await A.locator('.search-results .page-row-name').first().textContent(), 'Termite Nest');
await A.locator('.search-box input').fill('');

// A link to a page that doesn't exist yet is dashed and opens a "no page yet" screen.
await importText(A, JSON.stringify({ format: 'batataman-import', version: 1, changes: [
  { action: 'upsert', collection: 'wiki', id: 'ostrich-feather-test', data: { name: 'Feather test', group: 'items', subgroup: 'misc', overview: 'Drops [[ostrich-feather]] and **bold** text.' } },
] }));
await saveImport(A);
await A.goto(BASE + '#/wiki/p/ostrich-feather-test');
await A.locator('#view h1', { hasText: /^Feather test$/ }).waitFor();
const missing = A.locator('.wiki-overview .wlink-missing');
assert.equal(await missing.textContent(), 'Ostrich Feather');
assert.equal(await A.locator('.wiki-overview strong').textContent(), 'bold');
assert.equal(await A.locator('.tag-dirty').count(), 1);
await missing.click();
await A.locator('.tag-missing').waitFor();
await A.locator('.wiki-main .wlink').waitFor();
assert.equal(await h1(A), 'Ostrich Feather');
assert.equal(await A.locator('.wiki-main .wlink').textContent(), 'Feather test');

// Tabs remember where you were; tapping the open Wiki tab goes to its start.
await A.goto(BASE + '#/wiki/p/termite');
await A.locator('h1', { hasText: 'Termite' }).waitFor();
await A.getByRole('tab', { name: 'Tasks & Bugs' }).click();
assert.equal(await hash(A), '#/tasks');
await A.getByRole('tab', { name: 'Wiki' }).click();
assert.equal(await hash(A), '#/wiki/p/termite');
await A.locator('#view h1', { hasText: /^Termite$/ }).waitFor();
await A.locator('h1', { hasText: 'Termite' }).waitFor();
await A.getByRole('tab', { name: 'Wiki' }).click();
assert.equal(await hash(A), '#/wiki');
await A.locator('.search-box').waitFor();

// Opening an address directly, and after a reload.
await A.goto(BASE + '#/wiki/g/world/trees');
await A.locator('#view h1', { hasText: /^Trees$/ }).waitFor();
assert.deepEqual(await A.locator('.page-row-name').allTextContents(), ['Baobab Tree', 'Palm Tree']);
await A.reload();
await A.waitForSelector('.page-row-name');
assert.equal(await h1(A), 'Trees');

// Light theme screenshot of a page
await A.goto(BASE + '#/wiki/p/monkey');
await A.locator('h1', { hasText: 'Monkey' }).waitFor();
await A.getByRole('button', { name: 'Switch to the light theme' }).click();
await A.screenshot({ path: SHOTS + 'w9-monkey-light.png', fullPage: true });
await A.getByRole('button', { name: 'Switch to the dark theme' }).click();

/* ---------------- Phone ---------------- */
const B = await device('B', { viewport: { width: 384, height: 832 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' });
await importText(B, starterText);
await saveImport(B);
await B.locator('.tile', { hasText: 'Mobs' }).locator('.tile-count', { hasText: '5' }).waitFor();
await B.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
await B.screenshot({ path: SHOTS + 'p1-home.png', fullPage: true });
await B.locator('.tile', { hasText: 'Items' }).tap();
await B.locator('.tile', { hasText: 'Food & Ingredients' }).tap();
await B.locator('.page-row', { hasText: 'Banana' }).waitFor();
await B.screenshot({ path: SHOTS + 'p2-food.png' });
await B.locator('.page-row', { hasText: 'Banana' }).tap();
await B.locator('h1', { hasText: 'Banana' }).waitFor();
await B.screenshot({ path: SHOTS + 'p3-banana.png', fullPage: true });
await B.goto(BASE + '#/wiki/p/ostrich');
await B.locator('h1', { hasText: 'Ostrich' }).waitFor();
await B.screenshot({ path: SHOTS + 'p4-ostrich.png', fullPage: true });
await B.goto(BASE + '#/wiki/p/baobab-wood-set');
await B.locator('h1', { hasText: 'Baobab Wood Set' }).waitFor();
await B.screenshot({ path: SHOTS + 'p5-wood-set.png', fullPage: true });
assert.equal(await B.locator('.back-btn').isVisible(), false);
const overflow = await B.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
assert.equal(overflow, false, 'page is wider than the phone screen');

console.log('errors:', errors.length ? errors : 'none');
assert.equal(errors.length, 0);
await browser.close();
console.log('ALL WIKI CHECKS PASSED');
