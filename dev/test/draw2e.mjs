// The drawing tools of part 2e: selections (rectangle, free shape, colour area; add, take away)
// with move, copy, cut, paste, delete, flip, quarter turns and RotSprite turns; drawing only
// inside a selection; polygon; gradient (steps, dither, round, tapped area); the effect brush;
// the Effects (outline, pixelate, blur, noise, hue); text; stamps (built-in, size, own colour,
// save as stamp, sync); the second colour; drawing across the edges in Tiles; copy and paste
// between split-screen halves of different sizes; a drawing as a wiki page picture; the phone.
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
const list = (page, col) => page.evaluate(async c => (await (await import('./js/core/store.js')).store.list(c)).map(r => ({ id: r.id, ...r.data })), col);

/* ---------- Drawing helpers ---------- */
const pic = page => page.locator('.dr-pane.active .dr-pic');
let N = 16;   // squares across the active drawing
async function cellPoint(page, x, y, n = N) {
  const b = await pic(page).boundingBox();
  const cs = b.width / n;
  return { x: b.x + (x + 0.5) * cs, y: b.y + (y + 0.5) * cs };
}
async function clickCell(page, x, y, opts) { await settle(page); const p = await cellPoint(page, x, y); await page.mouse.click(p.x, p.y, opts); }
async function dragCells(page, cells, { mods = [] } = {}) {
  await settle(page);
  const pts = [];
  for (const [x, y] of cells) pts.push(await cellPoint(page, x, y));
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
}
/** Every square's colour: "#rrggbb" ("" when see-through, "#rrggbb/aa" when partly). */
const cells = (page, n = N) => page.evaluate(n => {
  const c = document.querySelector('.dr-pane.active .dr-pic');
  const k = c.width / n, rows = c.height / k;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const out = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < n; x++) {
      const i = ((Math.floor(y * k + k / 2)) * c.width + Math.floor(x * k + k / 2)) * 4;
      const hex = `#${[d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('')}`;
      row.push(!d[i + 3] ? '' : d[i + 3] === 255 ? hex : `${hex}/${d[i + 3]}`);
    }
    out.push(row);
  }
  return out;
}, n);
const at = async (page, x, y) => (await cells(page))[y][x];
/** The picture as text: '.' see-through, '#' the colour given, '?' anything else. */
const art = async (page, color, box = null) => {
  const g = await cells(page);
  const [x0, y0, x1, y1] = box || [0, 0, g[0].length, g.length];
  return g.slice(y0, y1).map(r => r.slice(x0, x1).map(v => (!v ? '.' : v === color ? '#' : '?')).join('')).join('\n');
};
/** Two screen frames: the picture keeps its place on screen after bars change size. */
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const tool = async (page, id) => { await page.locator(`.dr-tool[data-tool="${id}"]`).click(); await settle(page); };
const optSeg = async (page, label, value) => { await page.locator(`.dr-opts .seg[aria-label="${label}"] [data-value="${value}"]`).click(); await settle(page); };
const selBtn = (page, label) => page.locator('.dr-selbar').getByRole('button', { name: label, exact: true });
async function setColor(page, hex) {
  await page.locator('.dr-side .cp-code').fill(hex);
  await page.waitForFunction(h => document.querySelector('.dr-side .dr-pair-front')?.style.getPropertyValue('--c') === h, hex);
  await page.evaluate(() => document.activeElement?.blur());
  await settle(page);
}
async function waitSaved(page) {
  await page.waitForFunction(() => /Saved on this device/.test(document.querySelector('.dr-status')?.textContent || ''), null, { timeout: 8000 });
}
async function newDrawing(page, data) {
  const id = await page.evaluate(async d => {
    const { createDrawing } = await import('./js/draw/model.js');
    return (await createDrawing(d)).id;
  }, data);
  await page.evaluate(id => { location.hash = `#/ideas/draw/${id}`; }, id);
  await page.waitForFunction(id => document.querySelector('.dr-pane.active')?.dataset.id === id, id);
  await page.waitForTimeout(150);
  return id;
}
async function clearPicture(page) {
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+d');
}
async function slide(page, name, value, scope = '.dr-opts') {
  await page.locator(`${scope} input[name="${name}"]`).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
}
const BLACK = '#000000', RED = '#b3312c', WHITE = '#ffffff';
let g = null;

/* ---------------- Device A: desktop ---------------- */
const A = await device('A', { viewport: { width: 1400, height: 900 } });
await A.evaluate(async () => {
  const { store } = await import('./js/core/store.js');
  await store.put('wiki', 'ostrich-egg', { name: 'Ostrich Egg', group: 'items', subgroup: 'misc', fields: {} });
});
await A.getByRole('tab', { name: 'Ideas' }).click();
const sprite = await newDrawing(A, { name: 'Sprite', width: 16, height: 16, kind: 'pixel' });
assert.equal(await A.locator('.dr-tool').count(), 13, 'all the tools on a PC');

/* ---- Second colour ---- */
await setColor(A, BLACK);
assert.equal(await A.locator('.dr-side .dr-pair-back').evaluate(e => e.style.getPropertyValue('--c')), WHITE);
await A.keyboard.press('x');
assert.equal(await A.locator('.dr-side .dr-pair-front').evaluate(e => e.style.getPropertyValue('--c')), WHITE);
assert.equal(await A.locator('.dr-side .cp-code').inputValue(), WHITE);
await A.locator('.dr-side .dr-pair-swap').click();
assert.equal(await A.locator('.dr-side .cp-code').inputValue(), BLACK);

