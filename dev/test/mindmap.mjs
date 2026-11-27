// The mind map (part 2c Ideas, step 2): the List/Map switch, bubbles and lines, zoom, pan and
// Fit, tap to select and drag one bubble, long-press select mode with "Select everything in
// this branch", the ⋯ menu (open, add below, bigger/smaller, fold, draw and remove a
// connection, change main bubble, make a task, delete), the fold button, Tidy up, Undo,
// section maps, Check your changes, and a phone with finger dragging, long-press and pinch.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createMockGitHub } from './mockgithub.mjs';
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
const STARTER = fs.readFileSync(new URL('../starter-wiki.json', import.meta.url), 'utf8');
const STARTER_IDEAS = fs.readFileSync(new URL('../starter-ideas.json', import.meta.url), 'utf8');
fs.mkdirSync(SHOTS, { recursive: true });

const gh = createMockGitHub();
const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined, args: ['--no-sandbox'] });
const errors = [];
const dlg = page => page.locator('dialog[open]').last();
const popup = page => page.locator('.popup');

async function device(name, opts) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...opts });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await ctx.route('https://api.github.com/**', async route => {
    const r = route.request();
    await route.fulfill(gh.handle(r.method(), r.url(), await r.allHeaders(), r.postData()));
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  await page.goto(BASE);
  await page.waitForSelector('.topbar');
  const form = page.locator('.welcome .connect-form');
  await form.locator('input[name=token]').fill('github_pat_test');
  await form.locator('input[name=device]').fill(name === 'A' ? 'PC' : 'Phone');
  await form.getByRole('button', { name: 'Test and save' }).click();
  await page.waitForFunction(() => !document.querySelector('.welcome'));
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  await clearToasts(page);
  return page;
}
async function clearToasts(page) { await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); }
async function expectToast(page, re) {
  await page.waitForFunction(src => [...document.querySelectorAll('.toast')].some(t => new RegExp(src).test(t.textContent)), re.source, { timeout: 8000 });
  await clearToasts(page);
}
async function importText(page, text) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await dlg(page).getByRole('button', { name: 'Import from Claude' }).click();
  await dlg(page).locator('textarea').fill(text);
  await dlg(page).getByRole('button', { name: 'Preview changes', exact: true }).click();
  await dlg(page).locator('.import-list').waitFor();
}
async function push(page, check) {
  await clearToasts(page);
  await page.locator('.sync-btn', { hasText: 'Push' }).click();
  const rv = page.locator('dialog.modal-review');
  await rv.waitFor();
  if (check) await check(rv);
  await rv.locator('[data-action="push"]').click();
  await expectToast(page, /Pushed/);
}
async function pull(page) {
  await clearToasts(page);
  await page.locator('.sync-btn', { hasText: 'Pull' }).click();
  await expectToast(page, /Pulled|up to date/i);
}
const list = (page, col) => page.evaluate(async c => (await (await import('./js/core/store.js')).store.list(c)).map(r => ({ id: r.id, ...r.data })), col);
const taskNamed = async (page, title) => (await list(page, 'tasks')).find(t => t.title === title) || null;
const ideaNamed = async (page, title) => (await list(page, 'ideas')).find(t => t.title === title) || null;
const sectionNamed = async (page, name) => (await list(page, 'sections')).find(f => f.name === name) || null;
async function waitSaved(page) {
  await page.waitForFunction(() => document.querySelector('.ed-status')?.textContent === 'Saved on this device', null, { timeout: 5000 });
}
const node = (page, title) => page.locator('.id-node', { has: page.locator(':scope > .id-item .id-title', { hasText: new RegExp(`^${title}$`) }) });
const row = (page, title) => node(page, title).locator(':scope > .id-item');
const titles = (page, sel = '.id-content .id-title') => page.locator(sel).allTextContents();
async function quickAdd(page, title) {
  await page.locator('.tk-add-input').fill(title);
  await page.locator('.tk-add-input').press('Enter');
  await row(page, title).waitFor();
}
/** The outline as text: "Title" with two spaces per level. */
const outlineOf = (page, root = '.id-content') => page.evaluate(sel => {
  const out = [];
  const walk = (ul, d) => { for (const li of ul.querySelectorAll(':scope > .id-node')) { out.push('  '.repeat(d) + li.querySelector(':scope > .id-item .id-title').textContent); const sub = li.querySelector(':scope > .id-tree'); if (sub) walk(sub, d + 1); } };
  for (const ul of document.querySelector(sel).querySelectorAll('.id-top')) walk(ul, 0);
  return out;
}, root);
async function menu(page, opener, pick) {
  await opener.click();
  await popup(page).waitFor();
  const labels = await popup(page).locator('.popup-label').allTextContents();
  if (pick) await popup(page).locator('.popup-item', { hasText: pick }).first().click();
  else { await page.keyboard.press('Escape'); await page.mouse.click(5, 400); }
  return labels;
}
async function mouseDrag(page, handle, to) {
  const a = await handle.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 10, a.y + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}
