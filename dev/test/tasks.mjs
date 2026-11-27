// Tasks & Bugs (part 2c): quick add, Task/Bug, folders (new, nested, drag, move, rename, delete),
// ticking done, filters and search (remembered), list and board (drag cards between columns),
// the task page (fields, links, description with [[ links, undo, delete), the "Tasks & bugs"
// box on wiki pages (new task for the page, cross-tab Back), Copy tasks for Claude, Check your
// changes before Push, Import, and a phone that pulls it all (folders dropdown, finger drag).
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
const folderNamed = async (page, name) => (await list(page, 'task-folders')).find(f => f.name === name) || null;
async function waitSaved(page) {
  await page.waitForFunction(() => document.querySelector('.ed-status')?.textContent === 'Saved on this device', null, { timeout: 5000 });
}
const item = (page, title) => page.locator('.tk-item', { has: page.locator('.tk-title', { hasText: new RegExp(`^${title}$`) }) });
const card = (page, title) => page.locator('.tb-card', { has: page.locator('.tk-title', { hasText: new RegExp(`^${title}$`) }) });
const titles = (page, sel = '.tk-content .tk-title') => page.locator(sel).allTextContents();
async function quickAdd(page, title) {
  await page.locator('.tk-add-input').fill(title);
  await page.locator('.tk-add-input').press('Enter');
  await item(page, title).or(card(page, title)).first().waitFor();
}
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

/* ---------------- Device A: desktop ---------------- */
const A = await device('A', { viewport: { width: 1280, height: 900 } });
await importText(A, STARTER);
await dlg(A).locator('.modal-actions button.btn-primary').click();
await A.waitForFunction(() => !document.querySelector('dialog[open]'));
await push(A);

// The tab starts empty
await A.getByRole('tab', { name: 'Tasks & Bugs' }).click();
await A.locator('h1', { hasText: 'All tasks' }).waitFor();
assert.match(await A.locator('.tk-empty').textContent(), /No tasks yet/);

// Quick add: Enter adds a Task; the box stays ready for the next one; the Bug switch is remembered
await quickAdd(A, 'Natural spawns for all mobs');
assert.equal(await A.evaluate(() => document.activeElement?.classList.contains('tk-add-input')), true);
await A.locator('.tk-add .seg-btn', { hasText: 'Bug' }).click();
assert.equal(await A.locator('.tk-add-input').getAttribute('placeholder'), 'Add a bug, then press Enter');
await quickAdd(A, 'Ostrich egg takes 11 hours to hatch');
let t = await taskNamed(A, 'Ostrich egg takes 11 hours to hatch');
assert.deepEqual([t.type, t.priority, t.status, t.folder], ['bug', 'normal', 'todo', null]);
assert.ok(t.created && /^t-/.test(t.id));
assert.equal(await item(A, 'Ostrich egg takes 11 hours to hatch').locator('.tag-bug').count(), 1);
await A.locator('.tk-add .seg-btn', { hasText: 'Task' }).click();