/* ---- Select a rectangle; tools only change the inside ---- */
await tool(A, 'select');
assert.equal(await A.locator('.dr-selbar').isVisible(), true, 'the selection bar shows with the Select tool');
await dragCells(A, [[1, 1], [5, 3]]);
await A.locator('.dr-selbar').getByRole('button', { name: 'Copy' }).waitFor();
await tool(A, 'pen');
assert.equal(await A.locator('.dr-selbar').isVisible(), true, 'the bar stays while something is selected');
await dragCells(A, [[0, 2], [15, 2]]);
await dragCells(A, [[0, 8], [15, 8]]);
assert.equal(await art(A, BLACK, [0, 0, 16, 9]), [
  '................',
  '................',
  '.#####..........',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................'].join('\n'), 'the pen only draws inside the selection');
await A.keyboard.press('Control+d');
assert.equal(await A.locator('.dr-selbar').isVisible(), false);
await A.screenshot({ path: SHOTS + 'e1-select-clip.png' });

/* ---- Move: drag inside the selection; Done (Enter) lays it down; one Undo step ---- */
await dragCells(A, [[2, 4], [2, 5], [4, 5]]);   // (2,4) (3,5) (4,5): pixel-perfect takes out the corner
await tool(A, 'select');
await dragCells(A, [[1, 2], [4, 5]]);
await dragCells(A, [[2, 4], [9, 8]]);           // drag from inside: moves it 7 right, 4 down
assert.equal(await A.locator('.dr-selbar').getByRole('button', { name: 'Done' }).isVisible(), true, 'a floating piece shows Done');
await A.keyboard.press('Enter');
assert.equal(await art(A, BLACK, [0, 0, 16, 10]), [
  '................',
  '................',
  '.....#..........',
  '................',
  '................',
  '................',
  '........####....',
  '................',
  '.........#......',
  '..........##....'].join('\n'), 'moved 7 right and 4 down');
await A.keyboard.press('Control+z');
assert.equal(await at(A, 1, 2), BLACK, 'one Undo puts it back');
assert.equal(await at(A, 8, 6), '');
await A.keyboard.press('Control+y');
assert.equal(await at(A, 8, 6), BLACK);

/* ---- Escape (or Undo) while it floats puts it back ---- */
await A.keyboard.press('Control+d');
await dragCells(A, [[8, 6], [11, 9]]);
await dragCells(A, [[9, 8], [9, 12]]);
assert.equal(await at(A, 9, 12), BLACK);
await A.keyboard.press('Escape');
assert.equal(await at(A, 9, 12), '');
assert.equal(await at(A, 9, 8), BLACK, 'Escape put it back');

/* ---- Copy and paste (a copy, the original stays) ---- */
await A.keyboard.press('Control+d');
await dragCells(A, [[8, 6], [11, 9]]);
await selBtn(A, 'Copy').click();
await expectToast(A, /Copied/);
await selBtn(A, 'Paste').click();
assert.equal(await A.locator('.dr-selbar').getByRole('button', { name: 'Done' }).isVisible(), true);
await dragCells(A, [[9, 8], [3, 12]]);           // move the pasted copy 6 left, 4 down
await selBtn(A, 'Done').click();
assert.equal(await art(A, BLACK, [0, 6, 16, 14]), [
  '........####....',
  '................',
  '.........#......',
  '..........##....',
  '..####..........',
  '................',
  '...#............',
  '....##..........'].join('\n'), 'pasted copy, original kept');

/* ---- Cut, Delete ---- */
await A.keyboard.press('Control+x');
assert.equal(await art(A, BLACK, [0, 10, 8, 14]), ['........', '........', '........', '........'].join('\n'), 'cut');
await A.keyboard.press('Control+d');

/* ---- Flip and quarter turns (exact) ---- */
await dragCells(A, [[8, 6], [11, 9]]);
await selBtn(A, 'Mirror left-right').click();
await selBtn(A, 'Done').click();
assert.equal(await art(A, BLACK, [8, 6, 12, 10]), ['####', '....', '..#.', '##..'].join('\n'), 'mirrored left-right');
await selBtn(A, 'Mirror top-bottom').click();
await selBtn(A, 'Done').click();
assert.equal(await art(A, BLACK, [8, 6, 12, 10]), ['##..', '..#.', '....', '####'].join('\n'), 'mirrored top-bottom');
await selBtn(A, 'Turn a quarter right').click();
await A.keyboard.press('Enter');
assert.equal(await art(A, BLACK, [8, 6, 12, 10]), ['#..#', '#..#', '#.#.', '#...'].join('\n'), 'turned a quarter right');
await A.keyboard.press('Control+z');
await A.keyboard.press('Control+z');
await A.keyboard.press('Control+z');
assert.equal(await art(A, BLACK, [8, 6, 12, 10]), ['####', '....', '.#..', '..##'].join('\n'), 'three Undos: back to the start');
await A.keyboard.press('Control+d');

/* ---- RotSprite: a line turned 45 degrees stays one square thin, no new colours ---- */
await clearPicture(A);
await tool(A, 'pen');
await dragCells(A, [[3, 8], [12, 8]]);
await tool(A, 'select');
await dragCells(A, [[3, 8], [12, 8]]);
await selBtn(A, 'Turn by any angle').click();
await slide(A, 'angle', 45, '.dr-selbar');
await A.waitForTimeout(150);
await A.screenshot({ path: SHOTS + 'e2-rotsprite-float.png' });
await selBtn(A, 'Done').click();
const turned = await cells(A);
const colours = new Set(turned.flat().filter(Boolean));
assert.deepEqual([...colours], [BLACK], 'RotSprite: only the line colour, no blur');
const rowsUsed = turned.map(r => r.filter(Boolean).length).filter(n => n);
assert.ok(rowsUsed.length >= 6 && rowsUsed.every(n => n <= 2), `a thin diagonal: ${rowsUsed}`);
const total = turned.flat().filter(Boolean).length;
assert.ok(total >= 7 && total <= 12, `about as many squares as the line had: ${total}`);
await A.keyboard.press('Control+d');
assert.equal(await art(A, BLACK, [4, 5, 12, 13]), ['#.......', '.#......', '..#.....', '...#....', '....#...', '.....#..', '......#.', '.......#'].join('\n'), 'a clean diagonal');

/* ---- Colour area (magic wand), add and take away, free shape (lasso) ---- */
await clearPicture(A);
await tool(A, 'rect');
await optSeg(A, 'Shape', 'true');
await setColor(A, RED);
await dragCells(A, [[2, 2], [7, 6]]);
await dragCells(A, [[10, 2], [13, 6]]);
await optSeg(A, 'Shape', 'false');
await tool(A, 'select');
await optSeg(A, 'Select', 'wand');
await clickCell(A, 4, 4);
await A.keyboard.press('Delete');
assert.equal(await art(A, RED, [0, 1, 16, 7]), ['................', '..........####..', '..........####..', '..........####..', '..........####..', '..........####..'].join('\n'), 'connected: only the left box');
await A.keyboard.press('Control+z');
await A.keyboard.press('Control+d');
await optSeg(A, 'Colour area', 'true');
await clickCell(A, 4, 4);
await A.keyboard.press('Delete');
assert.equal(await art(A, RED, [0, 1, 16, 7]), ['................', '................', '................', '................', '................', '................'].join('\n'), 'everywhere: both boxes');
await A.keyboard.press('Control+z');
await A.keyboard.press('Control+d');
await optSeg(A, 'Colour area', 'false');
await optSeg(A, 'Select', 'rect');
await dragCells(A, [[2, 2], [4, 4]]);
await dragCells(A, [[10, 2], [11, 3]], { mods: ['Shift'] });          // Shift adds
await dragCells(A, [[3, 3], [3, 3]], { mods: ['Alt'] });                // a tap with Alt: nothing
await dragCells(A, [[2, 2], [2, 4]], { mods: ['Alt'] });                // Alt takes away the left column
await A.keyboard.press('Delete');
assert.equal(await art(A, RED, [0, 1, 16, 7]), ['................', '..#..###....##..', '..#..###....##..', '..#..###..####..', '..######..####..', '..######..####..'].join('\n'), 'add and take away');
await A.keyboard.press('Control+z');
await A.keyboard.press('Control+d');
// Free shape: a triangle, then the fill bucket only fills inside it
await optSeg(A, 'Select', 'lasso');
await dragCells(A, [[1, 8], [14, 8], [14, 14], [1, 8]]);
await tool(A, 'fill');
await setColor(A, BLACK);
await clickCell(A, 12, 12);
const tri = await cells(A);
assert.ok(tri[10][12] === BLACK && tri[9][6] === BLACK && tri[13][2] === '' && tri[11][3] === '' && tri[3][3] === RED, `fill inside the triangle only:\n${await art(A, BLACK)}`);
await A.keyboard.press('Control+d');
await A.screenshot({ path: SHOTS + 'e3-lasso-fill.png' });
await tool(A, 'select');
await optSeg(A, 'Select', 'rect');

/* ---- Polygon ---- */
await clearPicture(A);
await tool(A, 'polygon');
await clickCell(A, 2, 2);
await clickCell(A, 12, 2);
await clickCell(A, 12, 9);
await clickCell(A, 5, 12);
assert.equal(await A.locator('.dr-opts').getByRole('button', { name: 'Done' }).isVisible(), true);
await A.keyboard.press('Backspace');                 // takes back the last corner
await clickCell(A, 2, 12);
await clickCell(A, 2, 2);                            // the first corner again: closed
assert.equal(await A.locator('.dr-opts').getByRole('button', { name: 'Done' }).count(), 0, 'closed');
assert.equal(await art(A, BLACK, [0, 0, 16, 14]), [
  '................',
  '................',
  '..###########...',
  '..#.........#...',
  '..#.........#...',
  '..#.........#...',
  '..#.........#...',
  '..#.........#...',
  '..#.........#...',
  '..#........##...',
  '..#.....###.....',
  '..#.####........',
  '..##............',
  '................'].join('\n'), 'a closed polygon');
await A.keyboard.press('Control+z');
assert.equal(await at(A, 2, 2), '', 'one Undo step');
await optSeg(A, 'Shape', 'true');
for (const [x, y] of [[2, 2], [12, 2], [12, 12], [2, 12]]) await clickCell(A, x, y);
await A.keyboard.press('Enter');
assert.equal(await at(A, 7, 7), BLACK, 'filled');
assert.equal(await at(A, 13, 7), '');
await optSeg(A, 'Shape', 'false');

// Mirror drawing works for the polygon and stamps too
await clearPicture(A);
await A.locator('.dr-top-tools [aria-label^="Mirror drawing"]').click();
await popup(A).locator('.popup-item', { hasText: 'Left and right' }).click();
await tool(A, 'polygon');
await optSeg(A, 'Shape', 'true');
for (const [x, y] of [[1, 1], [4, 1], [1, 4]]) await clickCell(A, x, y);
await A.keyboard.press('Enter');
await tool(A, 'stamp');
await clickCell(A, 4, 11);
g = await cells(A);
assert.equal(g[1][1], BLACK); assert.equal(g[1][14], BLACK, 'the polygon is mirrored');
assert.equal(g[2][2], BLACK); assert.equal(g[2][13], BLACK);
assert.equal(g[9][2], '#e0313c'); assert.equal(g[9][13], '#e0313c', 'the stamp is mirrored');
assert.equal(g[10][2], '#ffb3b8'); assert.equal(g[10][13], '#ffb3b8', 'its highlight on the mirrored side too');
await A.locator('.dr-top-tools [aria-label^="Mirror drawing"]').click();
await popup(A).locator('.popup-item', { hasText: 'Off' }).click();
await tool(A, 'polygon');
await optSeg(A, 'Shape', 'false');

/* ---- Gradient: whole picture, 4 steps, no dither ---- */
await clearPicture(A);
await tool(A, 'gradient');
await optSeg(A, 'Gradient area', 'all');
await slide(A, 'steps', 4);
await optSeg(A, 'Dither', 'off');
await setColor(A, BLACK);
await dragCells(A, [[0, 8], [15, 8]]);
g = await cells(A);
const row = g[8];
assert.equal(row[0], BLACK);
assert.equal(row[15], WHITE);
assert.equal(new Set(row).size, 4, `4 colours: ${[...new Set(row)]}`);
assert.deepEqual(g[0], row, 'a straight gradient: the same down every column');
const bright = v => parseInt(v.slice(1, 3), 16);
assert.ok(row.every((v, i) => !i || bright(v) >= bright(row[i - 1])), 'darker to lighter');
// Ordered dither mixes neighbouring steps, still only 4 colours
await A.keyboard.press('Control+z');
await optSeg(A, 'Dither', 'ordered');
await dragCells(A, [[0, 8], [15, 8]]);
g = await cells(A);
assert.equal(new Set(g.flat()).size, 4);
assert.notDeepEqual(g[0], g[1], 'dithered rows differ');
await A.screenshot({ path: SHOTS + 'e4-gradient-dither.png' });
// Round, to see-through, only in the tapped area
await clearPicture(A);
await tool(A, 'rect');
await optSeg(A, 'Shape', 'true');
await setColor(A, RED);
await dragCells(A, [[4, 4], [11, 11]]);
await optSeg(A, 'Shape', 'false');
await tool(A, 'gradient');
await optSeg(A, 'Gradient', 'round');
await optSeg(A, 'Gradient colours', 'clear');
await optSeg(A, 'Gradient area', 'area');
await setColor(A, WHITE);
await dragCells(A, [[7, 7], [11, 7]]);
g = await cells(A);
assert.equal(g[2][2], '', 'outside the tapped area: nothing');
assert.equal(g[7][7], WHITE, 'the middle is colour 1');
assert.equal(g[11][4], RED, 'far away it fades to nothing (the red shows)');
await optSeg(A, 'Gradient', 'straight');
await optSeg(A, 'Gradient colours', 'color2');

/* ---- Effect brush ---- */
await clearPicture(A);
await tool(A, 'fill');
await setColor(A, '#808080');
await clickCell(A, 5, 5);
await tool(A, 'effect');
await A.locator('.dr-opts select[name=effect]').selectOption('lighten');
await slide(A, 'strength', 50);
await dragCells(A, [[0, 3], [15, 3], [0, 3], [15, 3]]);   // back and forth: each square once per stroke
g = await cells(A);
assert.notEqual(g[3][5], '#808080');
assert.ok(bright(g[3][5]) > 0x80, 'lighter');
assert.equal(new Set(g[3]).size, 1, 'the same everywhere on the stroke (once per square)');
assert.equal(g[2][5], '#808080', 'only where the brush went');
const once = g[3][5];
await dragCells(A, [[0, 3], [15, 3]]);
assert.ok(bright((await cells(A))[3][5]) > bright(once), 'a second stroke lightens more');
// Darken along the palette: steps to a darker Starter palette colour
await A.locator('.dr-opts select[name=effect]').selectOption('darken');
await A.locator('.dr-opts input[name=alongPalette]').check();
await dragCells(A, [[0, 6], [15, 6]]);
const stepped = (await cells(A))[6][5];
assert.ok(['#7a7a7a', '#3d3d3d', '#000000', '#5c1f1f', '#7a4e26'].includes(stepped), `a palette colour: ${stepped}`);
await A.locator('.dr-opts input[name=alongPalette]').uncheck();
// Dither: colour 1 and colour 2 in a checker pattern
await A.locator('.dr-opts select[name=effect]').selectOption('dither');
await setColor(A, BLACK);
await slide(A, 'strength', 50);
await A.locator('.dr-opts input[name=size]').evaluate(el => { el.value = 3; el.dispatchEvent(new Event('input', { bubbles: true })); });
await dragCells(A, [[0, 10], [15, 10]]);
g = await cells(A);
assert.deepEqual([g[10][4], g[10][5], g[11][4], g[11][5]].sort(), [BLACK, BLACK, WHITE, WHITE], 'a checker of the two colours');
assert.notEqual(g[10][4], g[10][5]);
await A.locator('.dr-opts input[name=size]').evaluate(el => { el.value = 1; el.dispatchEvent(new Event('input', { bubbles: true })); });
await A.screenshot({ path: SHOTS + 'e5-effect-brush.png' });


/* ---- Effects: outline (square and round corners, outside and inside), with a selection ---- */
async function effect(page, name) {
  await page.locator('.dr-top-tools [aria-label="Effects"]').click();
  await popup(page).locator('.popup-item', { hasText: name }).first().click();
  await dlg(page).locator('.fx-preview').waitFor();
}
await clearPicture(A);
await tool(A, 'pen');
await setColor(A, BLACK);
await clickCell(A, 8, 8);
await setColor(A, RED);
await effect(A, 'Outline');
await A.screenshot({ path: SHOTS + 'e6-outline-dialog.png' });
await dlg(A).getByRole('button', { name: 'Change this drawing' }).click();
await A.waitForFunction(() => !document.querySelector('dialog[open]'));
assert.equal(await art(A, RED, [6, 6, 11, 11]), ['.....', '.###.', '.#?#.', '.###.', '.....'].join('\n'), 'square outline around the dot');
await A.keyboard.press('Control+z');
await effect(A, 'Outline');
await dlg(A).locator('.seg[aria-label="Corners"] [data-value="round"]').click();
await dlg(A).getByRole('button', { name: 'Change this drawing' }).click();
assert.equal(await art(A, RED, [6, 6, 11, 11]), ['.....', '..#..', '.#?#.', '..#..', '.....'].join('\n'), 'round outline: no corners');
await A.keyboard.press('Control+z');
// Inside, on a filled box, only in the selection's half
await tool(A, 'rect');
await optSeg(A, 'Shape', 'true');
await setColor(A, BLACK);
await dragCells(A, [[2, 2], [7, 7]]);
await optSeg(A, 'Shape', 'false');
await tool(A, 'select');
await A.keyboard.press('Control+d');
await dragCells(A, [[0, 0], [4, 15]]);
await setColor(A, RED);
await effect(A, 'Outline');
assert.match(await dlg(A).textContent(), /Only inside the selection/);
await dlg(A).locator('.seg[aria-label="Where"] [data-value="inside"]').click();
await dlg(A).getByRole('button', { name: 'Change this drawing' }).click();
assert.equal(await art(A, RED, [2, 2, 8, 8]), ['###???', '#?????', '#?????', '#?????', '#?????', '###???'].join('\n'), 'inside outline, left part only');
await A.keyboard.press('Control+z');
await A.keyboard.press('Control+d');
// Hue: red box becomes another colour; Make a copy leaves this one as it is
await clearPicture(A);
await tool(A, 'fill');
await setColor(A, RED);
await clickCell(A, 1, 1);
await effect(A, 'Hue');
await slide(A, 'hue', 120, 'dialog[open]');
await dlg(A).getByRole('button', { name: 'Make a copy' }).click();
await expectToast(A, /Copy made/);
assert.equal(await at(A, 3, 3), RED, 'Make a copy: this drawing stays');
const copies = (await list(A, 'drawings')).filter(d => d.name === 'Sprite (new look)');
assert.equal(copies.length, 1, 'the copy was made');
await effect(A, 'Hue');
await slide(A, 'hue', 120, 'dialog[open]');
await dlg(A).getByRole('button', { name: 'Change this drawing' }).click();
const hued = await at(A, 3, 3);
assert.ok(hued !== RED && parseInt(hued.slice(3, 5), 16) > parseInt(hued.slice(1, 3), 16), `hue moved toward green: ${hued}`);
await A.keyboard.press('Control+z');
// Noise (pixel pen: one value per square), Pixelate is refused below 2 on pixel art
await effect(A, 'Noise');
await slide(A, 'amount', 60, 'dialog[open]');
await dlg(A).getByRole('button', { name: 'Change this drawing' }).click();
const noisy = await cells(A);
assert.ok(new Set(noisy.flat()).size > 5, 'noise: many shades');
const fineSame = await A.evaluate(() => {
  const c = document.querySelector('.dr-pane.active .dr-pic'), k = c.width / 16;
  const d = c.getContext('2d').getImageData(3 * k, 3 * k, k, k).data;
  for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return false;
  return true;
});
assert.ok(fineSame, 'every square stays one colour (pixel art)');
await A.keyboard.press('Control+z');

/* ---- Text: the pixel font ---- */
await clearPicture(A);
await tool(A, 'text');
await setColor(A, BLACK);
await clickCell(A, 1, 1);
await dlg(A).locator('textarea[name=text]').fill('Hi');
await A.screenshot({ path: SHOTS + 'e7-text-dialog.png' });
await dlg(A).getByRole('button', { name: 'Place text' }).click();
assert.equal(await A.locator('.dr-selbar').getByRole('button', { name: 'Done' }).isVisible(), true, 'text floats until Done');
await selBtn(A, 'Done').click();
assert.equal(await art(A, BLACK, [1, 1, 10, 8]), [
  '#...#..#.',
  '#...#....',
  '#...#.##.',
  '#####..#.',
  '#...#..#.',
  '#...#..#.',
  '#...#.###'].join('\n'), 'Hi in the pixel font');
await A.keyboard.press('Control+d');

/* ---- Stamps: built-in heart, 2x, my colour; save a selection as a stamp ---- */
await clearPicture(A);
await tool(A, 'stamp');
assert.match(await A.locator('.dr-stamp-btn').textContent(), /Heart/);
await clickCell(A, 8, 8);
g = await cells(A);
assert.equal(new Set(g.flat().filter(Boolean)).size, 3, 'the heart keeps its 3 colours');
assert.equal(g.flat().filter(Boolean).length, 27, 'a heart of 27 squares');
await A.keyboard.press('Control+z');
await optSeg(A, 'Stamp size', '2');
await optSeg(A, 'Stamp colours', 'true');
await clickCell(A, 8, 8);
g = await cells(A);
assert.equal(g.flat().filter(Boolean).length, 27 * 4, '2x: four times the squares');
assert.deepEqual([...new Set(g.flat().filter(Boolean))], [BLACK], 'in my colour');
await A.keyboard.press('Control+z');
await optSeg(A, 'Stamp size', '1');
await optSeg(A, 'Stamp colours', 'false');
// Dragging stamps a row of them
await dragCells(A, [[2, 3], [14, 3]]);
assert.ok((await cells(A)).flat().filter(Boolean).length > 27 + 15, `dragging stamps more than one:\n${await art(A, '#e0313c')}`);
await A.keyboard.press('Control+z');
// My own stamp from a selection
await tool(A, 'pen');
await setColor(A, '#2f78c4');
await dragCells(A, [[3, 3], [5, 3]]);
await clickCell(A, 4, 4);
await tool(A, 'select');
await dragCells(A, [[3, 3], [5, 4]]);
await A.locator('.dr-selbar [aria-label="More"]').click();
await popup(A).locator('.popup-item', { hasText: 'Save as stamp' }).click();
await dlg(A).locator('input[name=name]').fill('Blue T');
await dlg(A).getByRole('button', { name: 'Save stamp' }).click();
await expectToast(A, /Stamp saved/);
const stampRows = await list(A, 'stamps');
assert.equal(stampRows.length, 1);
assert.deepEqual({ name: stampRows[0].name, kind: stampRows[0].kind, scale: stampRows[0].scale }, { name: 'Blue T', kind: 'pixel', scale: 1 });
const stampPng = await A.evaluate(async id => { const f = await (await import('./js/core/store.js')).store.getFile(`stamps/${id}.png`); const b = await createImageBitmap(f.blob); return `${b.width}x${b.height}`; }, stampRows[0].id);
assert.equal(stampPng, '3x2', 'one pixel per square');
await A.keyboard.press('Control+d');
await clearPicture(A);
await tool(A, 'stamp');
await A.locator('.dr-stamp-btn').click();
await dlg(A).locator('.st-item', { hasText: 'Blue T' }).waitFor();
await A.screenshot({ path: SHOTS + 'e8-stamps.png' });
await dlg(A).locator('.st-item', { hasText: 'Blue T' }).click();
await clickCell(A, 10, 10);
assert.equal(await art(A, '#2f78c4', [8, 9, 13, 12]), ['.....', '.###.', '..#..'].join('\n'), 'my stamp, centred where I tapped (the outline shows where)');

/* ---- Tiles: drawing past an edge comes back in on the other side ---- */
await clearPicture(A);
await A.locator('.dr-top-tools [aria-label^="Tiles"]').click();
await A.waitForTimeout(200);
await tool(A, 'pen');
await setColor(A, BLACK);
await clickCell(A, 16 + 2, 3);       // in the tile to the right
await clickCell(A, -1, -1);          // in the tile up and to the left
assert.equal(await at(A, 2, 3), BLACK, 'wrapped from the right tile');
assert.equal(await at(A, 15, 15), BLACK, 'wrapped from the top-left tile');
await dragCells(A, [[14, 6], [17, 6]]);
assert.equal(await art(A, BLACK, [0, 6, 16, 7]), '##............##', 'a line across the right edge comes back on the left');
await A.screenshot({ path: SHOTS + 'e9-tiles-wrap.png' });
await A.locator('.dr-top-tools [aria-label^="Tiles"]').click();
await A.waitForTimeout(200);
await waitSaved(A);

/* ---- A free drawing: smooth turn, smooth gradient ---- */
N = 64;
const sketch = await newDrawing(A, { name: 'Sketch', width: 64, height: 64, kind: 'free' });
assert.equal(await A.locator('.dr-opts .seg[aria-label="Pen"] [aria-pressed="true"]').getAttribute('data-value'), 'free');
await tool(A, 'gradient');
await optSeg(A, 'Gradient area', 'all');
await setColor(A, BLACK);
await dragCells(A, [[0, 30], [63, 30]]);
g = await cells(A);
assert.ok(new Set(g[30]).size > 40, 'free pen: a smooth gradient');
await A.keyboard.press('Control+z');
await tool(A, 'rect');
await optSeg(A, 'Shape', 'true');
await dragCells(A, [[20, 28], [44, 36]]);
await tool(A, 'select');
await dragCells(A, [[18, 26], [46, 38]]);
await selBtn(A, 'Turn by any angle').click();
await slide(A, 'angle', 30, '.dr-selbar');
await A.waitForTimeout(150);
await selBtn(A, 'Done').click();
const soft = await A.evaluate(() => {
  const c = document.querySelector('.dr-pane.active .dr-pic');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let part = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] < 255) part++;
  return part;
});
assert.ok(soft > 50, `a smooth turn has soft edges (${soft})`);
await A.keyboard.press('Control+d');