async function fingerDrag(page, handle, to) {
  const a = await handle.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const x0 = a.x + a.width / 2, y0 = a.y + a.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (to.x - x0) * i / 12, y: y0 + (to.y - y0) * i / 12, id: 1 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const store = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  const { store } = await import('./js/core/store.js');
  return new Function('store', 'a', `return (${src})(store, a);`)(store, a);
}, [fn.toString(), arg]);
const overflows = page => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const bub = (page, label) => page.locator('.mm-b', { has: page.locator(':scope > .mm-text', { hasText: new RegExp(`^${label}$`) }) });
const view = page => page.locator('.mm-world').evaluate(e => {
  const m = e.style.transform.match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([\d.e]+)\)/);
  return { tx: +m[1], ty: +m[2], k: +m[3] };
});
const mid = async loc => {
  for (let i = 0; i < 40; i++) {                 // the map may be redrawing at that moment
    const b = await loc.boundingBox().catch(() => null);
    if (b) return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('bubble not found');
};
async function dragBubble(page, label, dx, dy) {
  const p = await mid(bub(page, label).locator(':scope > .mm-text'));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 4, p.y + 4, { steps: 2 });
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 10 });
  await page.mouse.up();
}
async function tapBubble(page, label, mods = []) {
  const p = await mid(bub(page, label).locator(':scope > .mm-text'));
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of mods) await page.keyboard.up(m);
}
async function holdBubble(page, label) {
  const p = await mid(bub(page, label).locator(':scope > .mm-text'));
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
}
const mapCount = page => page.locator('.mm-b').count();
async function clickLine(page) {
  const p = await page.locator('.mm-link-hit').first().evaluate(el => {
    const q = el.getPointAtLength(el.getTotalLength() / 2), m = el.getScreenCTM();
    return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
  });
  await page.mouse.click(p.x, p.y);
  await dlg(page).locator('.mm-styles').waitFor();
}
const idea = async (page, title) => (await list(page, 'ideas')).find(i => i.title === title) || null;
const near = (a, b, d = 2) => Math.abs(a - b) <= d;

/* ---------------- Device A: desktop ---------------- */
const A = await device('A', { viewport: { width: 1280, height: 900 } });
await importText(A, STARTER);
await dlg(A).locator('.modal-actions button.btn-primary').click();
await A.waitForFunction(() => !document.querySelector('dialog[open]'));
await importText(A, STARTER_IDEAS);
await dlg(A).locator('.modal-actions button.btn-primary').click();
await A.waitForFunction(() => !document.querySelector('dialog[open]'));
await push(A);
await clearToasts(A);

/* ---- The switch, the All ideas map, links follow the chosen view ---- */
await A.getByRole('tab', { name: 'Ideas' }).click();
await A.locator('h1', { hasText: 'All ideas' }).waitFor();
await A.locator('.seg-btn', { hasText: 'Map' }).click();
await A.waitForFunction(() => location.hash === '#/ideas/m/all');
await A.locator('.mm-root').waitFor();
assert.equal(await mapCount(A), 7);                                    // All ideas, 3 sections, 3 ideas
assert.equal(await A.locator('.mm-line').count(), 6);
assert.equal(await A.locator('.tk-search').count(), 0);                // no search on the map
assert.equal(await A.locator('.tk-flink[data-key="s-mobs"]').getAttribute('href'), '#/ideas/m/s-mobs');
const fitted = await view(A);
assert.ok(fitted.k > 0.2 && fitted.k <= 1.1);
// Every bubble is inside the map after Fit
const vb = await A.locator('.mm-view').boundingBox();
for (const b of await A.locator('.mm-b').all()) {
  const r = await b.boundingBox();
  assert.ok(r.x >= vb.x - 1 && r.x + r.width <= vb.x + vb.width + 1 && r.y >= vb.y - 1 && r.y + r.height <= vb.y + vb.height + 14, 'a bubble is outside the map');
}
await A.screenshot({ path: SHOTS + 'm1-all.png' });