/* ---- Folders ---- */
await A.getByRole('button', { name: 'New folder' }).click();
await dlg(A).locator('input[name=name]').fill('Mobs');
await dlg(A).locator('input[name=name]').press('Enter');
await A.locator('h1', { hasText: 'Mobs' }).waitFor();
const mobs = await folderNamed(A, 'Mobs');
assert.equal(await A.evaluate(() => location.hash), `#/tasks/f/${mobs.id}`);
await quickAdd(A, 'Hippo model');
assert.equal((await taskNamed(A, 'Hippo model')).folder, mobs.id);
// A folder inside it (from the ⋮⋮ menu), with a task
const mobsHandle = A.locator(`.tk-frow[data-folder="${mobs.id}"] > .tk-fline .tk-fhandle`);
const labels = await menu(A, mobsHandle, 'New folder inside');
assert.deepEqual(labels, ['New folder inside', 'Rename', 'Move into another folder…', 'Delete folder']);
assert.equal(await dlg(A).locator('select[name=parent]').inputValue(), mobs.id);
await dlg(A).locator('input[name=name]').fill('Ostrich');
await dlg(A).getByRole('button', { name: 'Make folder' }).click();
await A.locator('h1', { hasText: /^Ostrich$/ }).waitFor();
const ostrichF = await folderNamed(A, 'Ostrich');
assert.equal(ostrichF.parent, mobs.id);
assert.match(await A.locator('.crumbs').textContent(), /Tasks & Bugs.*Mobs.*Ostrich/);
await quickAdd(A, 'Ostrich dash cooldown');
// Mobs shows its sub-folder's tasks too, with the folder they're in
await A.locator('.tk-flink', { hasText: /^Mobs/ }).click();
await A.locator('h1', { hasText: /^Mobs$/ }).waitFor();
assert.deepEqual((await titles(A)).sort(), ['Hippo model', 'Ostrich dash cooldown']);
assert.match(await item(A, 'Ostrich dash cooldown').locator('.tk-where').textContent(), /Ostrich/);
assert.equal(await item(A, 'Hippo model').locator('.tk-where').count(), 0);
assert.equal(await A.locator('.tk-flink', { hasText: /^Mobs/ }).locator('.tk-fcount').textContent(), '2');
assert.equal(await A.locator('.tk-flink', { hasText: /^All tasks/ }).locator('.tk-fcount').textContent(), '4');
// Another top-level folder, dragged above Mobs
await A.getByRole('button', { name: 'New folder' }).click();
await dlg(A).locator('input[name=name]').fill('World gen');
await dlg(A).locator('select[name=parent]').selectOption('');
await dlg(A).getByRole('button', { name: 'Make folder' }).click();
await A.locator('h1', { hasText: 'World gen' }).waitFor();
const world = await folderNamed(A, 'World gen');
const topOrder = () => A.locator('.tk-fnav > .tk-flist > .tk-frow').evaluateAll(els => els.map(e => e.dataset.folder));
assert.deepEqual(await topOrder(), [mobs.id, world.id]);
const target = await A.locator(`.tk-frow[data-folder="${mobs.id}"]`).boundingBox();
await mouseDrag(A, A.locator(`.tk-frow[data-folder="${world.id}"] > .tk-fline .tk-fhandle`), { x: target.x + 40, y: target.y + 4 });
await A.waitForFunction(id => document.querySelector('.tk-fnav > .tk-flist > .tk-frow')?.dataset.folder === id, world.id);
assert.ok((await folderNamed(A, 'World gen')).order < (await folderNamed(A, 'Mobs')).order);
// Rename, move into another folder, can't delete a folder with things in it, delete an empty one
await menu(A, A.locator(`.tk-frow[data-folder="${world.id}"] > .tk-fline .tk-fhandle`), 'Rename');
await dlg(A).locator('input[name=name]').fill('World');
await dlg(A).locator('input[name=name]').press('Enter');
await A.locator('.tk-flink', { hasText: /^World/ }).locator('.tk-fname', { hasText: /^World$/ }).waitFor();
await menu(A, A.locator(`.tk-frow[data-folder="${world.id}"] > .tk-fline .tk-fhandle`), 'Move into another folder…');
assert.ok(!(await dlg(A).locator('select[name=parent] option').allTextContents()).some(x => x.trim() === 'World'));
await dlg(A).locator('select[name=parent]').selectOption(mobs.id);
await dlg(A).getByRole('button', { name: 'Move' }).click();
await A.waitForFunction(id => document.querySelector(`.tk-frow[data-folder="${id}"]`)?.parentElement.closest('.tk-frow') !== null, world.id);
assert.equal((await folderNamed(A, 'World')).parent, mobs.id);
await menu(A, mobsHandle, 'Delete folder');
assert.match(await dlg(A).textContent(), /It has 2 tasks and 2 folders inside/);
assert.equal(await dlg(A).locator('input[name=keep]').isChecked(), true);
await dlg(A).getByRole('button', { name: 'Cancel' }).click();
await menu(A, A.locator(`.tk-frow[data-folder="${world.id}"] > .tk-fline .tk-fhandle`), 'Delete folder');
await dlg(A).getByRole('button', { name: 'Delete folder' }).click();
await A.waitForFunction(id => !document.querySelector(`.tk-frow[data-folder="${id}"]`), world.id);
assert.equal(await folderNamed(A, 'World'), null);
await A.waitForFunction(() => location.hash.startsWith('#/tasks/f/'));      // left the deleted folder
await A.screenshot({ path: SHOTS + 't1-folders.png' });

