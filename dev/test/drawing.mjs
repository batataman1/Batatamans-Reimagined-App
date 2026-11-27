// The drawing studio (part 2d): the Drawings view in Ideas, a new drawing, the pixel pen
// (pixel-perfect), the free pen (hard, soft), eraser, fill (connected, everywhere), shapes,
// mirror drawing, tiles, pick a colour, undo/redo, swap colours (and a copy), grayscale,
// palettes, autosave, export PNG (exact pixels at 1x), name/section/idea, the idea page's
// Drawings box, Check your changes, sync to a phone, and drawing with fingers (pinch = zoom).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
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
/** The arrowheads on the map: how many, how many point from → to, and whether a bubble covers any. */
async function arrowInfo(page, fromLabel, toLabel) {
  const f = await mid(bub(page, fromLabel)), t = await mid(bub(page, toLabel));
  return page.evaluate(({ f, t }) => {
    const boxes = [...document.querySelectorAll('.mm-b')].map(b => b.getBoundingClientRect());
    const out = { count: 0, forward: 0, covered: 0 };
    for (const el of document.querySelectorAll('.mm-arrow-along')) {
      const nums = el.getAttribute('d').match(/-?[\d.]+/g).map(Number);
      const tip = { x: nums[0], y: nums[1] }, base = { x: (nums[2] + nums[4]) / 2, y: (nums[3] + nums[5]) / 2 };
      out.count++;
      if ((tip.x - base.x) * (t.x - f.x) + (tip.y - base.y) * (t.y - f.y) > 0) out.forward++;
      const r = el.getBoundingClientRect(), cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      if (boxes.some(b => cx > b.left && cx < b.right && cy > b.top && cy < b.bottom)) out.covered++;
    }
    return out;
  }, { f, t });
}
const idea = async (page, title) => (await list(page, 'ideas')).find(i => i.title === title) || null;
const near = (a, b, d = 2) => Math.abs(a - b) <= d;


/* ---------- Drawing helpers ---------- */
const pic = page => page.locator('.dr-pic');
/** Screen point of the middle of a square (n = squares across). */
async function cellPoint(page, x, y, n = 16) {
  const b = await pic(page).boundingBox();
  const cs = b.width / n;
  return { x: b.x + (x + 0.5) * cs, y: b.y + (y + 0.5) * cs };
}
async function clickCell(page, x, y, n = 16) {
  const p = await cellPoint(page, x, y, n);
  await page.mouse.click(p.x, p.y);
}
async function dragCells(page, cells, n = 16) {
  const pts = [];
  for (const [x, y] of cells) pts.push(await cellPoint(page, x, y, n));
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.mouse.up();
}
/** The colour of a square: "#rrggbb/alpha" ("-" when see-through). */
const cellColor = (page, x, y, n = 16) => page.evaluate(([x, y, n]) => {
  const c = document.querySelector('.dr-pic');
  const k = c.width / n;
  const d = c.getContext('2d').getImageData(Math.floor(x * k + k / 2), Math.floor(y * k + k / 2), 1, 1).data;
  return d[3] ? `#${[d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('')}/${d[3]}` : '-';
}, [x, y, n]);
const tool = (page, id) => page.locator(`.dr-tool[data-tool="${id}"]`).click();
const optSeg = (page, label, value) => page.locator(`.dr-opts .seg[aria-label="${label}"] [data-value="${value}"]`).click();
async function drMenu(page, pick) {
  await page.locator('.dr-top-tools button[aria-label="More"]').click();
  await popup(page).waitFor();
  await popup(page).locator('.popup-item', { hasText: pick }).first().click();
}
async function waitDrawingSaved(page) {
  await page.waitForFunction(() => /Saved on this device/.test(document.querySelector('.dr-status')?.textContent || ''), null, { timeout: 8000 });
}
const drawingNamed = async (page, name) => (await list(page, 'drawings')).find(d => d.name === name) || null;

/* ---------------- Device A: desktop ---------------- */
const A = await device('A', { viewport: { width: 1280, height: 860 } });
await importText(A, STARTER);
await dlg(A).locator('.modal-actions button.btn-primary').click();
await A.waitForFunction(() => !document.querySelector('dialog[open]'));
await importText(A, STARTER_IDEAS);
await dlg(A).locator('.modal-actions button.btn-primary').click();
await A.waitForFunction(() => !document.querySelector('dialog[open]'));
await push(A);
await clearToasts(A);