/* ---- A section's map ---- */
await A.locator('.tk-flink[data-key="s-mobs"]').click();
await A.waitForFunction(() => location.hash === '#/ideas/m/s-mobs');
await A.locator('.mm-center', { hasText: 'Mobs' }).waitFor();
assert.equal(await mapCount(A), 4);
assert.match(await A.locator('.crumbs').textContent(), /Ideas.*Mobs/);

/* ---- Tap selects; dragging moves only that bubble (the ones below stay put) ---- */
await tapBubble(A, 'Termites');
await A.locator('.mm-b.is-sel').waitFor();
assert.equal(await A.locator('.mm-b.is-sel .mm-text').textContent(), 'Termites');
const kidBefore = await mid(bub(A, 'More termite nest mechanics'));
await dragBubble(A, 'Termites', 150, 40);
await A.waitForFunction(() => document.querySelector('.mm-tool[aria-label="Undo"]') && !document.querySelector('.mm-tool[aria-label="Undo"]').disabled);
let t = await idea(A, 'Termites');
assert.ok(t.map, 'Termites got a place');
const kidAfter = await mid(bub(A, 'More termite nest mechanics'));
assert.ok(near(kidBefore.x, kidAfter.x, 3) && near(kidBefore.y, kidAfter.y, 3), 'the bubbles below stayed where they were');
assert.ok((await idea(A, 'More termite nest mechanics')).map, 'the bubbles below were pinned');
const k = (await view(A)).k;
const termAt = t.map;
// Undo puts it back where it was (placed automatically again)
await A.getByRole('button', { name: 'Undo' }).click();
await expectToast(A, /Undone: Move/);
t = await idea(A, 'Termites');
assert.equal(t.map, undefined);
assert.equal((await idea(A, 'More termite nest mechanics')).map, undefined);
await A.waitForTimeout(400);                                             // the map redraws after the Undo

/* ---- Long-press: select mode, select a branch, move it together ---- */
await holdBubble(A, 'Termites');
await A.locator('.mm-bar', { hasText: '1 bubble selected' }).waitFor();
await A.getByRole('button', { name: 'Select everything in this branch' }).click();
await A.locator('.mm-bar', { hasText: '3 bubbles selected' }).waitFor();
assert.equal(await A.locator('.mm-b.is-sel').count(), 3);
const before = {};
for (const n of ['Termites', 'Termites make hollow logs', 'More termite nest mechanics']) before[n] = await mid(bub(A, n));
await dragBubble(A, 'More termite nest mechanics', -60, 90);
await A.waitForFunction(() => !document.querySelector('.mm-tool[aria-label="Undo"]').disabled);
await A.waitForTimeout(250);
const moved = {};
for (const n of Object.keys(before)) {
  const p = await mid(bub(A, n));
  moved[n] = { dx: p.x - before[n].x, dy: p.y - before[n].y };
  assert.ok(near(moved[n].dx, -60, 4) && near(moved[n].dy, 90, 4), `${n} moved with the others: ${JSON.stringify(moved[n])}`);
  assert.ok((await idea(A, n)).map, `${n} saved`);
}
// Tapping in select mode adds and removes; Done leaves it
await tapBubble(A, 'Termites');
await A.locator('.mm-bar', { hasText: '2 bubbles selected' }).waitFor();
await A.getByRole('button', { name: 'Done' }).click();
assert.equal(await A.locator('.mm-bar').count(), 0);
assert.equal(await A.locator('.mm-b.is-sel').count(), 0);
// Shift-click adds to the selection on PC
await tapBubble(A, 'Termites');
await tapBubble(A, 'Termites make hollow logs', ['Shift']);
assert.equal(await A.locator('.mm-b.is-sel').count(), 2);
// Tapping empty space clears it
await A.mouse.click(vb.x + 20, vb.y + 60);
await A.waitForFunction(() => !document.querySelector('.mm-b.is-sel'));
// Tapping the selected bubble again lets go of it
await tapBubble(A, 'Termites');
await A.locator('.mm-b.is-sel').waitFor();
await tapBubble(A, 'Termites');
await A.waitForFunction(() => !document.querySelector('.mm-b.is-sel'));
// The select-mode bar sits on top of the map; pressing outside the map leaves select mode
await holdBubble(A, 'Termites');
await A.locator('.mm-bar', { hasText: '1 bubble selected' }).waitFor();
const barBox = await A.locator('.mm-bar').boundingBox();
const viewNow = await A.locator('.mm-view').boundingBox();
assert.ok(barBox.y + barBox.height <= viewNow.y + 1 && viewNow.y - barBox.y < 80, 'the bar is right above the map');
assert.equal(await A.locator('.mm-tools').isVisible(), false, 'it takes the place of the buttons');
await A.locator('h1').click();
await A.waitForFunction(() => !document.querySelector('.mm-bar') && !document.querySelector('.mm-b.is-sel'));
await tapBubble(A, 'Termites');
assert.equal(await A.locator('.mm-bar').count(), 0, 'back to selecting one at a time');
await A.mouse.click(vb.x + 20, vb.y + 60);