// The effect brush with the free pen: darkens smoothly where it goes
await tool(A, 'effect');
await A.locator('.dr-opts select[name=effect]').selectOption('darken');
await slide(A, 'strength', 60);
await dragCells(A, [[28, 32], [36, 32]]);
g = await cells(A);
const darker = g[32][32];
assert.ok(darker && darker !== BLACK || g[32][32] === BLACK, 'the brush went over the black block');
await A.keyboard.press('Control+z');
await tool(A, 'fill');
await setColor(A, '#c0c0c0');
await clickCell(A, 2, 2);
await tool(A, 'effect');
await dragCells(A, [[4, 50], [40, 50]]);
g = await cells(A);
assert.ok(bright(g[50][20]) < 0xc0, `darker where it went (${g[50][20]})`);
assert.equal(g[40][20], '#c0c0c0', 'unchanged elsewhere');
await A.keyboard.press('Control+z');
await A.keyboard.press('Control+z');
// Pixelate a free drawing to its squares: crisp pixel art (every square one colour)
await setColor(A, '#e8603c');
await tool(A, 'pen');
await dragCells(A, [[5, 5], [30, 20], [50, 8]]);
await effect(A, 'Pixelate');
assert.match(await dlg(A).textContent(), /the squares/);
await dlg(A).getByRole('button', { name: 'Change this drawing' }).click();
const crisp = await A.evaluate(() => {
  const c = document.querySelector('.dr-pane.active .dr-pic'), k = c.width / 64;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let cy = 0; cy < 64; cy++) for (let cx = 0; cx < 64; cx++) {
    const i0 = ((cy * k) * c.width + cx * k) * 4;
    for (let y = 0; y < k; y += 5) for (let x = 0; x < k; x += 5) { const i = ((cy * k + y) * c.width + cx * k + x) * 4; for (let t = 0; t < 4; t++) if (d[i + t] !== d[i0 + t]) return false; }
  }
  return true;
});
assert.ok(crisp, 'pixelated to whole squares');
await A.keyboard.press('Control+z');
// Blur on the free pen: soft edges
await effect(A, 'Blur');
await slide(A, 'radius', 8, 'dialog[open]');
await dlg(A).getByRole('button', { name: 'Change this drawing' }).click();
const blurred = await A.evaluate(() => {
  const c = document.querySelector('.dr-pane.active .dr-pic');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let part = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] < 255) part++;
  return part;
});
assert.ok(blurred > 5000, `blurred: soft edges (${blurred})`);
await A.keyboard.press('Control+z');
// Use this drawing as a stamp (trimmed to what's drawn), kept at its size in squares
await A.locator('.dr-top-tools button[aria-label="More"]').click();
await popup(A).locator('.popup-item', { hasText: 'Use this drawing as a stamp' }).click();
assert.equal(await dlg(A).locator('input[name=name]').inputValue(), 'Sketch');
await dlg(A).getByRole('button', { name: 'Save stamp' }).click();
await expectToast(A, /Stamp saved/);
const sk = (await list(A, 'stamps')).find(r => r.name === 'Sketch');
assert.deepEqual({ kind: sk.kind, scale: sk.scale }, { kind: 'free', scale: 16 });