/* ---- The Drawings view in Ideas ---- */
await A.getByRole('tab', { name: 'Ideas' }).click();
await A.locator('h1', { hasText: 'All ideas' }).waitFor();
await A.locator('.id-views [data-view="draw"]').click();
await A.waitForFunction(() => location.hash === '#/ideas/d/all');
await A.locator('.dg-empty').waitFor();
assert.match(await A.locator('.tk-head').textContent(), /0 drawings/);
assert.equal(await A.locator('.tk-flink[data-key="s-mobs"]').getAttribute('href'), '#/ideas/d/s-mobs');   // the panel follows the view
await A.screenshot({ path: SHOTS + 'd1-empty.png' });

/* ---- New drawing: pixel art 16 x 16 in Mobs, for the Termites idea ---- */
await A.locator('.tk-flink[data-key="s-mobs"]').click();
await A.waitForFunction(() => location.hash === '#/ideas/d/s-mobs');
await A.locator('.dg-head .btn-primary', { hasText: 'New drawing' }).click();
await dlg(A).locator('input[name=name]').fill('Termite');
assert.equal(await dlg(A).locator('select[name=section]').inputValue(), 's-mobs');
await dlg(A).locator('select[name=idea]').selectOption('i-termites');
await dlg(A).getByRole('button', { name: 'Make drawing' }).click();
await A.locator('.dr-pic').waitFor();
await A.waitForFunction(() => /^#\/ideas\/draw\/d-/.test(location.hash));
const drawingId = (await A.evaluate(() => location.hash)).split('/').pop();
assert.ok(await A.evaluate(() => document.body.classList.contains('dr-open')));
assert.equal(await A.locator('.topbar').isVisible(), false, 'the app bar hides in the editor');
assert.equal(await A.locator('.dr-pic').evaluate(c => `${c.width}x${c.height}`), '1024x1024');
assert.equal(await A.locator('.dr-tool[aria-pressed="true"]').getAttribute('data-tool'), 'pen');
assert.equal(await A.locator('.dr-opts .seg[aria-label="Pen"] [aria-pressed="true"]').getAttribute('data-value'), 'pixel');

/* ---- Pixel pen: one square, exact colour ---- */
await clickCell(A, 2, 3);
assert.equal(await cellColor(A, 2, 3), '#000000/255');
assert.equal(await cellColor(A, 3, 3), '-');
// The whole square and nothing outside it
assert.equal(await A.evaluate(() => {
  const c = document.querySelector('.dr-pic'), k = 64;
  const d = c.getContext('2d').getImageData(2 * k - 1, 3 * k - 1, k + 2, k + 2).data;
  let inside = 0, outside = 0;
  for (let y = 0; y < k + 2; y++) for (let x = 0; x < k + 2; x++) {
    const a = d[(y * (k + 2) + x) * 4 + 3];
    if (x >= 1 && x <= k && y >= 1 && y <= k) inside += a === 255; else outside += a !== 0;
  }
  return `${inside}/${outside}`;
}), `${64 * 64}/0`);
await A.screenshot({ path: SHOTS + 'd2-editor.png' });


/* ---- Pixel-perfect: a staircase leaves no corner squares ---- */
await dragCells(A, [[0, 8], [1, 8], [1, 9], [2, 9], [2, 10], [3, 10]]);
assert.deepEqual(await Promise.all([[0, 8], [1, 8], [1, 9], [2, 9], [2, 10], [3, 10]].map(([x, y]) => cellColor(A, x, y))),
  ['#000000/255', '-', '#000000/255', '-', '#000000/255', '#000000/255']);

/* ---- Undo and redo (buttons and keys) ---- */
await A.locator('.dr-top-tools [aria-label="Undo"]').click();
assert.equal(await cellColor(A, 1, 9), '-');
assert.equal(await cellColor(A, 2, 3), '#000000/255');
await A.locator('.dr-top-tools [aria-label="Redo"]').click();
assert.equal(await cellColor(A, 1, 9), '#000000/255');
await A.keyboard.press('Control+z');
assert.equal(await cellColor(A, 1, 9), '-');
await A.keyboard.press('Control+y');
assert.equal(await cellColor(A, 1, 9), '#000000/255');

/* ---- A palette colour, then fill: connected, and everywhere ---- */
await A.locator('.dr-side .pal-grid .pal-sw[data-color="#b3312c"]').click();
assert.equal(await A.locator('.dr-side .cp-code').inputValue(), '#b3312c');
await tool(A, 'fill');
await clickCell(A, 10, 2);
assert.equal(await cellColor(A, 15, 15), '#b3312c/255');
assert.equal(await cellColor(A, 2, 3), '#000000/255');
await A.locator('.dr-side .pal-grid .pal-sw[data-color="#f5d547"]').click();
await optSeg(A, 'Fill', 'true');
await clickCell(A, 2, 3);
assert.deepEqual(await Promise.all([[2, 3], [0, 8], [3, 10], [5, 5]].map(([x, y]) => cellColor(A, x, y))),
  ['#f5d547/255', '#f5d547/255', '#f5d547/255', '#b3312c/255']);
await optSeg(A, 'Fill', 'false');
// The recent colours remember what was used
assert.deepEqual(await A.locator('.dr-recent .pal-sw').evaluateAll(els => els.map(e => e.dataset.color).slice(0, 3)), ['#f5d547', '#b3312c', '#000000']);

/* ---- Eraser (pixel) ---- */
await tool(A, 'eraser');
await clickCell(A, 5, 5);
assert.equal(await cellColor(A, 5, 5), '-');

/* ---- Shapes: line, rectangle outline, filled ellipse (pixel) ---- */
await A.locator('.dr-side .pal-grid .pal-sw[data-color="#000000"]').click();
await tool(A, 'line');
await dragCells(A, [[0, 0], [7, 0]]);
assert.equal((await Promise.all([0, 3, 7].map(x => cellColor(A, x, 0)))).join(), '#000000/255,#000000/255,#000000/255');
assert.equal(await cellColor(A, 8, 0), '#b3312c/255');
await tool(A, 'rect');
await dragCells(A, [[8, 8], [12, 12]]);
assert.deepEqual(await Promise.all([[8, 8], [12, 12], [10, 8], [8, 11], [10, 10]].map(([x, y]) => cellColor(A, x, y))),
  ['#000000/255', '#000000/255', '#000000/255', '#000000/255', '#b3312c/255']);
await tool(A, 'ellipse');
await optSeg(A, 'Shape', 'true');
await dragCells(A, [[1, 12], [5, 15]]);
assert.equal(await cellColor(A, 3, 13), '#000000/255');
assert.equal(await cellColor(A, 1, 12), '#b3312c/255');
await optSeg(A, 'Shape', 'false');

/* ---- Mirror drawing ---- */
await tool(A, 'pen');
await A.locator('.dr-top-tools [aria-label^="Mirror drawing"]').click();
await popup(A).locator('.popup-item', { hasText: 'Left and right' }).click();
assert.equal(await A.locator('.dr-top-tools [aria-label^="Mirror drawing"]').getAttribute('aria-pressed'), 'true');
await clickCell(A, 1, 2);
assert.equal(await cellColor(A, 14, 2), '#000000/255');
await A.locator('.dr-top-tools [aria-label^="Mirror drawing"]').click();
await popup(A).locator('.popup-item', { hasText: 'Off' }).click();
await clickCell(A, 1, 4);
assert.equal(await cellColor(A, 14, 4), '#b3312c/255');

/* ---- Free pen on the same picture: smooth edges ---- */
await A.keyboard.press('p');                                      // P switches the pen
assert.equal(await A.locator('.dr-opts .seg[aria-label="Pen"] [aria-pressed="true"]').getAttribute('data-value'), 'free');
assert.equal(await A.locator('.dr-tool[data-tool="pen"]').getAttribute('aria-label'), 'Free pen');
await dragCells(A, [[9, 3], [14, 6]]);
const smooth = await A.evaluate(() => {
  const c = document.querySelector('.dr-pic');
  const d = c.getContext('2d').getImageData(9 * 64, 3 * 64, 6 * 64, 4 * 64).data;
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
  return seen.size;
});
assert.ok(smooth > 10, `the free pen blends at its edges (${smooth} colours)`);
// A soft free eraser makes see-through edges
await tool(A, 'eraser');
await optSeg(A, 'Brush', 'true');
await A.locator('.dr-opts input[name=size]').fill('70');
await dragCells(A, [[10, 13], [14, 13]]);
const alphas = await A.evaluate(() => {
  const c = document.querySelector('.dr-pic');
  const d = c.getContext('2d').getImageData(10 * 64, 12 * 64, 5 * 64, 3 * 64).data;
  let part = 0, none = 0;
  for (let i = 3; i < d.length; i += 4) { if (d[i] > 0 && d[i] < 255) part++; if (d[i] === 0) none++; }
  return { part, none };
});
assert.ok(alphas.part > 100 && alphas.none > 100, `soft erasing: ${JSON.stringify(alphas)}`);
await optSeg(A, 'Brush', 'false');
await A.keyboard.press('p');
await A.screenshot({ path: SHOTS + 'd3-drawn.png' });

/* ---- Tiles ---- */
await A.locator('.dr-top-tools [aria-label^="Tiles"]').click();
await A.locator('.dr-tiles').waitFor();
assert.ok(await A.locator('.dr-tiles').evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width / 3, c.height / 3).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; }));
await A.screenshot({ path: SHOTS + 'd4-tiles.png' });
await A.locator('.dr-top-tools [aria-label^="Tiles"]').click();
assert.equal(await A.locator('.dr-tiles').isVisible(), false);