/* ---- The ⋯ menu: sizes ---- */
const pickSize = async (opener, size) => {
  await menu(A, opener, 'Size');
  await popup(A).waitFor();
  assert.deepEqual(await popup(A).locator('.popup-label').allTextContents(), ['Tiny', 'Small', 'Normal', 'Big', 'Huge']);
  await popup(A).locator('.popup-item', { hasText: new RegExp(`^${size}`) }).click();
};
const ideaMenuLabels = await menu(A, bub(A, 'Termites make hollow logs').locator('.mm-more'));
assert.deepEqual(ideaMenuLabels, ['Open the idea page', 'Add an idea below', 'Size', 'Draw a connection', 'Change main bubble', 'Make a task', 'Delete']);
await pickSize(bub(A, 'Termites make hollow logs').locator('.mm-more'), 'Big');
await bub(A, 'Termites make hollow logs').and(A.locator('.size-l')).waitFor();
assert.equal((await idea(A, 'Termites make hollow logs')).size, 'l');
await pickSize(bub(A, 'Termites make hollow logs').locator('.mm-more'), 'Tiny');
await bub(A, 'Termites make hollow logs').and(A.locator('.size-xs')).waitFor();
await pickSize(bub(A, 'Termites make hollow logs').locator('.mm-more'), 'Normal');
await bub(A, 'Termites make hollow logs').and(A.locator('.size-m')).waitFor();
assert.equal((await idea(A, 'Termites make hollow logs')).size, undefined);    // normal isn't saved
await pickSize(bub(A, 'Termites make hollow logs').locator('.mm-more'), 'Small');
await bub(A, 'Termites make hollow logs').and(A.locator('.size-s')).waitFor();
// The section in the middle has a size too
const secLabels = await menu(A, A.locator('.mm-center .mm-more'));
assert.deepEqual(secLabels, ['Show as a list', 'Add an idea here', 'Size']);
await pickSize(A.locator('.mm-center .mm-more'), 'Huge');
await A.locator('.mm-center.size-xl').waitFor();