/* ---- Split screen: copy in one half, paste in the other (same size in squares) ---- */
await A.locator('.dr-top-tools button[aria-label="More"]').click();
await popup(A).locator('.popup-item', { hasText: 'Split screen with' }).click();
await popup(A).locator('.popup-item', { hasText: 'Sprite' }).click();
await A.locator('.dr-panes.split').waitFor();
await A.locator(`.dr-pane[data-id="${sprite}"] .dr-stage`).click({ position: { x: 3, y: 3 } });   // the Sprite half is active
await A.waitForFunction(id => document.querySelector('.dr-pane.active')?.dataset.id === id, sprite);
N = 16;
await tool(A, 'pen');
await setColor(A, '#2f78c4');
await dragCells(A, [[8, 9], [10, 9]]);
await clickCell(A, 8, 10);
await tool(A, 'select');
await A.keyboard.press('Control+d');
await dragCells(A, [[8, 9], [10, 10]]);
await A.keyboard.press('Control+c');
await expectToast(A, /Copied/);
await A.locator(`.dr-pane[data-id="${sketch}"] .dr-stage`).click({ position: { x: 3, y: 3 } });
await A.waitForFunction(id => document.querySelector('.dr-pane.active')?.dataset.id === id, sketch);
await A.keyboard.press('Control+d');
await selBtn(A, 'Paste').click();
const pastedBox = await A.evaluate(() => {
  const c = document.querySelector('.dr-pane.active .dr-pic');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] === 0x2f && d[i + 1] === 0x78 && d[i + 2] === 0xc4 && d[i + 3] === 255) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, k: c.width / 64 };
});
assert.deepEqual(pastedBox, { w: 3 * 16, h: 2 * 16, k: 16 }, 'the same size in squares in the bigger drawing');
await selBtn(A, 'Done').click();
await A.screenshot({ path: SHOTS + 'e10-split-paste.png' });
await A.locator('.dr-top-tools button[aria-label="More"]').click();
await popup(A).locator('.popup-item', { hasText: 'Close split screen' }).click();
await A.keyboard.press('Control+d');