/* ---- Pick a colour (and back to the tool before) ---- */
await tool(A, 'picker');
await clickCell(A, 15, 15);
assert.equal(await A.locator('.dr-side .cp-code').inputValue(), '#b3312c');
assert.equal(await A.locator('.dr-tool[aria-pressed="true"]').getAttribute('data-tool'), 'eraser');
await tool(A, 'pen');

/* ---- Swap colours: change this drawing, Undo; then a copy ---- */
await drMenu(A, 'Swap colours');
const sw = A.locator('dialog.modal-swap');
await sw.waitFor();
assert.ok(await sw.locator('.sw-to[data-from="#b3312c"]').count());
assert.ok(await sw.locator('.sw-to[data-from="#f5d547"]').count());
await sw.locator('.sw-to[data-from="#b3312c"]').click();
const pc = A.locator('dialog.modal-color');
await pc.locator('.cp-code').fill('#1f6e43');
await pc.getByRole('button', { name: 'Use this colour' }).click();
await pc.waitFor({ state: 'detached' });
assert.equal((await sw.locator('.sw-to[data-from="#b3312c"]').textContent()).trim(), '#1f6e43');
await sw.getByRole('button', { name: 'Change this drawing' }).click();
assert.equal(await cellColor(A, 15, 15), '#1f6e43/255');
assert.equal(await cellColor(A, 2, 3), '#f5d547/255');
await A.locator('.dr-top-tools [aria-label="Undo"]').click();
assert.equal(await cellColor(A, 15, 15), '#b3312c/255');
await drMenu(A, 'Swap colours');
await sw.locator('.sw-to[data-from="#f5d547"]').click();
await pc.locator('.pal-sw[data-color="#2f78c4"]').click();
await pc.getByRole('button', { name: 'Use this colour' }).click();
await sw.getByRole('button', { name: 'Make a copy with these colours' }).click();
await expectToast(A, /Copy made/);
assert.equal(await cellColor(A, 2, 3), '#f5d547/255', 'the drawing itself stays');
const copy = await drawingNamed(A, 'Termite (new colours)');
assert.ok(copy, 'the copy exists');
assert.equal(copy.idea, 'i-termites');

