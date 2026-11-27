// Customize (part 2b step 3): groups (order, name, icon, hide, reset, your own groups),
// sub-groups (add, rename, template, drag, hide, delete), templates (rename, fields, kinds,
// drag, remove, new, delete, reset), what pages show afterwards, Check your changes before
// Push, Import, and a second device (phone) that pulls it all, with finger dragging.
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
  await expectToast(page, /Pulled|up to date|Downloaded/i);
}
const rec = (page, col, id) => page.evaluate(async ([c, i]) => (await (await import('./js/core/store.js')).store.get(c, i))?.data ?? null, [col, id]);
async function waitSaved(page) {
  await page.waitForFunction(() => document.querySelector('.ed-status')?.textContent === 'Saved on this device', null, { timeout: 5000 });
}
const subRow = (page, id) => page.locator(`.cz-subrow[data-sub="${id}"]`);
const fieldRow = (page, key) => page.locator(`.cz-fieldrow[data-key="${key}"]`);
const groupOrder = page => page.locator('.cz-list .cz-row[data-group]').evaluateAll(els => els.map(e => e.dataset.group));
/** Wait until the Wiki start shows exactly these group tiles (it draws after loading). */
async function expectTiles(page, names) {
  try {
    await page.waitForFunction(want => location.hash === '#/wiki'
      && [...document.querySelectorAll('.tiles .tile-name')].map(e => e.textContent).join('|') === want, names.join('|'), { timeout: 5000 });
  } catch {
    throw new Error(`Wiki start tiles: ${JSON.stringify(await page.locator('.tiles .tile-name').allTextContents())}, wanted ${JSON.stringify(names)}`);
  }
}
async function menu(page, opener, item) {
  await opener.click();
  await popup(page).waitFor();
  const labels = await popup(page).locator('.popup-label').allTextContents();
  if (item) await popup(page).locator('.popup-item', { hasText: item }).click();
  else { await page.keyboard.press('Escape'); await page.mouse.click(5, 300); }
  return labels;
}
/** Drag a row by its ⋮⋮ handle with the mouse, to just above (or below) another row. */
async function mouseDrag(page, handle, target, { below = false } = {}) {
  const a = await handle.boundingBox();
  const t = await target.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 10, a.y + (below ? 20 : -20), { steps: 4 });
  await page.mouse.move(t.x + 20, below ? t.y + t.height - 4 : t.y + 4, { steps: 10 });
  await page.locator('.sort-drop').waitFor();
  await page.mouse.up();
}
/** The same with a finger (real touch events, so the pointer is a touch pointer). */
async function fingerDrag(page, handle, target) {
  // In the middle of the screen (the phone's bottom tabs would cover the lowest rows).
  await handle.evaluate(e => e.scrollIntoView({ block: 'center' }));
  const a = await handle.boundingBox();
  const t = await target.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const at = (x, y) => [{ x, y, id: 1 }];
  const x0 = a.x + a.width / 2, y0 = a.y + a.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(x0, y0) });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const y = y0 + ((t.y + 4) - y0) * (i / steps);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(x0 + 2, y) });
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

