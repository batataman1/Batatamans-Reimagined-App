// Ideas (part 2c Ideas, step 1): sections (new, nested, drag, rename, move, delete), quick capture,
// the outline (ideas under ideas, folding remembered), search, the ⋯ menu (add under, move, delete
// with the ideas under it moving up), the idea page (section, comes under, links, note, undo),
// Make a task (note and pictures copied, links back), Link a task you already have, the task side
// (idea chips, picking ideas in Links, idea names on rows), Copy ideas for Claude, Check your
// changes, the starter ideas import, and a phone that pulls it all.
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

/* ---------------- Device A: desktop ---------------- */
const store = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  const { store } = await import('./js/core/store.js');
  return new Function('store', 'a', `return (${src})(store, a);`)(store, a);
}, [fn.toString(), arg]);
const overflows = page => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

/* ---------------- Device A: desktop ---------------- */
const A = await device('A', { viewport: { width: 1280, height: 900 } });
await importText(A, STARTER);
await dlg(A).locator('.modal-actions button.btn-primary').click();
await A.waitForFunction(() => !document.querySelector('dialog[open]'));
await push(A);

// The tab starts empty
await A.getByRole('tab', { name: 'Ideas' }).click();
await A.locator('h1', { hasText: 'All ideas' }).waitFor();
assert.match(await A.locator('.tk-empty').textContent(), /No ideas yet/);

/* ---- The starter ideas import (dev/starter-ideas.json) ---- */
await importText(A, STARTER_IDEAS);
assert.match(await dlg(A).textContent(), /Idea section/);
assert.equal(await dlg(A).locator('.import-problem').count(), 0);
await dlg(A).locator('.modal-actions button.btn-primary').click();
await expectToast(A, /Saved 6 changes/);
await A.locator('.id-shead a', { hasText: 'Mobs' }).waitFor();
assert.deepEqual(await A.locator('.id-content > .id-sblock > .id-shead a').allTextContents(), ['Mobs', 'Blocks', 'World']);
assert.deepEqual(await outlineOf(A), ['Termites', '  Termites make hollow logs', '  More termite nest mechanics']);
assert.match(await row(A, 'Termites').locator('.tk-links').textContent(), /Termite/);
assert.equal(await A.locator('.tk-flink', { hasText: /^All ideas/ }).locator('.tk-fcount').textContent(), '3');

/* ---- Folding: remembered on this device ---- */
await row(A, 'Termites').locator('.id-fold').click();
await row(A, 'Termites').locator('.id-tag-hidden', { hasText: '+2' }).waitFor();
assert.deepEqual(await outlineOf(A), ['Termites']);
await A.reload();
await A.locator('h1', { hasText: 'All ideas' }).waitFor();
await row(A, 'Termites').locator('.id-tag-hidden').waitFor();
await row(A, 'Termites').locator('.id-fold').click();
await row(A, 'Termites make hollow logs').waitFor();
// A whole section folds too
await A.locator('.id-sblock[data-section="s-mobs"] > .id-shead .id-fold').click();
await A.waitForFunction(() => !document.querySelector('.id-sblock[data-section="s-mobs"] .id-node'));
await A.locator('.id-sblock[data-section="s-mobs"] > .id-shead .id-fold').click();
await row(A, 'Termites').waitFor();

/* ---- Quick capture: in All ideas it goes to Not sorted ---- */
await quickAdd(A, 'Ostrich races');
let idea = await ideaNamed(A, 'Ostrich races');
assert.deepEqual([idea.section, idea.parent], [null, null]);
assert.ok(idea.created && /^i-/.test(idea.id));
assert.equal(await A.evaluate(() => document.activeElement?.classList.contains('tk-add-input')), true);
await A.locator('.id-shead a', { hasText: 'Not sorted' }).waitFor();