/* ---- Grayscale ---- */
await drMenu(A, 'Make it grayscale');
await dlg(A).getByRole('button', { name: 'Change this drawing' }).click();
assert.equal(await cellColor(A, 15, 15), '#575757/255');       // 0.299 R + 0.587 G + 0.114 B
await A.keyboard.press('Control+z');
assert.equal(await cellColor(A, 15, 15), '#b3312c/255');

/* ---- Palettes: from the drawing's colours, add one, take one out ---- */
await A.locator('.dr-side .pal-more').click();
await popup(A).locator('.popup-item', { hasText: 'New palette' }).click();
await dlg(A).locator('input[name=name]').fill('Termite colours');
await dlg(A).locator('select[name=start]').selectOption('drawing');
await dlg(A).getByRole('button', { name: 'Make palette' }).click();
await A.waitForFunction(() => document.querySelector('.dr-side .pal-select option:checked')?.textContent === 'Termite colours');
let pal = (await list(A, 'palettes'))[0];
assert.equal(pal.name, 'Termite colours');
assert.deepEqual([...pal.colors].sort(), ['#000000', '#b3312c', '#f5d547']);
await A.locator('.dr-side .cp-code').fill('#123456');
await A.locator('.dr-side .pal-add').click();
await A.locator('.dr-side .pal-grid .pal-sw[data-color="#123456"]').waitFor();
await A.locator('.dr-side .pal-more').click();
await popup(A).locator('.popup-item', { hasText: 'Remove colours' }).click();
await A.locator('.dr-side .pal-grid .pal-sw[data-color="#123456"]').click();
await A.locator('.dr-side .pal-grid .pal-sw[data-color="#123456"]').waitFor({ state: 'detached' });
await A.locator('.dr-side .pal-bar button', { hasText: 'Done' }).click();
pal = (await list(A, 'palettes'))[0];
assert.equal(pal.colors.length, 3);