/* ---- Done, filters, search ---- */
await A.locator('.tk-flink', { hasText: /^All tasks/ }).click();
await A.locator('h1', { hasText: 'All tasks' }).waitFor();
await item(A, 'Hippo model').locator('.tk-tick').click();
await A.locator('.tk-donebox summary', { hasText: 'Done (1)' }).waitFor();
t = await taskNamed(A, 'Hippo model');
assert.equal(t.status, 'done');
assert.ok(t.doneAt);
assert.equal(await A.locator('.tk-donebox').getAttribute('open'), null);     // folded away
await A.locator('.tk-donebox summary').click();
await item(A, 'Hippo model').locator('.tk-tick').click();
await A.waitForFunction(() => !document.querySelector('.tk-donebox'));
t = await taskNamed(A, 'Hippo model');
assert.equal(t.status, 'todo');
assert.equal(t.doneAt, undefined);
// Bugs only, then a priority, then search
await A.locator('.fchip', { hasText: /^Bugs$/ }).click();
assert.deepEqual(await titles(A), ['Ostrich egg takes 11 hours to hatch']);
assert.match(await A.locator('.tk-count').textContent(), /Showing 1 of 4/);
await A.locator('.fchip', { hasText: /^All$/ }).click();
await A.locator('.fchip', { hasText: 'Critical' }).click();
assert.match(await A.locator('.tk-empty').textContent(), /No tasks match/);
await A.locator('.fchip', { hasText: 'Critical' }).click();
await A.locator('.tk-search').fill('ostrich');
assert.deepEqual((await titles(A)).sort(), ['Ostrich dash cooldown', 'Ostrich egg takes 11 hours to hatch']);
assert.equal(await A.evaluate(() => document.activeElement?.classList.contains('tk-search')), true);
await A.locator('.tk-search').fill('');
// Filters are remembered on this device
await A.locator('.fchip', { hasText: /^Tasks$/ }).click();
await A.reload();
await A.locator('h1', { hasText: 'All tasks' }).waitFor();
assert.equal(await A.locator('.fchip', { hasText: /^Tasks$/ }).getAttribute('aria-pressed'), 'true');
await A.locator('.fchip', { hasText: /^All$/ }).click();

/* ---- Priority and difficulty: tap the pill to change it; sort easiest first ---- */
await item(A, 'Hippo model').locator('.tag-pri').click();
await popup(A).waitFor();
assert.deepEqual(await popup(A).locator('.popup-label').allTextContents(), ['Critical', 'High', 'Normal', 'Low']);
await popup(A).locator('.popup-item', { hasText: 'Low' }).click();
await A.waitForFunction(() => document.querySelector('.tk-item[data-task] .tag-pri-low') !== null);
assert.equal((await taskNamed(A, 'Hippo model')).priority, 'low');
assert.equal(await A.evaluate(() => location.hash), '#/tasks');          // stayed on the list
const diff = async (title, pick) => {
  await item(A, title).locator('.tag-diff').click();
  await popup(A).waitFor();
  await popup(A).locator('.popup-item', { hasText: pick }).first().click();
  await A.waitForFunction(([t, p]) => [...document.querySelectorAll('.tk-item')].some(e => e.textContent.includes(t) && e.querySelector('.tag-diff')?.textContent === p), [title, pick]);
};
assert.equal(await item(A, 'Hippo model').locator('.tag-diff').textContent(), 'Difficulty?');
await diff('Hippo model', 'Quick');
await diff('Natural spawns for all mobs', 'Big');
await diff('Ostrich dash cooldown', 'Small');
assert.equal((await taskNamed(A, 'Hippo model')).difficulty, 'quick');
assert.deepEqual(await titles(A), ['Natural spawns for all mobs', 'Ostrich egg takes 11 hours to hatch', 'Ostrich dash cooldown', 'Hippo model']);   // by priority (same priority: oldest first)
await A.locator('.tk-sort .seg-btn', { hasText: 'Easiest first' }).click();
assert.deepEqual(await titles(A), ['Hippo model', 'Ostrich dash cooldown', 'Natural spawns for all mobs', 'Ostrich egg takes 11 hours to hatch']);
await A.reload();
await A.locator('h1', { hasText: 'All tasks' }).waitFor();
assert.equal(await A.locator('.tk-sort .seg-btn', { hasText: 'Easiest first' }).getAttribute('aria-pressed'), 'true');
await A.locator('.tk-sort .seg-btn', { hasText: 'Priority' }).click();
await A.screenshot({ path: SHOTS + 't1b-pills.png' });