/* ---- Connections ---- */
await menu(A, bub(A, 'Termites make hollow logs').locator('.mm-more'), 'Draw a connection');
await A.locator('.mm-bar', { hasText: 'Tap the bubble to connect “Termites make hollow logs” to' }).waitFor();
await tapBubble(A, 'More termite nest mechanics');
await A.locator('.mm-link').waitFor();
assert.deepEqual((await idea(A, 'Termites make hollow logs')).connections, [{ id: 'i-termite-nest-mechanics', style: 'dashed' }]);
await expectToast(A, /Tap the line to change how it looks/);
assert.equal(await A.locator('.mm-bar').count(), 0);
// Joining the same two again, or an idea to its main bubble, says so
await menu(A, bub(A, 'More termite nest mechanics').locator('.mm-more'), 'Draw a connection');
await tapBubble(A, 'Termites make hollow logs');
await expectToast(A, /already joined/);
// Tap the line: 7 styles; dotted, then an arrow, turned around, and Undo
await clickLine(A);
assert.deepEqual(await dlg(A).locator('.mm-style span').allTextContents(), ['Dashed', 'Dotted', 'Dash-dot', 'Dash-dot-dot', 'Long dash', 'Solid', 'Arrow']);
assert.equal(await dlg(A).locator('.mm-style[aria-pressed="true"]').getAttribute('data-style'), 'dashed');
await dlg(A).locator('.mm-style[data-style="dotted"]').click();
await A.locator('.mm-link.mm-link-dotted').waitFor();
assert.equal((await idea(A, 'Termites make hollow logs')).connections[0].style, 'dotted');
await A.waitForTimeout(200);
await clickLine(A);
await dlg(A).locator('.mm-style[data-style="arrow"]').click();
await A.locator('.mm-link[marker-end]').waitFor();
await A.waitForTimeout(200);
await clickLine(A);
await dlg(A).getByRole('button', { name: 'Turn the arrow around' }).click();
await A.waitForTimeout(300);
assert.equal((await idea(A, 'Termites make hollow logs')).connections, undefined);
assert.deepEqual((await idea(A, 'More termite nest mechanics')).connections, [{ id: 'i-termites-make-hollow-logs', style: 'arrow' }]);
await A.getByRole('button', { name: 'Undo' }).click();
await expectToast(A, /Undone: Turn the arrow around/);
await A.waitForTimeout(300);
assert.deepEqual((await idea(A, 'Termites make hollow logs')).connections, [{ id: 'i-termite-nest-mechanics', style: 'arrow' }]);
assert.equal((await idea(A, 'More termite nest mechanics')).connections, undefined);
await A.screenshot({ path: SHOTS + 'm5-arrow.png' });
// Remove it (from either end), and Undo brings it back
const withConn = await menu(A, bub(A, 'More termite nest mechanics').locator('.mm-more'), 'Remove a connection');
assert.ok(withConn.includes('Remove a connection'));
await expectToast(A, /Connection removed/);
await A.waitForFunction(() => !document.querySelector('.mm-link'));
assert.equal((await idea(A, 'Termites make hollow logs')).connections, undefined);
await A.getByRole('button', { name: 'Undo' }).click();
await A.locator('.mm-link').waitFor();
await clearToasts(A);