/* ---- Saved on this device; name, section and idea ---- */
await waitDrawingSaved(A);
assert.ok(await A.evaluate(async id => !!(await (await import('./js/core/store.js')).store.getFile(`drawings/${id}.png`)), drawingId));
await A.locator('.dr-name').click();
await dlg(A).locator('input[name=name]').fill('Termite texture');
assert.equal(await dlg(A).locator('select[name=idea]').inputValue(), 'i-termites');
await dlg(A).getByRole('button', { name: 'Save' }).click();
await A.locator('.dr-name', { hasText: 'Termite texture' }).waitFor();
assert.ok(await drawingNamed(A, 'Termite texture'));
await A.screenshot({ path: SHOTS + 'd5-editor-done.png' });

/* ---- Back to the gallery: thumbnails ---- */
await A.locator('.dr-top button[aria-label="Back"]').click();
await A.waitForFunction(() => location.hash === '#/ideas/d/s-mobs');
await A.locator('.dg-card').nth(1).waitFor();
assert.equal(await A.evaluate(() => document.body.classList.contains('dr-open')), false);
assert.equal(await A.locator('.topbar').isVisible(), true);
assert.deepEqual(await A.locator('.dg-name').allTextContents(), ['Termite texture', 'Termite (new colours)']);
await A.waitForTimeout(300);
assert.ok(await A.locator('.dg-card').first().locator('canvas').evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; }), 'the thumbnail shows the picture');
assert.match(await A.locator('.tk-head').textContent(), /2 drawings/);
assert.equal(await A.locator('.tk-flink[data-key="s-mobs"] .tk-fcount').textContent(), '2');
await A.screenshot({ path: SHOTS + 'd6-gallery.png' });