// The Customize button on the Wiki start
await A.goto(BASE + '#/wiki');
await A.getByRole('link', { name: 'Customize' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/c');
await A.locator('h1', { hasText: 'Customize the wiki' }).waitFor();
assert.deepEqual(await groupOrder(A), ['mobs', 'items', 'blocks', 'world', 'effects']);
assert.equal(await A.locator('.cz-tpl').count(), 15);
await A.screenshot({ path: SHOTS + 'c1-customize.png', fullPage: true });

// Drag World to the top: only World is saved, with an order before Mobs
const worldRow = A.locator('.cz-row[data-group="world"]');
await mouseDrag(A, worldRow.locator('.sort-handle'), A.locator('.cz-row[data-group="mobs"]'));
await A.waitForFunction(() => document.querySelector('.cz-row[data-group]')?.dataset.group === 'world');
assert.deepEqual(await groupOrder(A), ['world', 'mobs', 'items', 'blocks', 'effects']);
assert.deepEqual(await rec(A, 'groups', 'world'), { name: 'World', order: 0 });
assert.equal(await rec(A, 'groups', 'mobs'), null);
// Tapping the handle offers Move up / Move down; moving World back to its place removes its saved change
assert.deepEqual(await menu(A, A.locator('.cz-row[data-group="world"] .sort-handle'), 'Move down'), ['Move down', 'Edit group']);
await A.waitForFunction(() => [...document.querySelectorAll('.cz-row[data-group]')][1]?.dataset.group === 'world');
await mouseDrag(A, A.locator('.cz-row[data-group="world"] .sort-handle'), A.locator('.cz-row[data-group="blocks"]'), { below: true });
await A.waitForFunction(() => [...document.querySelectorAll('.cz-row[data-group]')].map(e => e.dataset.group).join() === 'mobs,items,blocks,world,effects');
assert.equal(await rec(A, 'groups', 'world'), null);
await A.goto(BASE + '#/wiki');
await expectTiles(A, ['Mobs', 'Items', 'Blocks', 'World', 'Effects & Enchantments']);

/* ---- A group: name, icon, sub-groups ---- */
await A.goto(BASE + '#/wiki/g/mobs');
await A.getByRole('link', { name: 'Edit group' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/c/g/mobs');
await A.locator('.ed-name').fill('Creatures');
await A.getByRole('button', { name: 'Icon of this group. Change it' }).click();
await dlg(A).getByRole('button', { name: 'Egg' }).click();
await waitSaved(A);
let g = await rec(A, 'groups', 'mobs');
assert.equal(g.name, 'Creatures');
assert.equal(g.icon, 'egg');
assert.equal(g.subgroups, undefined);     // sub-groups untouched: not saved

// Add a sub-group (the dialog guesses the Mob template), rename it, drag it to the top
await A.getByRole('button', { name: 'Add sub-group' }).click();
assert.equal(await dlg(A).locator('select[name=template]').inputValue(), 'mob');
await dlg(A).locator('input[name=name]').fill('Passive');
await dlg(A).getByRole('button', { name: 'Add sub-group', exact: true }).click();
assert.match(await dlg(A).locator('.form-error').textContent(), /already a sub-group called “Passive”/);
await dlg(A).locator('input[name=name]').fill('Aquatic');
await dlg(A).getByRole('button', { name: 'Icon of the new sub-group. Change it' }).click();
await dlg(A).getByRole('button', { name: 'Fish' }).click();
await dlg(A).getByRole('button', { name: 'Add sub-group', exact: true }).click();
await subRow(A, 'aquatic').waitFor();
await subRow(A, 'aquatic').locator('.cz-subname').fill('Water mobs');
await mouseDrag(A, subRow(A, 'aquatic').locator('.sort-handle'), subRow(A, 'passive'));
await waitSaved(A);
g = await rec(A, 'groups', 'mobs');
assert.deepEqual(g.subgroups.map(s => s.id), ['aquatic', 'passive', 'neutral', 'hostile', 'boss']);
assert.deepEqual(g.subgroups[0], { id: 'aquatic', name: 'Water mobs', template: 'mob', icon: 'fish' });

// Changing the template of a sub-group with pages asks first (Cancel keeps it); an empty one doesn't ask
await subRow(A, 'passive').locator('.cz-subtpl select').selectOption('food');
await dlg(A).waitFor();
assert.match(await dlg(A).textContent(), /2 pages in Passive will show the Food template's fields/);
await dlg(A).getByRole('button', { name: 'Cancel' }).click();
assert.equal(await subRow(A, 'passive').locator('.cz-subtpl select').inputValue(), 'mob');
await subRow(A, 'hostile').locator('.cz-subtpl select').selectOption('food');
assert.equal(await A.locator('dialog[open]').count(), 0);

// Hide Boss; built-in sub-groups can't be deleted, your own can (when empty)
let labels = await menu(A, subRow(A, 'boss').locator('.cz-more'), 'Hide');
assert.ok(!labels.includes('Delete sub-group'));
assert.ok(labels.includes('Edit the Mob template'));
await subRow(A, 'boss').locator('.tag-hidden').waitFor();
labels = await menu(A, subRow(A, 'aquatic').locator('.cz-more'), 'Delete sub-group');
await dlg(A).getByRole('button', { name: 'Delete sub-group' }).click();
await A.waitForFunction(() => !document.querySelector('.cz-subrow[data-sub="aquatic"]'));
// A sub-group with pages can't be deleted (built-in ones don't even offer it): checked with your own group below
await subRow(A, 'hostile').locator('.cz-subtpl select').selectOption('mob');
await waitSaved(A);
g = await rec(A, 'groups', 'mobs');
assert.deepEqual(g.subgroups.map(s => [s.id, !!s.hidden]), [['passive', false], ['neutral', false], ['hostile', false], ['boss', true]]);

// Undo all changes: back to how the screen opened (Mobs, nothing saved)
await A.getByRole('button', { name: 'Undo all changes' }).click();
await dlg(A).getByRole('button', { name: 'Undo all changes' }).click();
await waitSaved(A);
assert.equal(await A.locator('.ed-name').inputValue(), 'Mobs');
assert.equal(await rec(A, 'groups', 'mobs'), null);

// Again: rename, hide Boss, hide the whole group, Done
await A.locator('.ed-name').fill('Creatures');
await menu(A, subRow(A, 'boss').locator('.cz-more'), 'Hide');
await A.getByLabel('Hide this group on the Wiki start').check();
await waitSaved(A);
await A.screenshot({ path: SHOTS + 'c2-group-editor.png', fullPage: true });
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/g/mobs');      // back to where Edit group was tapped
await A.locator('.notice-hidden').waitFor();
assert.deepEqual(await A.locator('.tiles .tile-name').allTextContents(), ['Passive', 'Neutral', 'Hostile']);
assert.match(await A.locator('.hidden-subs').textContent(), /Hidden here: Boss \(0 pages\)/);

// Hidden: not on the Wiki start, but pages keep their place, open, and are found by search
await A.goto(BASE + '#/wiki');
await expectTiles(A, ['Items', 'Blocks', 'World', 'Effects & Enchantments']);
assert.equal(await A.locator('.wiki-unsorted').count(), 0);
await A.locator('.search-box input').fill('ostrich');
assert.match(await A.locator('.search-results .page-row', { hasText: /^Ostrich/ }).first().textContent(), /Creatures › Neutral/);
await A.goto(BASE + '#/wiki/p/ostrich');
assert.match(await A.locator('.crumbs').textContent(), /Creatures.*Neutral/);
// The "Goes in" lists skip hidden groups, except the page's own place
await A.goto(BASE + '#/wiki/e/ostrich');
await A.locator('.ed-bar').waitFor();
const opts = await A.locator('select[name=where] optgroup').evaluateAll(gs => gs.map(g => g.label));
assert.ok(opts.includes('Creatures (hidden)'));
assert.deepEqual(await A.locator('select[name=where] optgroup[label="Creatures (hidden)"] option').allTextContents(), ['Neutral']);
await A.getByRole('button', { name: 'Done' }).click();
await A.goto(BASE + '#/wiki');
await A.getByRole('button', { name: 'New page' }).click();
assert.ok(!(await dlg(A).locator('select[name=where] optgroup').evaluateAll(gs => gs.map(g => g.label))).some(l => l.startsWith('Creatures')));
await A.keyboard.press('Escape');

// Customize lists the hidden group with its tags
await A.goto(BASE + '#/wiki/c');
const mobsRow = A.locator('.cz-row[data-group="mobs"]');
assert.match(await mobsRow.textContent(), /Creatures.*Hidden.*Changed/);

/* ---- Templates ---- */
// A new template (blank), with a text field and a picture field
await A.getByRole('button', { name: 'New template' }).click();
await dlg(A).locator('input[name=name]').fill('Mob');
await dlg(A).getByRole('button', { name: 'Make template' }).click();
assert.match(await dlg(A).locator('.form-error').textContent(), /already a template called “Mob”/);
await dlg(A).locator('input[name=name]').fill('Vehicle');
await dlg(A).getByRole('button', { name: 'Make template' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/c/t/vehicle');
await A.getByRole('button', { name: 'Add field' }).click();
await dlg(A).locator('input[name=name]').fill('Max speed');
await dlg(A).locator('input[name=name]').press('Enter');
await A.getByRole('button', { name: 'Add field' }).click();
await dlg(A).locator('input[name=name]').fill('Crafting recipe');
await dlg(A).locator('select[name=kind]').selectOption('image');
await dlg(A).getByRole('button', { name: 'Add field', exact: true }).click();
await waitSaved(A);
assert.deepEqual(await rec(A, 'templates', 'vehicle'), { name: 'Vehicle', fields: [
  { key: 'maxSpeed', label: 'Max speed' }, { key: 'craftingRecipe', label: 'Crafting recipe', kind: 'image' }] });
assert.match(await A.locator('.ed-section', { hasText: 'Used by' }).textContent(), /No sub-group uses this template yet/);
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/c');
assert.match(await A.locator('.cz-tpl[data-template="vehicle"]').textContent(), /Vehicle.*Made by you.*2 fields.*not used/);

// Your own group with a sub-group that uses it
await A.getByRole('button', { name: 'Add group' }).click();
await dlg(A).locator('input[name=name]').fill('Vehicles');
await dlg(A).getByRole('button', { name: 'Icon of the new group. Change it' }).click();
await dlg(A).getByRole('button', { name: 'Flag' }).click();
await dlg(A).getByRole('button', { name: 'Add group', exact: true }).click();
await A.waitForFunction(() => location.hash === '#/wiki/c/g/vehicles');
await A.getByRole('button', { name: 'Add sub-group' }).click();
await dlg(A).locator('input[name=name]').fill('Boats');
await dlg(A).locator('select[name=template]').selectOption('vehicle');
await dlg(A).locator('input[name=name]').press('Enter');
await subRow(A, 'boats').waitFor();
await waitSaved(A);
assert.deepEqual(await rec(A, 'groups', 'vehicles'), { name: 'Vehicles', icon: 'flag', order: 60, subgroups: [{ id: 'boats', name: 'Boats', template: 'vehicle', icon: 'flag' }] });
await A.getByRole('button', { name: 'Done' }).click();
await A.goto(BASE + '#/wiki');
await expectTiles(A, ['Items', 'Blocks', 'World', 'Effects & Enchantments', 'Vehicles']);

// A page in it gets the template's fields
await A.goto(BASE + '#/wiki/g/vehicles/boats');
assert.equal(await A.locator('.tpl-link').textContent(), 'Vehicle template');
await A.getByRole('button', { name: 'New page' }).click();
await dlg(A).locator('input[name=name]').fill('Raft');
await dlg(A).locator('input[name=name]').press('Enter');
await A.locator('.ed-bar').waitFor();
assert.equal(await A.locator('.ed-section h2', { hasText: 'Info box' }).textContent(), 'Info box (Vehicle template)');
await A.locator('.ed-field', { hasText: 'Max speed' }).locator('.rt').click();
await A.keyboard.type('8 blocks per second');
assert.equal(await A.locator('.ed-field-pic', { hasText: 'Crafting recipe' }).count(), 1);
await waitSaved(A);
await A.getByRole('button', { name: 'Done' }).click();
await A.locator('.infobox dt', { hasText: 'Max speed' }).waitFor();

// Renaming a field keeps the value; removing it keeps the value on the page (shown as an extra field)
await A.goto(BASE + '#/wiki/g/vehicles/boats');
await A.locator('.tpl-link').click();
await A.waitForFunction(() => location.hash === '#/wiki/c/t/vehicle');
assert.match(await A.locator('.ed-section', { hasText: 'Used by' }).textContent(), /Vehicles › Boats \(1\)/);
await fieldRow(A, 'maxSpeed').locator('.cz-fieldname').fill('Top speed');
await waitSaved(A);
await A.goto(BASE + '#/wiki/p/raft');
await A.locator('.infobox dt', { hasText: 'Top speed' }).waitFor();
assert.equal((await rec(A, 'wiki', 'raft')).fields.maxSpeed, '8 blocks per second');
await A.goto(BASE + '#/wiki/c/t/vehicle');
await menu(A, fieldRow(A, 'maxSpeed').locator('.cz-more'), 'Remove field');
await waitSaved(A);
assert.deepEqual((await rec(A, 'templates', 'vehicle')).fields.map(f => f.key), ['craftingRecipe']);
// Undo all changes brings the field back
await A.getByRole('button', { name: 'Undo all changes' }).click();
await dlg(A).getByRole('button', { name: 'Undo all changes' }).click();
await waitSaved(A);
assert.deepEqual((await rec(A, 'templates', 'vehicle')).fields.map(f => f.label), ['Top speed', 'Crafting recipe']);
// Removed for real: the page keeps the value, shown as a field from a different template
await menu(A, fieldRow(A, 'maxSpeed').locator('.cz-more'), 'Remove field');
await waitSaved(A);
await A.goto(BASE + '#/wiki/e/raft');
await A.locator('.ed-extra-note').waitFor();
assert.equal(await A.locator('.ed-field', { hasText: 'Max speed' }).locator('.rt').textContent(), '8 blocks per second');
await A.getByRole('button', { name: 'Done' }).click();
// Adding a field with the same name again brings the values back
await A.goto(BASE + '#/wiki/c/t/vehicle');
await A.getByRole('button', { name: 'Add field' }).click();
await dlg(A).locator('input[name=name]').fill('Max speed');
await dlg(A).locator('input[name=name]').press('Enter');
await waitSaved(A);
assert.deepEqual((await rec(A, 'templates', 'vehicle')).fields.map(f => f.key), ['craftingRecipe', 'maxSpeed']);
await A.goto(BASE + '#/wiki/p/raft');
await A.locator('.infobox dt', { hasText: 'Max speed' }).waitFor();
assert.match(await A.locator('.infobox-facts').textContent(), /Max speed8 blocks per second/);
await A.goto(BASE + '#/wiki/c/t/vehicle');

// Can't delete a template in use, or a group/sub-group with pages
await A.getByRole('button', { name: 'Delete this template' }).click();
assert.match(await dlg(A).textContent(), /Vehicles › Boats uses it/);
await dlg(A).getByRole('button', { name: 'OK' }).click();
await A.goto(BASE + '#/wiki/c/g/vehicles');
await menu(A, subRow(A, 'boats').locator('.cz-more'), 'Delete sub-group');
assert.match(await dlg(A).textContent(), /Boats still has pages/);
await dlg(A).getByRole('button', { name: 'OK' }).click();
await A.getByRole('button', { name: 'Delete this group' }).click();
assert.match(await dlg(A).textContent(), /Vehicles still has pages/);
await dlg(A).getByRole('button', { name: 'OK' }).click();

/* ---- A built-in template: drag, kind, the page shows it ---- */
await A.goto(BASE + '#/wiki/c/t/mob');
await mouseDrag(A, fieldRow(A, 'drops').locator('.sort-handle'), fieldRow(A, 'health'));
await fieldRow(A, 'breedingFood').locator('select').selectOption('image');
await waitSaved(A);
let t = await rec(A, 'templates', 'mob');
assert.equal(t.fields[0].key, 'drops');
assert.equal(t.fields.find(f => f.key === 'breedingFood').kind, 'image');
await A.screenshot({ path: SHOTS + 'c3-template-editor.png', fullPage: true });
await A.goto(BASE + '#/wiki/p/ostrich');
assert.equal(await A.locator('.infobox-facts dt').first().textContent(), 'Drops');
await A.goto(BASE + '#/wiki/e/ostrich');
// A text value in a field that became a picture field is kept and shown as text until replaced
const breeding = A.locator('.ed-field-pic', { hasText: 'Breeding or taming food' });
await breeding.waitFor();
assert.match(await breeding.textContent(), /Written as text:/);
await A.getByRole('button', { name: 'Done' }).click();

/* ---- Check your changes, then Push ---- */
await push(A, async rv => {
  const mobs = rv.locator('.rv-item', { hasText: 'Creatures' });
  assert.equal(await mobs.locator('.rv-tag').textContent(), 'Changed');      // a built-in group: changed, not new
  assert.equal(await mobs.getByRole('button', { name: 'Undo changes' }).count(), 1);
  assert.match(await mobs.locator('.rv-kind').textContent(), /Wiki group/);
  await mobs.getByRole('button', { name: 'See changes' }).click();
  await mobs.locator('.rv-diff').waitFor();
  const text = await mobs.locator('.rv-diff').textContent();
  assert.match(text, /Name.*Mobs.*Creatures/);
  assert.match(text, /On the Wiki start.*shown.*hidden/);
  assert.match(text, /Sub-groups.*Boss: hidden/);
  const vehicle = rv.locator('.rv-item', { hasText: 'Vehicle' }).filter({ hasText: 'Wiki template' });
  await vehicle.getByRole('button', { name: 'See changes' }).click();
  assert.match(await vehicle.locator('.rv-diff').textContent(), /New template.*Crafting recipe, Max speed/);
  assert.equal(await vehicle.locator('.rv-tag').textContent(), 'New');
  const mob = rv.locator('.rv-item', { hasText: /^Mob/ }).filter({ hasText: 'Wiki template' });
  await mob.getByRole('button', { name: 'See changes' }).click();
  assert.match(await mob.locator('.rv-diff').textContent(), /Breeding or taming food: now a picture.*Order changed/);
  assert.equal(await mob.getByRole('button', { name: 'Edit' }).count(), 1);
  await A.screenshot({ path: SHOTS + 'c4-review.png' });
});
let files = gh.files();
assert.equal(JSON.parse(files['data/groups/mobs.json']).data.name, 'Creatures');
assert.equal(JSON.parse(files['data/groups/mobs.json']).data.hidden, true);
assert.ok(files['data/groups/vehicles.json'] && files['data/templates/vehicle.json'] && files['data/templates/mob.json']);

/* ---------------- Device B: phone pulls it ---------------- */
const B = await device('B', { viewport: { width: 384, height: 832 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' });
await pull(B);
await B.goto(BASE + '#/wiki');
await B.waitForFunction(() => [...document.querySelectorAll('.tiles .tile-name')].map(e => e.textContent).join() === 'Items,Blocks,World,Effects & Enchantments,Vehicles');
await B.screenshot({ path: SHOTS + 'c5-phone-wiki.png' });
await B.getByRole('link', { name: 'Customize' }).tap();
await B.locator('.cz-row[data-group="mobs"] .tag-hidden').waitFor();
await B.screenshot({ path: SHOTS + 'c6-phone-customize.png', fullPage: true });
// Drag a sub-group with a finger (Vehicles: add one, then move it to the top)
await B.goto(BASE + '#/wiki/c/g/vehicles');
await B.getByRole('button', { name: 'Add sub-group' }).tap();
await dlg(B).locator('input[name=name]').fill('Carts');
await dlg(B).getByRole('button', { name: 'Add sub-group', exact: true }).tap();
await subRow(B, 'carts').waitFor();
await waitSaved(B);
await fingerDrag(B, subRow(B, 'carts').locator('.sort-handle'), subRow(B, 'boats'));
await B.waitForFunction(() => document.querySelector('.cz-subrow')?.dataset.sub === 'carts');
await waitSaved(B);
assert.deepEqual((await rec(B, 'groups', 'vehicles')).subgroups.map(s => s.id), ['carts', 'boats']);
assert.equal(await popup(B).count(), 0);        // the drag didn't open the menu
await B.screenshot({ path: SHOTS + 'c7-phone-group-editor.png', fullPage: true });
const overflow = await B.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
assert.equal(overflow, false, 'the group editor is wider than the phone screen');
await B.goto(BASE + '#/wiki/c/t/mob');
await fieldRow(B, 'health').waitFor();
assert.equal(await B.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
await B.screenshot({ path: SHOTS + 'c8-phone-template.png', fullPage: true });
await B.getByRole('button', { name: 'Done' }).tap();
await push(B);

/* ---------------- Back on A: reset to built-in, delete your own ---------------- */
await pull(A);
await A.goto(BASE + '#/wiki/c/g/mobs');
await A.getByRole('button', { name: 'Reset to built-in' }).click();
await dlg(A).getByRole('button', { name: 'Reset to built-in' }).click();
await waitSaved(A);
assert.equal(await A.locator('.ed-name').inputValue(), 'Mobs');
assert.equal(await rec(A, 'groups', 'mobs'), null);
assert.equal(await A.getByLabel('Hide this group on the Wiki start').isChecked(), false);
await A.getByRole('button', { name: 'Done' }).click();
await A.goto(BASE + '#/wiki/c/t/mob');
await A.getByRole('button', { name: 'Reset to built-in' }).click();
await dlg(A).getByRole('button', { name: 'Reset to built-in' }).click();
await waitSaved(A);
assert.equal(await rec(A, 'templates', 'mob'), null);
await A.getByRole('button', { name: 'Done' }).click();
// Delete Raft, then the sub-groups, the group and the template
await A.goto(BASE + '#/wiki/p/raft');
await A.getByRole('link', { name: 'Edit' }).click();
await A.getByRole('button', { name: 'Delete this page' }).click();
await dlg(A).getByRole('button', { name: 'Delete page' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/g/vehicles/boats');
await A.goto(BASE + '#/wiki/c/g/vehicles');
await A.getByRole('button', { name: 'Delete this group' }).click();
await dlg(A).getByRole('button', { name: 'Delete group' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/c');
assert.equal(await A.locator('.cz-row[data-group="vehicles"]').count(), 0);
await A.goto(BASE + '#/wiki/c/t/vehicle');
await A.getByRole('button', { name: 'Delete this template' }).click();
await dlg(A).getByRole('button', { name: 'Delete template' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/c');
assert.equal(await A.locator('.cz-tpl[data-template="vehicle"]').count(), 0);
await push(A, async rv => {
  const reset = rv.locator('.rv-item', { hasText: 'Creatures' });
  assert.equal(await reset.locator('.rv-tag').textContent(), 'Reset to built-in');
  assert.equal(await reset.getByRole('button', { name: 'Edit' }).count(), 0);
  assert.equal(await rv.locator('.rv-item', { hasText: 'Vehicles' }).locator('.rv-tag').textContent(), 'Deleted');
});
files = gh.files();
assert.ok(!files['data/groups/mobs.json'] && !files['data/groups/vehicles.json'] && !files['data/templates/vehicle.json'] && !files['data/templates/mob.json']);

// The phone pulls: Mobs is back
await pull(B);
await B.goto(BASE + '#/wiki');
await B.waitForFunction(() => [...document.querySelectorAll('.tiles .tile-name')].map(e => e.textContent).join() === 'Mobs,Items,Blocks,World,Effects & Enchantments');

/* ---- Import can change groups and templates too ---- */
await importText(A, JSON.stringify({ format: 'batataman-import', version: 1, summary: 'Rename Mobs', changes: [
  { action: 'upsert', collection: 'groups', id: 'mobs', data: { name: 'Animals' } },
  { action: 'upsert', collection: 'templates', id: 'ship', data: { name: 'Ship', fields: [{ key: 'crew', label: 'Crew' }] } },
] }));
await dlg(A).locator('.import-list').waitFor();
assert.match(await dlg(A).textContent(), /Wiki group/);
assert.match(await dlg(A).textContent(), /Wiki template/);
await dlg(A).locator('.modal-actions button.btn-primary').click();
await expectToast(A, /Saved 2 changes/);
await A.goto(BASE + '#/wiki');
await expectTiles(A, ['Animals', 'Items', 'Blocks', 'World', 'Effects & Enchantments']);

// Undo changes in Check your changes: a changed built-in group goes back to the built-in
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Push' }).click();
const rv = A.locator('dialog.modal-review');
await rv.waitFor();
const animals = rv.locator('.rv-item', { hasText: 'Animals' });
assert.equal(await animals.locator('.rv-tag').textContent(), 'Changed');
await animals.getByRole('button', { name: 'Undo changes' }).click();
assert.match(await dlg(A).textContent(), /how it came with the app/);
await dlg(A).getByRole('button', { name: 'Undo changes' }).click();
await A.waitForFunction(() => ![...document.querySelectorAll('dialog.modal-review .rv-name')].some(e => e.textContent === 'Animals'));
assert.equal(await rv.locator('.rv-item').count(), 1);       // the Ship template is still there
await rv.getByRole('button', { name: 'Cancel' }).click();
await expectTiles(A, ['Mobs', 'Items', 'Blocks', 'World', 'Effects & Enchantments']);
assert.equal(await rec(A, 'groups', 'mobs'), null);

console.log('errors:', errors.length ? errors : 'none');
assert.equal(errors.length, 0);
await browser.close();
console.log('ALL CUSTOMIZE CHECKS PASSED');