/* ---- Board: drag a card to another column ---- */
await A.locator('.seg-btn', { hasText: 'Board' }).click();
await A.locator('.tb-col[data-status="doing"]').waitFor();
assert.equal(await A.locator('.tb-col[data-status="todo"] .tb-card').count(), 4);
const doing = await A.locator('.tb-col[data-status="doing"]').boundingBox();
await mouseDrag(A, card(A, 'Natural spawns for all mobs').locator('.tb-handle'), { x: doing.x + doing.width / 2, y: doing.y + 60 });
await A.locator('.tb-col[data-status="doing"] .tb-card', { hasText: 'Natural spawns' }).waitFor();
assert.equal((await taskNamed(A, 'Natural spawns for all mobs')).status, 'doing');
assert.equal(await popup(A).count(), 0);
assert.equal(await A.locator('.tb-ghost').count(), 0);
// Tapping the handle opens the menu (move to a column without dragging)
const cardLabels = await menu(A, card(A, 'Hippo model').locator('.tb-handle'), 'Mark done');
assert.deepEqual(cardLabels, ['Open', 'Move to In progress', 'Mark done', 'Move to folder…', 'Delete']);
await A.locator('.tb-col[data-status="done"] .tb-card', { hasText: 'Hippo model' }).waitFor();
await A.screenshot({ path: SHOTS + 't2-board.png' });
await A.locator('.seg-btn', { hasText: 'List' }).click();
await A.locator('.tk-section h2', { hasText: 'In progress (1)' }).waitFor();

/* ---- The task page ---- */
await item(A, 'Ostrich egg takes 11 hours to hatch').locator('.tk-open').click();
await A.locator('.ed-bar', { hasText: 'Editing bug' }).waitFor();
const egg = await taskNamed(A, 'Ostrich egg takes 11 hours to hatch');
assert.equal(await A.evaluate(() => location.hash), `#/tasks/t/${egg.id}`);
await A.locator('.ed-name').fill('Ostrich eggs hatch too slowly');
await A.locator('select[name=Priority]').selectOption('critical');
await A.locator('select[name=folder]').selectOption(ostrichF.id);
// Link a wiki page by typing its name
await A.getByLabel('Link a wiki page').fill('ostrich eg');
await popup(A).waitFor();
await A.keyboard.press('Enter');
await A.locator('.ed-chips .wlink', { hasText: 'Ostrich Egg' }).waitFor();
// Description: same editor as wiki pages, with a [[ link and a checkbox
await A.locator('.blocks .rt').first().click();
await A.keyboard.type('Hatching uses random ticks, see [[ostrich');
await popup(A).waitFor();
await A.keyboard.press('Enter');
await A.keyboard.type('.');
await A.keyboard.press('Enter');
await A.keyboard.type('[]');
await A.keyboard.type('Try 1/50 per tick');
await waitSaved(A);
t = await taskNamed(A, 'Ostrich eggs hatch too slowly');
assert.equal(t.priority, 'critical');
assert.equal(t.folder, ostrichF.id);
assert.deepEqual(t.links, [{ collection: 'wiki', id: 'ostrich-egg' }]);
assert.equal(t.body[0].text, 'Hatching uses random ticks, see [[ostrich]] .');
assert.equal(t.body[1].type, 'todo');
assert.match(await A.locator('.crumbs').textContent(), /Mobs.*Ostrich/);
await A.screenshot({ path: SHOTS + 't3-task-page.png', fullPage: true });
// Status Done from the page; Undo all changes puts everything back
await A.locator('select[name=Status]').selectOption('done');
await waitSaved(A);
assert.ok((await taskNamed(A, 'Ostrich eggs hatch too slowly')).doneAt);
await A.getByRole('button', { name: 'Undo all changes' }).click();
await dlg(A).getByRole('button', { name: 'Undo all changes' }).click();
await waitSaved(A);
t = await taskNamed(A, 'Ostrich egg takes 11 hours to hatch');
assert.deepEqual([t.priority, t.status, t.folder, t.links, t.body, t.doneAt], ['normal', 'todo', null, undefined, undefined, undefined]);
// Do it again and keep it this time
await A.locator('.ed-name').fill('Ostrich eggs hatch too slowly');
await A.locator('select[name=Priority]').selectOption('critical');
await A.locator('select[name=folder]').selectOption(ostrichF.id);
await A.getByLabel('Link a wiki page').fill('ostrich eg');
await popup(A).waitFor();
await A.keyboard.press('Enter');
await A.locator('.blocks .rt').first().click();
await A.keyboard.type('Hatching uses random ticks, see [[monkey');
await popup(A).waitFor();
await A.keyboard.press('Enter');
await waitSaved(A);
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(() => location.hash === '#/tasks');                 // back to the list it was opened from
await item(A, 'Ostrich eggs hatch too slowly').waitFor();
assert.equal(await item(A, 'Ostrich eggs hatch too slowly').locator('.tag-pri-critical').count(), 1);
assert.match(await item(A, 'Ostrich eggs hatch too slowly').locator('.tk-links').textContent(), /Ostrich Egg/);