/* ---- Export PNG: exact pixels at 16 x 16 ---- */
await A.locator('.dg-card').first().locator('.dg-more').click();
await popup(A).locator('.popup-item', { hasText: 'Export PNG' }).click();
await dlg(A).locator('.dg-size').first().waitFor();
assert.deepEqual(await dlg(A).locator('.dg-size span:first-of-type').allTextContents(), ['16 × 16', '32 × 32', '64 × 64', '128 × 128', '256 × 256', '512 × 512', '1024 × 1024']);
assert.equal(await dlg(A).locator('input[name=size]:checked').getAttribute('value'), '1');
assert.equal(await dlg(A).locator('input[name=file]').inputValue(), 'termite_texture.png');
const [download] = await Promise.all([A.waitForEvent('download'), dlg(A).getByRole('button', { name: 'Download' }).click()]);
assert.equal(download.suggestedFilename(), 'termite_texture.png');
const out = SHOTS + 'termite_texture.png';
await download.saveAs(out);
const check = spawnSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(out)}).convert('RGBA')
print(im.size, im.getpixel((15, 15)), im.getpixel((2, 3)), im.getpixel((5, 5))[3], im.getpixel((8, 8)))
`], { encoding: 'utf8' });
assert.equal(check.stdout.trim(), '(16, 16) (179, 49, 44, 255) (245, 213, 71, 255) 0 (0, 0, 0, 255)', check.stderr);

/* ---- The idea's page shows its drawings ---- */
await A.goto(BASE + '#/ideas/i/i-termites');
await A.locator('.id-drawings .dg-card').first().waitFor();
assert.deepEqual(await A.locator('.id-drawings .dg-name').allTextContents(), ['Termite texture', 'Termite (new colours)']);
await A.locator('.id-drawings button', { hasText: 'New drawing for this idea' }).click();
assert.equal(await dlg(A).locator('select[name=idea]').inputValue(), 'i-termites');
assert.equal(await dlg(A).locator('select[name=section]').inputValue(), 's-mobs');
await dlg(A).getByRole('button', { name: 'Cancel' }).click();

/* ---- A free drawing: wide, smooth pen, no grid, full-detail export ---- */
await A.goto(BASE + '#/ideas/d/all');
await A.locator('.dg-head .btn-primary').click();
await dlg(A).locator('input[name=name]').fill('Oasis sketch');
await dlg(A).locator('.seg[aria-label="Kind"] [data-value="free"]').click();
await dlg(A).locator('.seg[aria-label="Shape"] [data-value="wide"]').click();
assert.equal(await dlg(A).locator('select[name=section]').inputValue(), '');
await dlg(A).getByRole('button', { name: 'Make drawing' }).click();
await A.locator('.dr-pic').waitFor();
assert.equal(await A.locator('.dr-pic').evaluate(c => `${c.width}x${c.height}`), '1024x768');
assert.equal(await A.locator('.dr-opts .seg[aria-label="Pen"] [aria-pressed="true"]').getAttribute('data-value'), 'free');
assert.equal(await A.locator('.dr-top-tools [aria-label="Grid"]').getAttribute('aria-pressed'), 'false');
await dragCells(A, [[10, 10], [30, 20], [50, 12]], 64);
assert.ok(await A.evaluate(() => {
  const d = document.querySelector('.dr-pic').getContext('2d').getImageData(0, 0, 1024, 768).data;
  let part = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] < 255) part++;
  return part > 50;
}), 'smooth edges on a see-through background');
await drMenu(A, 'Export PNG');
await dlg(A).locator('.dg-size').first().waitFor();
assert.equal(await dlg(A).locator('input[name=size]:checked').getAttribute('value'), '16');
assert.match(await dlg(A).locator('.dg-size:has(input:checked)').textContent(), /1024 × 768.*every detail/);
await dlg(A).getByRole('button', { name: 'Cancel' }).click();
await A.screenshot({ path: SHOTS + 'd6b-free.png' });
await waitDrawingSaved(A);
await A.locator('.dr-top button[aria-label="Back"]').click();
await A.locator('.dg-card', { hasText: 'Oasis sketch' }).waitFor();
assert.match(await A.locator('.dg-card', { hasText: 'Oasis sketch' }).textContent(), /Free drawing · Not sorted/);

/* ---- Check your changes, Push ---- */
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Push' }).click();
const rv = A.locator('dialog.modal-review');
await rv.waitFor();
const rvText = await rv.locator('.rv-list').textContent();
assert.match(rvText, /Termite texture.*New.*Drawing/);
assert.match(rvText, /Termite colours.*New.*Colour palette/);
const drItem = rv.locator('.rv-item', { hasText: 'Termite texture' });
await drItem.getByRole('button', { name: 'See changes' }).click();
await drItem.locator('.rv-pics-drawing img').waitFor();
assert.match(await drItem.locator('.rv-details').textContent(), /Kind.*Pixel art, 16 × 16.*Belongs to idea.*Termites/);
await A.screenshot({ path: SHOTS + 'd7-review.png' });
await rv.locator('[data-action="push"]').click();
await expectToast(A, /Pushed/);
assert.ok(gh.state.log.length >= 0);

/* ---------------- Device B: a phone ---------------- */
const B = await device('B', { viewport: { width: 384, height: 832 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' });
await pull(B);
await clearToasts(B);
await B.goto(BASE + '#/ideas/d/all');
await B.locator('.dg-card').nth(1).waitFor();
assert.equal(await overflows(B), false);
await B.screenshot({ path: SHOTS + 'd8-phone-gallery.png' });
await B.locator('.dg-name', { hasText: 'Termite texture' }).click();
await B.locator('.dr-pic').waitFor();
await B.waitForFunction(() => { const c = document.querySelector('.dr-pic'); return c && c.getContext('2d').getImageData(15 * 64 + 32, 15 * 64 + 32, 1, 1).data[3] === 255; });
assert.equal(await cellColor(B, 15, 15), '#b3312c/255', 'the picture came over');
assert.equal(await overflows(B), false);
assert.equal(await B.locator('.dr-side').isVisible(), false);
const toolsBox = await B.locator('.dr-tools').boundingBox();
assert.ok(toolsBox.y + toolsBox.height <= 832 + 1 && toolsBox.y > 600, 'the tools sit at the bottom');
const cdp = await B.context().newCDPSession(B);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
// One finger draws (black pixel pen by default on this device)
const c6 = await cellPoint(B, 6, 6);
await touch('touchStart', [c6]);
await touch('touchEnd', []);
assert.equal(await cellColor(B, 6, 6), '#000000/255');
// Two fingers zoom and don't draw
const before = await cellColor(B, 7, 9);
const zoom0 = await B.locator('.dr-zoom').textContent();
const cz = await cellPoint(B, 7, 9);
await touch('touchStart', [{ x: cz.x - 30, y: cz.y }, { x: cz.x + 30, y: cz.y }]);
for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: cz.x - 30 - i * 10, y: cz.y }, { x: cz.x + 30 + i * 10, y: cz.y }]); await B.waitForTimeout(16); }
await touch('touchEnd', []);
assert.notEqual(await B.locator('.dr-zoom').textContent(), zoom0, 'pinching zooms');
assert.equal(await cellColor(B, 7, 9), before, 'pinching does not draw');
// The colour button opens the colour dialog
await B.locator('.dr-current-btn').tap();
await B.locator('dialog.modal-color').waitFor();
await B.locator('dialog.modal-color .pal-sw[data-color="#2f78c4"]').tap();
await B.locator('dialog.modal-color').getByRole('button', { name: 'Use this colour' }).tap();
assert.equal(await B.locator('.dr-current-btn').evaluate(e => e.style.getPropertyValue('--c')), '#2f78c4');
// The ⋯ menu has the phone-only items
await B.locator('.dr-top-tools button[aria-label="More"]').tap();
await popup(B).waitFor();
const phoneItems = await popup(B).locator('.popup-label').allTextContents();
assert.ok(phoneItems.includes('Fit on screen') && phoneItems.includes('Show the grid') === false && phoneItems.includes('Hide the grid'));
await popup(B).locator('.popup-item', { hasText: 'Fit on screen' }).tap();
await B.screenshot({ path: SHOTS + 'd9-phone-editor.png' });
await cdp.detach();
await waitDrawingSaved(B);
await B.locator('.dr-top button[aria-label="Back"]').tap();
await B.locator('.dg-card').first().waitFor();
await push(B);
await pull(A);

/* ---- Delete a drawing ---- */
await A.goto(BASE + '#/ideas/d/all');
await A.locator('.dg-card').nth(1).waitFor();
await A.locator('.dg-card', { hasText: 'Termite (new colours)' }).locator('.dg-more').click();
await popup(A).locator('.popup-item', { hasText: 'Delete' }).click();
await dlg(A).getByRole('button', { name: 'Delete drawing' }).click();
await A.waitForFunction(() => document.querySelectorAll('.dg-card').length === 2);
assert.equal(await drawingNamed(A, 'Termite (new colours)'), null);
assert.equal(await A.evaluate(async id => !!(await (await import('./js/core/store.js')).store.getFile(`drawings/${id}.png`)), copy.id), false);

console.log('errors:', errors.length ? errors : 'none');
assert.equal(errors.length, 0);
await browser.close();
console.log('ALL DRAWING CHECKS PASSED');