/* ---- Ctrl+V of a picture copied on the computer: one pixel per square when it fits ---- */
await A.evaluate(id => { location.hash = `#/ideas/draw/${id}`; }, sprite);
await A.waitForFunction(id => document.querySelector('.dr-pane.active')?.dataset.id === id, sprite);
await clearPicture(A);
await A.evaluate(async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 4, height: 3 });
  const g = c.getContext('2d');
  g.fillStyle = '#00aa55'; g.fillRect(0, 0, 4, 3);
  g.fillStyle = '#ff8800'; g.fillRect(1, 1, 2, 1);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'leaf.png', { type: 'image/png' }));
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await expectToast(A, /one pixel per square/);
await A.keyboard.press('Enter');
g = await cells(A);
const green = g.flat().filter(v => v === '#00aa55').length, orange = g.flat().filter(v => v === '#ff8800').length;
assert.deepEqual({ green, orange }, { green: 10, orange: 2 }, 'a 4 x 3 picture became 4 x 3 squares');
await A.keyboard.press('Control+d');

/* ---- A drawing as a wiki page picture ---- */
await A.locator('.dr-top-tools button[aria-label="More"]').click();
await popup(A).locator('.popup-item', { hasText: 'Use as a wiki page picture' }).click();
await dlg(A).locator('input[name=page]').fill('ostrich');
await dlg(A).locator('.wp-item', { hasText: 'Ostrich Egg' }).click();
await dlg(A).getByRole('button', { name: 'Use picture' }).click();
await expectToast(A, /on “Ostrich Egg” now/);
const page = await A.evaluate(async () => {
  const { store } = await import('./js/core/store.js');
  const p = await store.get('wiki', 'ostrich-egg');
  const f = await store.getFile(p.data.picture);
  const b = await createImageBitmap(f.blob);
  return { path: p.data.picture, size: `${b.width}x${b.height}` };
});
assert.match(page.path, /^images\/ostrich-egg-.+\.png$/);
assert.equal(page.size, '16x16', 'pixel art at one pixel per square');
const wikiPic = await A.evaluate(async p => {
  const f = await (await import('./js/core/store.js')).store.getFile(p);
  const b = await createImageBitmap(f.blob);
  const c = new OffscreenCanvas(16, 16), g = c.getContext('2d');
  g.drawImage(b, 0, 0);
  const d = g.getImageData(0, 0, 16, 16).data, n = {};
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { const k = `${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`; n[k] = (n[k] || 0) + 1; }
  return n;
}, page.path);
assert.deepEqual(wikiPic, { '0,170,85,255': 10, '255,136,0,255': 2 }, 'the exact colours');
// From the wiki editor: "From a drawing"
await A.locator('.dr-top button[aria-label="Back"]').click();
await A.locator('.dg-card').first().waitFor();
await A.evaluate(() => { location.hash = '#/wiki/e/ostrich-egg'; });
await A.locator('.ed-picture').waitFor();
await A.locator('.ed-picture img').waitFor();
const src0 = await A.locator('.ed-picture img').getAttribute('src');
await A.locator('.ed-picture').getByRole('button', { name: 'From a drawing' }).click();
await dlg(A).locator('.wp-card', { hasText: 'Sketch' }).click();
await A.waitForFunction(s0 => { const img = document.querySelector('.ed-picture img'); return img && img.getAttribute('src') !== s0; }, src0);
await A.getByRole('button', { name: 'Done', exact: true }).click();
const after = await A.evaluate(async () => {
  const { store } = await import('./js/core/store.js');
  const p = await store.get('wiki', 'ostrich-egg');
  const f = await store.getFile(p.data.picture);
  const b = await createImageBitmap(f.blob);
  return { path: p.data.picture, size: `${b.width}x${b.height}` };
});
assert.notEqual(after.path, page.path);
assert.equal(after.size, '1024x1024', 'a free drawing with every detail');
assert.equal(await A.evaluate(async p => !!(await (await import('./js/core/store.js')).store.getFile(p)), page.path), false, 'the replaced picture was tidied away');