/* ---- On wiki pages ---- */
// Linked in the description with [[monkey]]: shows on the Monkey page
await A.goto(BASE + '#/wiki/p/monkey');
await A.locator('.wiki-tasks .tk-item', { hasText: 'Ostrich eggs hatch too slowly' }).waitFor();
// New task for this page
await A.goto(BASE + '#/wiki/p/termite-nest');
await A.locator('.wiki-tasks').getByText('No open tasks for this page.').waitFor();
await A.getByRole('button', { name: 'New task for this page' }).click();
await dlg(A).locator('input[name=title]').fill('Loot table for the termite nest');
await dlg(A).locator('select[name=priority]').selectOption('high');
await dlg(A).locator('select[name=folder]').selectOption(mobs.id);
await dlg(A).getByRole('button', { name: 'Add task' }).click();
await expectToast(A, /Task added/);
await A.locator('.wiki-tasks .tk-item', { hasText: 'Loot table for the termite nest' }).waitFor();
t = await taskNamed(A, 'Loot table for the termite nest');
assert.deepEqual([t.priority, t.folder, t.links], ['high', mobs.id, [{ collection: 'wiki', id: 'termite-nest' }]]);
await A.locator('.wiki-tasks').scrollIntoViewIfNeeded();
await A.screenshot({ path: SHOTS + 't4-wiki-box.png' });
// Opening it from the page, then Done, comes back to the page (another tab)
await A.locator('.wiki-tasks .tk-open', { hasText: 'Loot table' }).click();
await A.locator('.ed-bar').waitFor();
assert.equal(await A.locator('#tab-tasks').getAttribute('aria-selected'), 'true');
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/p/termite-nest');
await A.locator('.wiki-tasks .tk-item').first().waitFor();
// Ticking it done there takes it out of the box
await A.locator('.wiki-tasks .tk-tick').first().click();
await A.locator('.wiki-tasks').getByText('1 done task not shown.').waitFor();
await A.locator('.wiki-tasks').getByText('No open tasks for this page.').waitFor();
await A.goto(BASE + '#/tasks');
await A.locator('h1', { hasText: 'All tasks' }).waitFor();

// Delete a task from its ⋯ menu
await menu(A, item(A, 'Ostrich dash cooldown').locator('.row-menu'), 'Delete');
await dlg(A).getByRole('button', { name: 'Delete' }).click();
await A.waitForFunction(() => ![...document.querySelectorAll('.tk-title')].some(e => e.textContent === 'Ostrich dash cooldown'));
assert.equal(await taskNamed(A, 'Ostrich dash cooldown'), null);
// Move to folder from the ⋯ menu
await menu(A, item(A, 'Natural spawns for all mobs').locator('.row-menu'), 'Move to folder…');
await dlg(A).locator('select[name=folder]').selectOption(mobs.id);
await dlg(A).getByRole('button', { name: 'Move' }).click();
await A.waitForFunction(() => /Mobs/.test([...document.querySelectorAll('.tk-item')].find(e => e.textContent.includes('Natural spawns'))?.textContent || ''));
assert.equal((await taskNamed(A, 'Natural spawns for all mobs')).folder, mobs.id);