/* ---- Sections ---- */
await A.getByRole('button', { name: 'New section' }).click();
await dlg(A).locator('input[name=name]').fill('Plants');
await dlg(A).locator('input[name=name]').press('Enter');
await A.locator('h1', { hasText: 'Plants' }).waitFor();
const plants = await sectionNamed(A, 'Plants');
assert.equal(await A.evaluate(() => location.hash), `#/ideas/s/${plants.id}`);
await quickAdd(A, 'Baobab fruit juice');
assert.equal((await ideaNamed(A, 'Baobab fruit juice')).section, plants.id);
// A section inside Mobs (from the ⋮⋮ menu)
const handle = id => A.locator(`.tk-frow[data-section="${id}"] > .tk-fline .tk-fhandle`);
const labels = await menu(A, handle('s-mobs'), 'New section inside');
assert.deepEqual(labels, ['New section inside', 'Rename', 'Move into another section…', 'Move down', 'Delete section']);
assert.equal(await dlg(A).locator('select[name=parent]').inputValue(), 's-mobs');
await dlg(A).locator('input[name=name]').fill('Bosses');
await dlg(A).getByRole('button', { name: 'Make section' }).click();
await A.locator('h1', { hasText: /^Bosses$/ }).waitFor();
const bosses = await sectionNamed(A, 'Bosses');
assert.equal(bosses.parent, 's-mobs');
assert.match(await A.locator('.crumbs').textContent(), /Ideas.*Mobs.*Bosses/);
await quickAdd(A, 'Desert boss');
// Mobs shows its own ideas, then the Bosses section below them
await A.locator('.tk-flink', { hasText: /^Mobs/ }).click();
await A.locator('h1', { hasText: /^Mobs$/ }).waitFor();
assert.deepEqual(await outlineOf(A), ['Termites', '  Termites make hollow logs', '  More termite nest mechanics', 'Desert boss']);
assert.equal(await A.locator('.id-subs .id-shead a', { hasText: 'Bosses' }).count(), 1);
assert.equal(await A.locator('.tk-flink', { hasText: /^Mobs/ }).locator('.tk-fcount').textContent(), '4');
// Drag Plants to the top
const topOrder = () => A.locator('.tk-fnav > .tk-flist > .tk-frow').evaluateAll(els => els.map(e => e.dataset.section));
assert.deepEqual(await topOrder(), ['s-mobs', 's-blocks', 's-world', plants.id]);
const target = await A.locator('.tk-frow[data-section="s-mobs"]').boundingBox();
await mouseDrag(A, handle(plants.id), { x: target.x + 40, y: target.y + 4 });
await A.waitForFunction(id => document.querySelector('.tk-fnav > .tk-flist > .tk-frow')?.dataset.section === id, plants.id);
assert.ok((await sectionNamed(A, 'Plants')).order < 10);
// Rename, move inside another section, can't delete one with ideas in it, delete an empty one
await menu(A, handle(plants.id), 'Rename');
await dlg(A).locator('input[name=name]').fill('Plants & crops');
await dlg(A).locator('input[name=name]').press('Enter');
await A.locator('.tk-fname', { hasText: /^Plants & crops$/ }).waitFor();
await menu(A, handle(plants.id), 'Move into another section…');
await dlg(A).locator('select[name=parent]').selectOption('s-blocks');
await dlg(A).getByRole('button', { name: 'Move' }).click();
await A.waitForFunction(id => document.querySelector(`.tk-frow[data-section="${id}"]`)?.parentElement.closest('.tk-frow')?.dataset.section === 's-blocks', plants.id);
assert.equal((await sectionNamed(A, 'Plants & crops')).parent, 's-blocks');
await menu(A, handle(plants.id), 'Delete section');
assert.match(await dlg(A).textContent(), /isn't empty/);
await dlg(A).getByRole('button', { name: 'OK' }).click();
await menu(A, handle('s-world'), 'New section inside');
await dlg(A).locator('input[name=name]').fill('Temp');
await dlg(A).getByRole('button', { name: 'Make section' }).click();
await A.locator('h1', { hasText: /^Temp$/ }).waitFor();
const temp = await sectionNamed(A, 'Temp');
await menu(A, handle(temp.id), 'Delete section');
await dlg(A).getByRole('button', { name: 'Delete section' }).click();
await A.waitForFunction(() => location.hash === '#/ideas/s/s-world');   // left the deleted section
assert.equal(await sectionNamed(A, 'Temp'), null);
await A.screenshot({ path: SHOTS + 'i1-sections.png' });

/* ---- The ⋯ menu: add an idea under another, move to a section ---- */
await A.goto(BASE + '#/ideas/s/s-mobs');
await A.locator('h1', { hasText: /^Mobs$/ }).waitFor();
const ideaLabels = await menu(A, row(A, 'Termites make hollow logs').locator('.row-menu'), 'Add an idea under this');
assert.deepEqual(ideaLabels, ['Open', 'Add an idea under this', 'Make a task', 'Move to section…', 'Delete']);
await dlg(A).locator('input[name=name]').fill('Logs drop termites when broken');
await dlg(A).getByRole('button', { name: 'Add idea' }).click();
await row(A, 'Logs drop termites when broken').waitFor();
assert.deepEqual(await outlineOf(A), ['Termites', '  Termites make hollow logs', '    Logs drop termites when broken', '  More termite nest mechanics', 'Desert boss']);
idea = await ideaNamed(A, 'Logs drop termites when broken');
assert.deepEqual([idea.section, idea.parent], ['s-mobs', 'i-termites-make-hollow-logs']);
await A.goto(BASE + '#/ideas/s/none');
await row(A, 'Ostrich races').waitFor();
await menu(A, row(A, 'Ostrich races').locator('.row-menu'), 'Move to section…');
await dlg(A).locator('select[name=section]').selectOption('s-mobs');
await dlg(A).getByRole('button', { name: 'Move' }).click();
await A.locator('.tk-empty').waitFor();                                         // Not sorted is empty now
assert.equal((await ideaNamed(A, 'Ostrich races')).section, 's-mobs');

/* ---- The idea page ---- */
await A.goto(BASE + '#/ideas/s/s-mobs');
await row(A, 'Ostrich races').locator('.id-title').click();
await A.locator('.ed-bar', { hasText: 'Editing idea' }).waitFor();
const races = await ideaNamed(A, 'Ostrich races');
assert.equal(await A.evaluate(() => location.hash), `#/ideas/i/${races.id}`);
assert.match(await A.locator('.crumbs').textContent(), /Ideas.*Mobs.*Ostrich races/);
assert.equal(await A.locator('select[name=section]').inputValue(), 's-mobs');
const underOpts = await A.locator('select[name=under] option').allTextContents();
assert.equal(underOpts[0], 'Straight under Mobs');
assert.ok(underOpts.some(o => o.trim() === 'Termites make hollow logs'));
assert.ok(!underOpts.some(o => o.trim() === 'Ostrich races'));             // not under itself
await A.locator('.ed-name').fill('Ostrich racing tracks');
await A.locator('select[name=under]').selectOption('i-termites');
await A.waitForFunction(() => /Mobs.*Termites.*Ostrich racing tracks/.test(document.querySelector('.crumbs').textContent));
// Another section: back to the top of that section
await A.locator('select[name=section]').selectOption('s-world');
assert.equal(await A.locator('select[name=under]').inputValue(), '');
assert.equal((await A.locator('select[name=under] option').allTextContents())[0], 'Straight under World');
await A.getByLabel('Link a wiki page').fill('ostrich');
await popup(A).waitFor();
await A.keyboard.press('Enter');
await A.locator('.ed-chips .wlink', { hasText: /^Ostrich$/ }).waitFor();
await A.locator('.blocks .rt').first().click();
await A.keyboard.type('Tracks in the [[desert');
await popup(A).waitFor();
await A.keyboard.press('Enter');
await A.keyboard.type('.');
await waitSaved(A);
idea = await ideaNamed(A, 'Ostrich racing tracks');
assert.deepEqual([idea.section, idea.parent], ['s-world', null]);
assert.deepEqual(idea.links, [{ collection: 'wiki', id: 'ostrich' }]);
assert.equal(idea.body[0].text, 'Tracks in the [[desert]] .');
await A.screenshot({ path: SHOTS + 'i2-idea-page.png', fullPage: true });
// Undo all changes puts it back
await A.getByRole('button', { name: 'Undo all changes' }).click();
await dlg(A).getByRole('button', { name: 'Undo all changes' }).click();
await waitSaved(A);
idea = await ideaNamed(A, 'Ostrich races');
assert.deepEqual([idea.section, idea.parent, idea.links, idea.body], ['s-mobs', null, undefined, undefined]);
// Again, and keep it
await A.locator('.ed-name').fill('Ostrich racing tracks');
await A.locator('select[name=section]').selectOption('s-world');
await A.getByLabel('Link a wiki page').fill('ostrich');
await popup(A).waitFor();
await A.keyboard.press('Enter');
await A.locator('.blocks .rt').first().click();
await A.keyboard.type('Race ostriches on sand.');
await waitSaved(A);
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(() => location.hash === '#/ideas/s/s-mobs');          // back to where it was opened from
await row(A, 'Termites').waitFor();
assert.equal(await row(A, 'Ostrich racing tracks').count(), 0);
await A.goto(BASE + '#/ideas/s/s-world');
assert.match(await row(A, 'Ostrich racing tracks').locator('.tk-links').textContent(), /Ostrich/);
// Changing the section of an idea moves the ideas under it along
await A.goto(BASE + '#/ideas/i/i-termites');
await A.locator('.ed-bar').waitFor();
await A.getByText('The 3 ideas under it move along.').waitFor();
await A.locator('select[name=section]').selectOption('s-world');
await waitSaved(A);
await A.goto(BASE + '#/ideas/s/s-world');
await row(A, 'Logs drop termites when broken').waitFor();
assert.deepEqual(await outlineOf(A), ['Termites', '  Termites make hollow logs', '    Logs drop termites when broken', '  More termite nest mechanics', 'Ostrich racing tracks']);
await menu(A, row(A, 'Termites').locator('.row-menu'), 'Move to section…');
assert.match(await dlg(A).textContent(), /The 3 ideas under it move along/);
await dlg(A).locator('select[name=section]').selectOption('s-mobs');
await dlg(A).getByRole('button', { name: 'Move' }).click();
await A.waitForFunction(() => !document.querySelector('.id-content .id-node .id-node'));
assert.deepEqual(await outlineOf(A), ['Ostrich racing tracks']);

/* ---- Make a task (the note and its picture are copied; the task links back) ---- */
const PIC = 'images/i-termites-make-hollow-logs-pic1.png';
await store(A, async (s, pic) => {
  const c = document.createElement('canvas'); c.width = 4; c.height = 4; c.getContext('2d').fillRect(0, 0, 2, 2);
  await s.putFile(pic, await new Promise(r => c.toBlob(r, 'image/png')));
  const row = await s.get('ideas', 'i-termites-make-hollow-logs');
  await s.put('ideas', row.id, { ...row.data, body: [...row.data.body, { type: 'image', src: pic, caption: 'Hollow log' }] });
}, PIC);
await A.goto(BASE + '#/ideas/i/i-termites-make-hollow-logs');
await A.locator('.ed-bar').waitFor();
await A.locator('.id-tasks').getByText('No tasks yet.', { exact: false }).waitFor();
await A.locator('.id-tasks').getByRole('button', { name: 'Make a task' }).click();
assert.equal(await dlg(A).locator('input[name=title]').inputValue(), 'Termites make hollow logs');
assert.equal(await dlg(A).locator('input[name=copyNote]').isChecked(), true);
assert.match(await dlg(A).textContent(), /links back to this idea, and to Hollow Logs/);
await dlg(A).locator('select[name=priority]').selectOption('high');
await dlg(A).locator('select[name=difficulty]').selectOption('big');
await dlg(A).getByRole('button', { name: 'Make task' }).click();
await A.locator('.toast', { hasText: /Task added in Tasks & Bugs/ }).waitFor();
await A.locator('.id-tasks .tk-item', { hasText: 'Termites make hollow logs' }).waitFor();
// Open it from the toast; the task page shows the idea; Done comes back to the idea
await A.locator('.toast').getByRole('button', { name: 'Open it' }).click();
await A.locator('.ed-bar', { hasText: 'Editing task' }).waitFor();
let t = await taskNamed(A, 'Termites make hollow logs');
assert.deepEqual([t.priority, t.difficulty, t.status, t.folder], ['high', 'big', 'todo', null]);
assert.deepEqual(t.links, [{ collection: 'ideas', id: 'i-termites-make-hollow-logs' }, { collection: 'wiki', id: 'hollow-logs' }]);
assert.match(t.body[0].text, /are supposed to be made by termites/);
assert.ok(t.body[1].src.startsWith(`images/${t.id}-`) && t.body[1].src !== PIC);
assert.equal(t.body[1].caption, 'Hollow log');
assert.ok(await store(A, async (s, p) => !!(await s.getFile(p))?.blob, t.body[1].src));
assert.equal(await A.locator('#tab-tasks').getAttribute('aria-selected'), 'true');
await A.locator('.ed-chips .wlink-idea', { hasText: 'Termites make hollow logs' }).waitFor();
await A.locator('.blocks .blk-figure img').waitFor();
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(() => location.hash === '#/ideas/i/i-termites-make-hollow-logs');
await A.locator('.id-tasks .tk-item').waitFor();
// From the task to the idea through its chip, and Done goes back to the task
await A.locator('.id-tasks .tk-open').click();
await A.locator('.ed-bar', { hasText: 'Editing task' }).waitFor();
await A.locator('.ed-chips .wlink-idea').click();
await A.locator('.ed-bar', { hasText: 'Editing idea' }).waitFor();
assert.equal(await A.locator('#tab-ideas').getAttribute('aria-selected'), 'true');
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(id => location.hash === `#/tasks/t/${id}`, t.id);
// A task's Links can pick an idea by typing
await A.locator('.ed-bar', { hasText: 'Editing task' }).waitFor();
await A.getByLabel('Link a wiki page').fill('ostrich rac');
await popup(A).waitFor();
assert.equal(await popup(A).locator('.popup-item').first().locator('.popup-hint').textContent(), 'Idea');
await A.keyboard.press('Enter');
await A.locator('.ed-chips .wlink-idea', { hasText: 'Ostrich racing tracks' }).waitFor();
await waitSaved(A);
assert.deepEqual((await taskNamed(A, 'Termites make hollow logs')).links.map(l => l.id), ['i-termites-make-hollow-logs', 'hollow-logs', races.id]);
await A.getByRole('button', { name: 'Done' }).click();
// Task rows show the ideas they link
await A.goto(BASE + '#/tasks');
await A.locator('h1', { hasText: 'All tasks' }).waitFor();
assert.match(await A.locator('.tk-item', { hasText: 'Termites make hollow logs' }).locator('.tk-ideas').textContent(), /Termites make hollow logs, Ostrich racing tracks/);
// Idea rows show what became of them
await A.goto(BASE + '#/ideas/s/s-mobs');
await row(A, 'Termites make hollow logs').locator('.id-tag-task', { hasText: /^Task$/ }).waitFor();
await A.goto(BASE + '#/ideas/i/i-termites-make-hollow-logs');
await A.locator('.id-tasks .tk-tick').click();
await A.locator('.id-tasks .tk-tick[aria-checked="true"]').waitFor();
await A.goto(BASE + '#/ideas/s/s-mobs');
await row(A, 'Termites make hollow logs').locator('.id-tag-task.id-tag-done', { hasText: 'Task done' }).waitFor();
await A.screenshot({ path: SHOTS + 'i3-outline.png' });

/* ---- Link a task you already have ---- */
await A.goto(BASE + '#/tasks');
await A.locator('.tk-add-input').fill('Termite queen model');
await A.locator('.tk-add-input').press('Enter');
await A.locator('.tk-item', { hasText: 'Termite queen model' }).waitFor();
await A.goto(BASE + '#/ideas/i/i-termite-nest-mechanics');
await A.locator('.ed-bar').waitFor();
await A.getByRole('button', { name: 'Link a task you already have' }).click();
await dlg(A).locator('input[name=task]').fill('queen');
await dlg(A).locator('.id-pick', { hasText: 'Termite queen model' }).click();
await expectToast(A, /Linked “Termite queen model” to this idea/);
await A.locator('.id-tasks .tk-item', { hasText: 'Termite queen model' }).waitFor();
assert.deepEqual((await taskNamed(A, 'Termite queen model')).links, [{ collection: 'ideas', id: 'i-termite-nest-mechanics' }]);
await A.getByRole('button', { name: 'Done' }).click();

/* ---- Delete: the ideas under it move up a level; its pictures go, the task's copy stays ---- */
await A.goto(BASE + '#/ideas/s/s-mobs');
await menu(A, row(A, 'Termites make hollow logs').locator('.row-menu'), 'Delete');
assert.match(await dlg(A).textContent(), /The 1 idea under it moves up a level/);
await dlg(A).getByRole('button', { name: 'Delete' }).click();
await A.waitForFunction(() => ![...document.querySelectorAll('.id-title')].some(e => e.textContent === 'Termites make hollow logs'));
assert.deepEqual(await outlineOf(A), ['Termites', '  More termite nest mechanics', '  Logs drop termites when broken', 'Desert boss']);
assert.equal((await ideaNamed(A, 'Logs drop termites when broken')).parent, 'i-termites');
assert.equal(await store(A, async (s, p) => !!(await s.getFile(p)), PIC), false);
assert.ok(await store(A, async (s, p) => !!(await s.getFile(p)), t.body[1].src));
// The task keeps working: its chip for the deleted idea is dashed
await A.goto(BASE + `#/tasks/t/${t.id}`);
await A.locator('.ed-chips .wlink-missing', { hasText: 'Deleted idea' }).waitFor();
await A.getByRole('button', { name: 'Done' }).click();

/* ---- Search ---- */
await A.goto(BASE + '#/ideas');
await A.locator('h1', { hasText: 'All ideas' }).waitFor();
await A.locator('.tk-search').fill('sand');                                  // words in the note count too
await A.locator('.tk-count', { hasText: '1 idea found.' }).waitFor();
assert.deepEqual(await titles(A), ['Ostrich racing tracks']);
assert.match(await A.locator('.id-content .tk-where').textContent(), /World/);
await A.locator('.tk-search').fill('termites');
await A.waitForFunction(() => /found/.test(document.querySelector('.tk-count')?.textContent || '') && document.querySelectorAll('.id-content .id-title').length === 2);
assert.match(await row(A, 'Logs drop termites when broken').locator('.tk-where').textContent(), /Mobs › Termites/);
assert.equal(await A.evaluate(() => document.activeElement?.classList.contains('tk-search')), true);
await A.locator('.tk-search').fill('nothing like this');
await A.getByText('No ideas match the search.').waitFor();
await A.locator('.tk-search').fill('');

/* ---- Copy ideas for Claude ---- */
await A.getByRole('button', { name: 'Settings' }).click();
await dlg(A).getByRole('button', { name: 'Copy ideas for Claude' }).click();
await expectToast(A, /Copied 6 ideas/);
const clip = await A.evaluate(() => navigator.clipboard.readText());
assert.match(clip, /^Batataman's Reimagined app: ideas \(6, copied /);
assert.match(clip, /## Mobs \(s-mobs\)\n- i-termites \| Termites \| links: wiki\/termite\n  note: Plans for the Termites\.\n  - i-termite-nest-mechanics \| More termite nest mechanics \| tasks: t-[a-z0-9-]+ \(To do\) \| links: wiki\/termite-nest/);
assert.match(clip, /## Mobs \/ Bosses \(s-[a-z0-9]+\)\n- i-[a-z0-9-]+ \| Desert boss/);
assert.match(clip, /## Blocks \/ Plants & crops \(s-[a-z0-9]+\)\n- i-[a-z0-9-]+ \| Baobab fruit juice/);
assert.match(clip, /## World \(s-world\)\n- i-[a-z0-9-]+ \| Ostrich racing tracks \| tasks: t-[a-z0-9-]+ \(Done\) \| links: wiki\/ostrich\n  note: Race ostriches on sand\./);
await A.keyboard.press('Escape');
await A.waitForFunction(() => !document.querySelector('dialog[open]'));

/* ---- Check your changes, Push ---- */
await push(A, async rv => {
  const e = rv.locator('.rv-item', { hasText: 'Ostrich racing tracks' });
  assert.match(await e.locator('.rv-kind').textContent(), /^Idea$/);
  await e.getByRole('button', { name: 'See changes' }).click();
  await e.locator('.rv-diff').waitFor();
  const text = await e.locator('.rv-diff').textContent();
  assert.match(text, /Title.*Ostrich racing tracks/);
  assert.match(text, /Section.*World/);
  assert.match(text, /Links.*Ostrich/);
  assert.match(text, /Page text.*Race ostriches on sand/);
  assert.equal(await e.getByRole('button', { name: 'Edit' }).count(), 1);
  assert.match(await rv.locator('.rv-item', { hasText: /^Bosses/ }).locator('.rv-kind').textContent(), /Idea section/);
  const tk = rv.locator('.rv-item', { hasText: /^Termites make hollow logs/ });
  assert.match(await tk.locator('.rv-kind').textContent(), /Task \+ 1 picture/);
  await tk.getByRole('button', { name: 'See changes' }).click();
  await tk.locator('.rv-diff').waitFor();
  assert.match(await tk.locator('.rv-diff').textContent(), /Links.*Idea: \(a deleted idea\).*Hollow Logs.*Idea: Ostrich racing tracks/);
  await A.screenshot({ path: SHOTS + 'i4-review.png' });
});
const files = gh.files();
assert.equal(JSON.parse(files['data/ideas/i-termites.json']).data.title, 'Termites');
assert.equal(JSON.parse(files[`data/sections/${bosses.id}.json`]).data.parent, 's-mobs');
assert.ok(files[`files/${t.body[1].src}`] !== undefined);

/* ---------------- Device B: phone ---------------- */
const B = await device('B', { viewport: { width: 384, height: 832 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' });
await pull(B);
await B.getByRole('tab', { name: 'Ideas' }).tap();
await B.locator('h1', { hasText: 'All ideas' }).waitFor();
assert.equal(await B.locator('.tk-side-panel').isVisible(), false);       // sections are behind the button
assert.equal(await overflows(B), false);
await B.screenshot({ path: SHOTS + 'i5-phone-all.png', fullPage: true });
await B.locator('.tk-side-toggle').tap();
await B.locator('.tk-flink', { hasText: /^Mobs/ }).tap();
await B.locator('h1', { hasText: /^Mobs$/ }).waitFor();
assert.equal(await B.locator('.tk-side-current').textContent(), 'Mobs');
assert.deepEqual(await outlineOf(B), ['Termites', '  More termite nest mechanics', '  Logs drop termites when broken', 'Desert boss']);
await row(B, 'Termites').locator('.id-fold').tap();
await row(B, 'Termites').locator('.id-tag-hidden', { hasText: '+2' }).waitFor();
await row(B, 'Termites').locator('.id-fold').tap();
await row(B, 'More termite nest mechanics').locator('.id-title').tap();
await B.locator('.ed-bar', { hasText: 'Editing idea' }).waitFor();
await B.locator('.id-tasks .tk-item', { hasText: 'Termite queen model' }).waitFor();
assert.equal(await overflows(B), false);
await B.screenshot({ path: SHOTS + 'i6-phone-idea.png', fullPage: true });
await B.getByRole('button', { name: 'Done' }).tap();
await B.waitForFunction(() => location.hash === '#/ideas/s/s-mobs');
await quickAdd(B, 'Termite soldiers');
await push(B);
await pull(A);
assert.equal((await ideaNamed(A, 'Termite soldiers')).section, 's-mobs');

console.log('errors:', errors.length ? errors : 'none');
assert.equal(errors.length, 0);
await browser.close();
console.log('ALL IDEAS CHECKS PASSED');