/* ---- Add an idea below, change its main bubble ---- */
await menu(A, bub(A, 'Termites').locator('.mm-more'), 'Add an idea below');
await dlg(A).locator('input[name=name]').fill('Termite queen');
await dlg(A).getByRole('button', { name: 'Add idea' }).click();
await bub(A, 'Termite queen').waitFor();
let q = await idea(A, 'Termite queen');
assert.equal(q.parent, 'i-termites');
assert.ok(q.map, 'a new bubble gets a free spot');
const queenAt = await mid(bub(A, 'Termite queen'));
for (const other of ['Termites', 'Termites make hollow logs', 'More termite nest mechanics']) {
  const o = await mid(bub(A, other));
  assert.ok(Math.hypot(o.x - queenAt.x, o.y - queenAt.y) > 40, `Termite queen doesn't sit on ${other}`);
}
await menu(A, bub(A, 'Termite queen').locator('.mm-more'), 'Change main bubble');
await A.locator('.mm-bar', { hasText: 'Tap the new main bubble for “Termite queen”' }).waitFor();
await tapBubble(A, 'Termite queen');                                    // not itself
await expectToast(A, /can't go under itself/);
await tapBubble(A, 'Termites make hollow logs');
await A.waitForFunction(() => !document.querySelector('.mm-bar'));
await A.waitForTimeout(250);
q = await idea(A, 'Termite queen');
assert.equal(q.parent, 'i-termites-make-hollow-logs');
// Not under its own branch
await menu(A, bub(A, 'Termites make hollow logs').locator('.mm-more'), 'Change main bubble');
await tapBubble(A, 'Termite queen');
await expectToast(A, /can't go under itself or the ideas below it/);
await A.getByRole('button', { name: 'Cancel' }).click();
// Escape also leaves a mode
await menu(A, bub(A, 'Termite queen').locator('.mm-more'), 'Draw a connection');
await A.locator('.mm-bar').waitFor();
await A.keyboard.press('Escape');
await A.waitForFunction(() => !document.querySelector('.mm-bar'));

/* ---- Fold button (shared with the list) ---- */
const fold = bub(A, 'Termites').locator(':scope > .mm-fold');
assert.equal(await fold.textContent(), '−');
await fold.click();
await A.waitForFunction(() => document.querySelectorAll('.mm-b').length === 2);
assert.equal(await bub(A, 'Termites').locator(':scope > .mm-fold').textContent(), '+3');
await A.locator('.seg-btn', { hasText: 'List' }).click();
await A.waitForFunction(() => location.hash === '#/ideas/s/s-mobs');
await A.locator('.id-tag-hidden', { hasText: '+3' }).waitFor();
assert.equal(await A.locator('.tk-flink[data-key="s-mobs"]').getAttribute('href'), '#/ideas/s/s-mobs');
await A.locator('.seg-btn', { hasText: 'Map' }).click();
await A.locator('.mm-center').waitFor();
await menu(A, bub(A, 'Termites').locator('.mm-more'), /^Unfold/);
await bub(A, 'Termite queen').waitFor();
assert.equal(await mapCount(A), 5);

/* ---- Tidy up (and Undo) ---- */
await A.getByRole('button', { name: 'Tidy up this map' }).click();
await dlg(A).getByRole('button', { name: 'Tidy up' }).click();
await A.waitForFunction(() => !document.querySelector('dialog[open]'));
await A.waitForTimeout(400);
const spots = [];
for (const n of ['Termites', 'Termites make hollow logs', 'More termite nest mechanics', 'Termite queen']) {
  const m = (await idea(A, n)).map;
  assert.ok(m, `${n} has a tidy place`);
  for (const s of spots) assert.ok(Math.hypot(s.x - m.x, s.y - m.y) > 150, 'tidy bubbles keep apart');
  spots.push(m);
}
const mobsAt = (await list(A, 'sections')).find(s => s.id === 's-mobs').map;
assert.equal(mobsAt, undefined);                                         // the middle stays where it is
await A.screenshot({ path: SHOTS + 'm2-tidy.png' });
await A.getByRole('button', { name: 'Undo' }).click();
await expectToast(A, /Undone: Tidy up/);
await A.waitForTimeout(300);
assert.equal((await idea(A, 'Termite queen')).map.x, q.map.x);

/* ---- Make a task, the task mark; open the idea page; delete ---- */
await menu(A, bub(A, 'More termite nest mechanics').locator('.mm-more'), 'Make a task');
await dlg(A).getByRole('button', { name: 'Make task' }).click();
await A.locator('.toast', { hasText: /added in Tasks & Bugs/ }).waitFor();
await bub(A, 'More termite nest mechanics').locator('.mm-task').waitFor();
await clearToasts(A);
await menu(A, bub(A, 'Termite queen').locator('.mm-more'), 'Open the idea page');
await A.locator('.ed-bar', { hasText: 'Editing idea' }).waitFor();
assert.match(await A.locator('.crumbs').textContent(), /Termites.*Termites make hollow logs.*Termite queen/);
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(() => location.hash === '#/ideas/m/s-mobs');
await A.locator('.mm-center').waitFor();
await menu(A, bub(A, 'Termite queen').locator('.mm-more'), 'Delete');
await dlg(A).getByRole('button', { name: 'Delete' }).click();
await A.waitForFunction(() => ![...document.querySelectorAll('.mm-text')].some(e => e.textContent === 'Termite queen'));
assert.equal(await idea(A, 'Termite queen'), null);
await clearToasts(A);

/* ---- Full screen: only the map and its buttons; Escape leaves it ---- */
await A.getByRole('button', { name: 'Full screen' }).click();
await A.waitForFunction(() => document.body.classList.contains('mm-full'));
await A.waitForTimeout(150);
const fullBox = await A.locator('.mm').boundingBox();
assert.ok(near(fullBox.x, 0) && near(fullBox.y, 0) && near(fullBox.width, 1280) && near(fullBox.height, 900), 'the map fills the window');
const fullView = await A.locator('.mm-view').boundingBox();
assert.ok(fullView.height > 700, 'the map gets the height');
assert.equal(await A.locator('.mm .tk-add-input').isVisible(), true);    // adding ideas stays
await A.locator('.tk-add-input').fill('Termite armies');
await A.locator('.tk-add-input').press('Enter');
await bub(A, 'Termite armies').waitFor();
assert.equal(await A.evaluate(() => document.body.classList.contains('mm-full')), true, 'still full screen after a redraw');
await A.screenshot({ path: SHOTS + 'm6-full.png' });
await A.keyboard.press('Escape');
await A.waitForFunction(() => !document.body.classList.contains('mm-full'));
await menu(A, bub(A, 'Termite armies').locator('.mm-more'), 'Delete');
await dlg(A).getByRole('button', { name: 'Delete' }).click();
await A.waitForFunction(() => ![...document.querySelectorAll('.mm-text')].some(e => e.textContent === 'Termite armies'));
await clearToasts(A);

/* ---- Zoom, pan, Fit; the view is remembered on this device ---- */
let v0 = await view(A);
await A.getByRole('button', { name: 'Zoom in' }).click();
let v1 = await view(A);
assert.ok(near(v1.k, Math.min(3, v0.k * 1.25), 0.001));
await A.getByRole('button', { name: 'Zoom out' }).click();
assert.ok(near((await view(A)).k, v0.k, 0.001));
{ const b = await A.locator('.mm-view').boundingBox(); await A.mouse.move(b.x + 60, b.y + 60); }
await A.mouse.wheel(0, -300);
await A.waitForTimeout(100);
assert.ok((await view(A)).k > v0.k, 'the wheel zooms in');
for (let i = 0; i < 6; i++) await A.getByRole('button', { name: 'Zoom in' }).click();
await A.waitForTimeout(300);
await A.screenshot({ path: SHOTS + 'm7-zoomed-pc.png' });
await A.getByRole('button', { name: 'Fit the whole map' }).click();
v0 = await view(A);
const vbNow = await A.locator('.mm-view').boundingBox();
await A.mouse.move(vbNow.x + 30, vbNow.y + 40);
await A.mouse.down();
await A.mouse.move(vbNow.x + 130, vbNow.y + 90, { steps: 8 });
await A.mouse.up();
v1 = await view(A);
assert.ok(near(v1.tx - v0.tx, 100, 2) && near(v1.ty - v0.ty, 50, 2), 'dragging empty space moves around');
await A.waitForTimeout(400);
await A.reload();
await A.locator('.mm-center').waitFor();
const v2 = await view(A);
assert.ok(near(v2.tx, v1.tx, 1) && near(v2.k, v1.k, 0.001), 'the view came back after a reload');
await A.getByRole('button', { name: 'Fit the whole map' }).click();
assert.ok((await view(A)).k <= 1.1);

/* ---- Not sorted on the All ideas map; its own map ---- */
await A.locator('.tk-flink[data-key="all"]').click();
await A.locator('.mm-root').waitFor();
await A.locator('.tk-add-input').fill('Desert ruins');
await A.locator('.tk-add-input').press('Enter');
await A.locator('.mm-none', { hasText: 'Not sorted' }).waitFor();
await bub(A, 'Desert ruins').waitFor();
await A.waitForTimeout(150);
const noneLabels = await menu(A, A.locator('.mm-none .mm-more'));
assert.deepEqual(noneLabels, ['Show as a list', 'Open its own map', 'Add an idea here', 'Fold']);
await dragBubble(A, 'Not sorted', 0, -70);
await A.waitForTimeout(300);
assert.ok(await A.evaluate(() => !!JSON.parse(localStorage.getItem('brr.ideas')).nonePos), 'Not sorted keeps its place on this device');
await menu(A, A.locator('.mm-none .mm-more'), 'Open its own map');
await A.waitForFunction(() => location.hash === '#/ideas/m/none');
await A.locator('.mm-center', { hasText: 'Not sorted' }).waitFor();
assert.equal(await mapCount(A), 2);
assert.equal(await overflows(A), false);

/* ---- Check your changes shows map changes ---- */
await clearToasts(A);
await push(A, async rv => {
  const e = rv.locator('.rv-item', { hasText: /^Termites make hollow logs/ });
  await e.getByRole('button', { name: 'See changes' }).click();
  await e.locator('.rv-diff').waitFor();
  const text = await e.locator('.rv-diff').textContent();
  assert.match(text, /Place on the mind map.*moved/);
  assert.match(text, /Bubble size.*Normal.*Small/);
  assert.match(text, /Connections on the mind map.*None.*More termite nest mechanics \(arrow\)/);
  const m = rv.locator('.rv-item', { hasText: /^Mobs/ });
  await m.getByRole('button', { name: 'See changes' }).click();
  await m.locator('.rv-diff').waitFor();
  assert.match(await m.locator('.rv-diff').textContent(), /Bubble size.*Big.*Huge/);
});
assert.equal(JSON.parse(gh.files()['data/ideas/i-termites-make-hollow-logs.json']).data.size, 's');

/* ---- Copy ideas for Claude lists connections ---- */
await A.getByRole('button', { name: 'Settings' }).click();
await dlg(A).getByRole('button', { name: 'Copy ideas for Claude' }).click();
const clip = await A.evaluate(() => navigator.clipboard.readText());
assert.match(clip, /i-termites-make-hollow-logs \| Termites make hollow logs \| links: wiki\/hollow-logs \| connected to: i-termite-nest-mechanics \(arrow\)/);
await A.keyboard.press('Escape');

/* ---------------- Device B: phone ---------------- */
const B = await device('B', { viewport: { width: 384, height: 832 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' });
await pull(B);
await clearToasts(B);
await B.goto(BASE + '#/ideas/m/s-mobs');
await B.locator('.mm-center').waitFor();
assert.equal(await overflows(B), false);
const bv = await B.locator('.mm-view').boundingBox();
const tabsTop = (await B.locator('.tabs').boundingBox()).y;
assert.ok(bv.y + bv.height <= tabsTop, 'the map ends above the tab bar');
assert.ok(bv.height > 300);
assert.equal(await mapCount(B), 4);
assert.equal(await B.locator('.mm-link').count(), 1);
await B.screenshot({ path: SHOTS + 'm3-phone.png' });
const cdp = await B.context().newCDPSession(B);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
// A finger drag moves one bubble
const before2 = await mid(bub(B, 'Termites').locator(':scope > .mm-text'));
await fingerDrag(B, bub(B, 'Termites').locator(':scope > .mm-text'), { x: before2.x + 40, y: before2.y + 60 });
await B.waitForFunction(() => !document.querySelector('.mm-tool[aria-label="Undo"]').disabled);
await B.waitForTimeout(250);
const after2 = await mid(bub(B, 'Termites').locator(':scope > .mm-text'));
assert.ok(near(after2.x - before2.x, 40, 4) && near(after2.y - before2.y, 60, 4));
// A long press starts select mode
const hold = await mid(bub(B, 'More termite nest mechanics').locator(':scope > .mm-text'));
await touch('touchStart', [hold]);
await B.waitForTimeout(700);
await touch('touchEnd', []);
await B.locator('.mm-bar', { hasText: '1 bubble selected' }).waitFor();
await B.getByRole('button', { name: 'Done' }).tap();
// Pinch to zoom in
const pv0 = await view(B);
const c = { x: bv.x + bv.width / 2, y: bv.y + bv.height / 2 };
await touch('touchStart', [{ x: c.x - 40, y: c.y }, { x: c.x + 40, y: c.y }]);
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', [{ x: c.x - 40 - i * 10, y: c.y }, { x: c.x + 40 + i * 10, y: c.y }]);
  await B.waitForTimeout(16);
}
await touch('touchEnd', []);
const pv1 = await view(B);
assert.ok(near(pv1.k / pv0.k, Math.min(3, pv0.k * 3) / pv0.k, 0.15), `pinch zoomed ${pv1.k / pv0.k}x`);
// The ⋯ button works with a finger
await bub(B, 'Termites').locator('.mm-more').tap();
await popup(B).waitFor();
await B.keyboard.press('Escape');
await B.screenshot({ path: SHOTS + 'm4-phone-zoomed.png' });
await cdp.detach();
await push(B);
await pull(A);
assert.ok((await idea(A, 'Termites')).map);

console.log('errors:', errors.length ? errors : 'none');
assert.equal(errors.length, 0);
await browser.close();
console.log('ALL MIND MAP CHECKS PASSED');