// Copy tasks for Claude has the folders
await A.getByRole('button', { name: 'Settings' }).click();
await dlg(A).getByRole('button', { name: 'Copy tasks for Claude' }).click();
await expectToast(A, /Copied 4 tasks/);
const clip = await A.evaluate(() => navigator.clipboard.readText());
assert.match(clip, /\| Bug \| Critical \| To do \| Ostrich eggs hatch too slowly \| folder: Mobs\/Ostrich \| links: wiki\/ostrich-egg/);
assert.match(clip, /\| Task \| High \| Done \| Loot table for the termite nest \| folder: Mobs \| links: wiki\/termite-nest/);
assert.match(clip, /\| Task \| Low \| Done \| Hippo model \| difficulty: Quick \| folder: Mobs/);
await A.keyboard.press('Escape');
await A.waitForFunction(() => !document.querySelector('dialog[open]'));

/* ---- Check your changes, Push ---- */
await push(A, async rv => {
  const bug = rv.locator('.rv-item', { hasText: 'Ostrich eggs hatch too slowly' });
  assert.match(await bug.locator('.rv-kind').textContent(), /^Bug$/);
  await bug.getByRole('button', { name: 'See changes' }).click();
  await bug.locator('.rv-diff').waitFor();
  const text = await bug.locator('.rv-diff').textContent();
  assert.match(text, /Title.*Ostrich eggs hatch too slowly/);
  assert.match(text, /Priority.*Critical/);
  assert.match(text, /Folder.*Mobs › Ostrich/);
  assert.match(text, /Links.*Ostrich Egg/);
  assert.match(text, /Page text.*Hatching uses random ticks, see Monkey/);
  assert.equal(await bug.getByRole('button', { name: 'Edit' }).count(), 1);
  assert.match(await rv.locator('.rv-item', { hasText: /^Mobs/ }).locator('.rv-kind').textContent(), /Task folder/);
  await A.screenshot({ path: SHOTS + 't5-review.png' });
});
const files = gh.files();
const egg2 = await taskNamed(A, 'Ostrich eggs hatch too slowly');
assert.equal(JSON.parse(files[`data/tasks/${egg2.id}.json`]).data.folder, ostrichF.id);
assert.equal(JSON.parse(files[`data/task-folders/${mobs.id}.json`]).data.name, 'Mobs');