/* ---- Push: drawings and the stamp (with its picture) ---- */
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Push' }).click();
const rv = A.locator('dialog.modal-review');
await rv.waitFor();
const stampItem = rv.locator('.rv-item', { hasText: 'Blue T' });
assert.match(await stampItem.textContent(), /New.*Stamp/);
await stampItem.getByRole('button', { name: 'See changes' }).click();
await stampItem.locator('.rv-pics-drawing img').waitFor();
assert.match(await stampItem.locator('.rv-details').textContent(), /Name.*Blue T.*Kind.*Pixel art/);
await rv.locator('[data-action="push"]').click();
await expectToast(A, /Pushed/);
assert.ok(Object.keys(gh.files()).some(p => /^files\/stamps\/st-.+\.png$/.test(p)), 'the stamp picture is on GitHub');

/* ---------------- Device B: a phone ---------------- */
const B = await device('B', { viewport: { width: 384, height: 832 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' });
await clearToasts(B);
await B.locator('.sync-btn', { hasText: 'Pull' }).click();
await expectToast(B, /Pulled/);
await B.evaluate(id => { location.hash = `#/ideas/draw/${id}`; }, sprite);
await B.locator('.dr-pane.active .dr-pic').waitFor();
await B.waitForTimeout(300);
const overflows = page => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
assert.equal(await B.locator('.dr-tool').count(), 8, 'the phone has 8 tool buttons (some share one)');
const bar = await B.locator('.dr-tools').boundingBox();
const lastTool = await B.locator('.dr-tool').last().boundingBox();
assert.ok(lastTool.x + lastTool.width <= 384 + 1 && bar.y + bar.height <= 832 + 1, 'the tools fit');
// Shapes share a button: tap = the last shape used; tap again = choose
await B.locator('.dr-tool[data-tool="shapes"]').tap();
assert.equal(await B.locator('.dr-tool[data-tool="shapes"]').getAttribute('aria-pressed'), 'true');
await B.locator('.dr-tool[data-tool="shapes"]').tap();
await popup(B).waitFor();
assert.deepEqual(await popup(B).locator('.popup-label').allTextContents(), ['Line', 'Rectangle', 'Ellipse', 'Polygon']);
await popup(B).locator('.popup-item', { hasText: 'Polygon' }).tap();
assert.equal(await B.locator('.dr-opts .seg[aria-label="Shapes"] [aria-pressed="true"]').getAttribute('data-value'), 'polygon');
await B.screenshot({ path: SHOTS + 'e11-phone-shapes.png' });
// Select with a finger; the bar sits at the bottom of the picture area and fits
await B.locator('.dr-tool[data-tool="select"]').tap();
const cdp = await B.context().newCDPSession(B);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
const pb = await B.locator('.dr-pane.active .dr-pic').boundingBox();
const cp = (x, y) => ({ x: pb.x + (x + 0.5) * pb.width / 16, y: pb.y + (y + 0.5) * pb.width / 16 });
await touch('touchStart', [cp(1, 1)]);
for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: cp(1, 1).x + (cp(6, 5).x - cp(1, 1).x) * i / 8, y: cp(1, 1).y + (cp(6, 5).y - cp(1, 1).y) * i / 8 }]); await B.waitForTimeout(16); }
await touch('touchEnd', []);
await B.locator('.dr-selbar').getByRole('button', { name: 'Copy' }).waitFor();
await B.waitForTimeout(600);   // the emulated phone takes a tap right after a finger drag as a double tap
const sb = await B.locator('.dr-selbar').boundingBox();
const panesBox = await B.locator('.dr-panes').boundingBox();
assert.ok(sb.x >= 0 && sb.x + sb.width <= 384 + 1, 'the selection bar fits across');
assert.ok(sb.y + sb.height <= panesBox.y + panesBox.height + 1 && sb.y > panesBox.y + panesBox.height / 2, 'at the bottom of the picture area');
assert.equal(await overflows(B), false);
await B.screenshot({ path: SHOTS + 'e12-phone-select.png' });
assert.ok(sb.height < 60, `one row on the phone (${sb.height})`);
await cdp.detach();
await B.locator('.dr-selbar').getByRole('button', { name: 'Turn by any angle' }).tap();
await B.locator('.dr-selbar input[name=angle]').waitFor();
await B.screenshot({ path: SHOTS + 'e13-phone-float.png' });
assert.equal(await overflows(B), false);
await B.screenshot({ path: SHOTS + 'e13-phone-float.png' });
await B.locator('.dr-selbar').getByRole('button', { name: 'Put it back' }).tap();
// Effects are in ⋯ on the phone
await B.locator('.dr-top-tools button[aria-label="More"]').tap();
await popup(B).locator('.popup-item', { hasText: 'Effects' }).tap();
await popup(B).locator('.popup-item', { hasText: 'Outline' }).tap();
await dlg(B).locator('.fx-preview').waitFor();
assert.equal(await overflows(B), false);
await B.screenshot({ path: SHOTS + 'e14-phone-outline.png' });
await dlg(B).getByRole('button', { name: 'Cancel' }).tap();
// The stamp came over
await B.locator('.dr-tool[data-tool="add"]').tap();
await B.locator('.dr-tool[data-tool="add"]').tap();
await popup(B).locator('.popup-item', { hasText: 'Stamp' }).tap();
await B.locator('.dr-stamp-btn').tap();
await dlg(B).locator('.st-item', { hasText: 'Blue T' }).waitFor();
await B.screenshot({ path: SHOTS + 'e15-phone-stamps.png' });
await dlg(B).locator('[data-action="cancel"]').tap();
await B.screenshot({ path: SHOTS + 'e16-phone-stamp-tool.png' });
assert.equal(await overflows(B), false);

console.log('errors:', errors.length ? errors : 'none');
assert.equal(errors.length, 0);
await browser.close();
console.log('ALL 2E DRAWING CHECKS PASSED');