/* ---------------- Device B: phone ---------------- */
const B = await device('B', { viewport: { width: 384, height: 832 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' });
await pull(B);
await B.getByRole('tab', { name: 'Tasks & Bugs' }).tap();
await B.locator('h1', { hasText: 'All tasks' }).waitFor();
assert.equal(await B.locator('.tk-side-panel').isVisible(), false);       // folders are behind the button
await B.locator('.tk-side-toggle').tap();
await B.locator('.tk-flink', { hasText: /^Ostrich/ }).tap();
await B.locator('h1', { hasText: /^Ostrich$/ }).waitFor();
assert.equal(await B.locator('.tk-side-panel').isVisible(), false);
assert.equal(await B.locator('.tk-side-current').textContent(), 'Ostrich');
assert.deepEqual(await titles(B), ['Ostrich eggs hatch too slowly']);
await B.screenshot({ path: SHOTS + 't6-phone-list.png' });
assert.equal(await B.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
// Board on the phone: drag a card with a finger onto the next column (it peeks in on the right)
await B.locator('.tk-flink', { hasText: /^All tasks/ }).evaluate(a => a.click());
await B.locator('h1', { hasText: 'All tasks' }).waitFor();
await B.locator('.seg-btn', { hasText: 'Board' }).tap();
await B.locator('.tb-board').waitFor();
assert.equal(await B.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
const eggCard = card(B, 'Ostrich eggs hatch too slowly');
await eggCard.locator('.tb-handle').evaluate(e => e.scrollIntoView({ block: 'center' }));
const next = await B.locator('.tb-col[data-status="doing"]').boundingBox();
const box = await eggCard.boundingBox();
await fingerDrag(B, eggCard.locator('.tb-handle'), { x: next.x + 24, y: box.y + 20 });
await B.locator('.tb-col[data-status="doing"] .tb-card', { hasText: 'Ostrich eggs' }).waitFor();
assert.equal((await taskNamed(B, 'Ostrich eggs hatch too slowly')).status, 'doing');
await B.screenshot({ path: SHOTS + 't7-phone-board.png' });
// The task page on the phone
await B.locator('.tb-col[data-status="doing"]').evaluate(e => e.scrollIntoView({ inline: 'start', block: 'nearest' }));
await B.waitForTimeout(500);       // the board snaps to the column
await card(B, 'Ostrich eggs hatch too slowly').locator('.tk-open').tap();
await B.locator('.ed-bar').waitFor();
assert.equal(await B.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
await B.screenshot({ path: SHOTS + 't8-phone-task.png', fullPage: true });
await B.getByRole('button', { name: 'Done' }).tap();
await B.waitForFunction(() => location.hash === '#/tasks');
await push(B);
await pull(A);
assert.equal((await taskNamed(A, 'Ostrich eggs hatch too slowly')).status, 'doing');

/* ---- Import: the starter tasks file (dev/starter-tasks.json) ---- */
await importText(A, fs.readFileSync(new URL('../starter-tasks.json', import.meta.url), 'utf8'));
assert.match(await dlg(A).textContent(), /Task folder/);
assert.equal(await dlg(A).locator('.import-problem').count(), 0);
await dlg(A).locator('.modal-actions button.btn-primary').click();
await expectToast(A, /Saved 11 changes/);
await A.goto(BASE + '#/tasks/f/f-blocks');
await item(A, 'Recipe for hollow logs').waitFor();
assert.equal(await A.locator('.tk-content .tk-item').count(), 4);
await A.goto(BASE + '#/wiki/p/termite-nest');
await A.locator('.wiki-tasks .tk-item', { hasText: 'Loot tables for the termite blocks' }).waitFor();
await A.goto(BASE + '#/tasks/t/t-wood-set-signs-boats');
assert.equal(await A.locator('.blocks .blk').count(), 6);

/* ---- Deleting a folder with tasks: keep them (No folder) or delete them too ---- */
await A.goto(BASE + '#/tasks/f/f-world');
await A.locator('h1', { hasText: /^World$/ }).waitFor();
const worldTasks = (await list(A, 'tasks')).filter(x => x.folder === 'f-world').map(x => x.id);
assert.ok(worldTasks.length > 0);
await menu(A, A.locator('.tk-frow[data-folder="f-world"] > .tk-fline .tk-fhandle'), 'Delete folder');
assert.match(await dlg(A).locator('.ed-check').textContent(), /move (it|them) to No folder/);
await dlg(A).getByRole('button', { name: 'Delete folder' }).click();
await expectToast(A, /its tasks are in No folder now/);
await A.waitForFunction(() => location.hash === '#/tasks');
for (const id of worldTasks) assert.equal((await list(A, 'tasks')).find(x => x.id === id).folder, null);
assert.equal((await list(A, 'task-folders')).some(f => f.id === 'f-world'), false);
const blockTasks = (await list(A, 'tasks')).filter(x => x.folder === 'f-blocks').map(x => x.id);
await menu(A, A.locator('.tk-frow[data-folder="f-blocks"] > .tk-fline .tk-fhandle'), 'Delete folder');
await dlg(A).locator('input[name=keep]').uncheck();
await dlg(A).getByRole('button', { name: `Delete folder and ${blockTasks.length} tasks` }).click();
await expectToast(A, new RegExp(`Folder and ${blockTasks.length} tasks deleted`));
for (const id of blockTasks) assert.equal((await list(A, 'tasks')).some(x => x.id === id), false);

console.log('errors:', errors.length ? errors : 'none');
assert.equal(errors.length, 0);
await browser.close();
console.log('ALL TASKS CHECKS PASSED');
