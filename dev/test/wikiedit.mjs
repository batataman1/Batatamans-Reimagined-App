// Wiki editing (part 2b step 2): new page, editor (fields, [[ links, / menu, [] checkboxes,
// lists, divider, bold), pictures and GIFs, related pages, variants, Done, Undo all changes,
// moving, deleting, creating a page from a dashed link, ticking checkboxes while reading, phone.
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
const STARTER = fs.readFileSync(new URL('../starter-wiki.json', import.meta.url), 'utf8');
fs.mkdirSync(SHOTS, { recursive: true });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPklEQVR4XmP8cCLgPwMSELDYwIjMJyTPhKyYHDDwBqD4FwQI+RldfuC9QLELGEn1M3o6odgFA2/AaDpgYAAAROYeK8tnIUgAAAAASUVORK5CYII=', 'base64');
const GIF = Buffer.from('R0lGODlhCAAIAIEAAAAAAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBFAABACwAAAAACAAIAIH/AAAAAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7', 'base64');

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
  await page.getByRole('button', { name: 'Settings' }).click();
  await dlg(page).getByRole('button', { name: 'Import from Claude' }).click();
  await dlg(page).locator('textarea').fill(STARTER);
  await dlg(page).getByRole('button', { name: 'Preview changes', exact: true }).click();
  await dlg(page).locator('.modal-actions button.btn-primary').click();
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
  return page;
}
const getPage = (page, id) => page.evaluate(async id => (await (await import('./js/core/store.js')).store.get('wiki', id))?.data ?? null, id);
const files = page => page.evaluate(async () => {
  const { idb } = await import('./js/core/db.js');
  return (await idb.getAll('files')).filter(f => !f.deleted).map(f => f.path).sort();
});
async function waitSaved(page) {
  await page.waitForFunction(() => document.querySelector('.ed-status')?.textContent === 'Saved on this device', null, { timeout: 5000 });
}
const section = (page, title) => page.locator('.ed-section', { has: page.locator('h2', { hasText: title }) });
const field = (page, label) => page.locator('.ed-field', { has: page.locator('.ed-field-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.rt');
const popup = page => page.locator('.popup');
const h1 = page => page.locator('#view h1').first().textContent();

/* ---------------- Desktop ---------------- */
const A = await device('A', { viewport: { width: 1280, height: 900 } });

// New page from a sub-group
await A.goto(BASE + '#/wiki/g/items/misc');
await A.locator('#view h1', { hasText: 'Materials & Misc' }).waitFor();
await A.getByRole('button', { name: 'New page' }).click();
await dlg(A).locator('input[name=name]').fill('Ostrich Feather');
assert.equal(await dlg(A).locator('select[name=where]').inputValue(), 'items/misc');
await A.screenshot({ path: SHOTS + 'e1-new-page.png' });
await dlg(A).locator('input[name=name]').press('Enter');
await A.waitForFunction(() => location.hash === '#/wiki/e/ostrich-feather');
await A.locator('.ed-bar').waitFor();
assert.equal(await A.locator('.ed-name').inputValue(), 'Ostrich Feather');

// Overview with a [[ link
await section(A, 'Overview').locator('.rt').click();
await A.keyboard.type('Dropped by [[ostr');
await popup(A).waitFor();
assert.equal(await popup(A).locator('.popup-item.active .popup-label').textContent(), 'Ostrich');
await A.screenshot({ path: SHOTS + 'e2-link-picker.png' });
await A.keyboard.press('Enter');
await A.keyboard.type('sometimes.');
// Info box field
await field(A, 'Stack size').click();
await A.keyboard.type('64');
await waitSaved(A);
let d = await getPage(A, 'ostrich-feather');
assert.equal(d.overview, 'Dropped by [[ostrich]] sometimes.');
assert.equal(d.fields.stackSize, '64');
assert.equal(await section(A, 'Overview').locator('.wlink').textContent(), 'Ostrich');

// Page text: / menu, [] checkboxes, lists, divider, bold
const body = section(A, 'Page text');
await body.locator('.blk .rt').first().click();
await A.keyboard.type('/head');
await popup(A).waitFor();
assert.deepEqual(await popup(A).locator('.popup-label').allTextContents(), ['Heading 1', 'Heading 2', 'Heading 3']);
await A.keyboard.press('ArrowDown');
await A.keyboard.press('Enter');
await A.keyboard.type('Uses');
await A.keyboard.press('Enter');
await A.keyboard.type('[]');
await A.keyboard.type('Make arrows');
await A.keyboard.press('Enter');
await A.keyboard.type('Decorate hats');
await A.keyboard.press('Enter');
await A.keyboard.press('Enter');            // empty checkbox -> back to text
await A.keyboard.type('- First');
await A.keyboard.press('Enter');
await A.keyboard.type('Second');
await A.keyboard.press('Enter');
await A.keyboard.press('Enter');
await A.keyboard.type('---');
await A.keyboard.type('Soft but ');
await A.keyboard.press('Control+b');
await A.keyboard.type('strong');
await A.keyboard.press('Control+b');
await A.keyboard.type(' feathers, see [[baobab-tree');
await A.keyboard.press('Enter');
await A.keyboard.type('.');
await waitSaved(A);
d = await getPage(A, 'ostrich-feather');
assert.deepEqual(d.body.map(b => b.type), ['h2', 'todo', 'todo', 'bullet', 'bullet', 'divider', 'p']);
assert.equal(d.body[0].text, 'Uses');
assert.equal(d.body[1].text, 'Make arrows');
assert.equal(d.body[1].checked, false);
assert.equal(d.body[4].text, 'Second');
assert.equal(d.body[6].text, 'Soft but **strong** feathers, see [[baobab-tree]] .');
await A.screenshot({ path: SHOTS + 'e3-editor.png', fullPage: true });

// Backspace at the start of a list item turns it back into text, and again joins it with the line above
await body.locator('.blk-row-bullet .rt').nth(1).click();
await A.keyboard.press('Home');
await A.keyboard.press('Backspace');
await A.keyboard.press('Backspace');
await waitSaved(A);
d = await getPage(A, 'ostrich-feather');
assert.deepEqual(d.body.map(b => b.type), ['h2', 'todo', 'todo', 'bullet', 'divider', 'p']);
assert.equal(d.body[3].text, 'FirstSecond');

// Picture: choose a PNG
let chooser = A.waitForEvent('filechooser');
await section(A, 'Picture').getByRole('button', { name: 'Choose a picture' }).click();
await (await chooser).setFiles({ name: 'feather.png', mimeType: 'image/png', buffer: PNG });
await section(A, 'Picture').locator('img').waitFor();
await waitSaved(A);
const firstPic = (await getPage(A, 'ostrich-feather')).picture;
assert.match(firstPic, /^images\/ostrich-feather-[a-z0-9]+\.png$/);
// Replace it: the old file is removed when leaving the editor
chooser = A.waitForEvent('filechooser');
await section(A, 'Picture').getByRole('button', { name: 'Change picture' }).click();
await (await chooser).setFiles({ name: 'feather2.png', mimeType: 'image/png', buffer: PNG });
await A.waitForFunction(old => document.querySelector('.ed-status')?.textContent === 'Saved on this device', firstPic);
await waitSaved(A);
// A GIF in the page text through the / menu
await body.locator('.blk-row-p .rt').last().click();
await A.keyboard.press('Control+End');
await A.keyboard.press('Enter');
chooser = A.waitForEvent('filechooser');
await A.keyboard.type('/gif');
await popup(A).waitFor();
await A.keyboard.press('Enter');
await (await chooser).setFiles({ name: 'flap.gif', mimeType: 'image/gif', buffer: GIF });
await body.locator('.blk-row-image img').waitFor();
await waitSaved(A);
d = await getPage(A, 'ostrich-feather');
const gif = d.body.find(b => b.type === 'image');
assert.match(gif.src, /\.gif$/);
assert.equal(await A.evaluate(async src => (await (await import('./js/core/store.js')).store.getFile(src)).blob.size, gif.src), GIF.length);

// Big pictures are made smaller
const shrunk = await A.evaluate(async () => {
  const { saveImage } = await import('./js/wiki/images.js');
  const { store } = await import('./js/core/store.js');
  const c = document.createElement('canvas'); c.width = 2400; c.height = 1200;
  c.getContext('2d').fillRect(0, 0, 2400, 1200);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
  const path = await saveImage(new File([blob], 'big.jpg', { type: 'image/jpeg' }), 'size-test');
  const bmp = await createImageBitmap((await store.getFile(path)).blob);
  await store.removeFile(path);
  return { path, w: bmp.width, h: bmp.height };
});
assert.deepEqual([shrunk.w, shrunk.h], [1600, 800]);
assert.match(shrunk.path, /\.webp$/);

// Variants and related pages
await section(A, 'Variants').getByRole('button', { name: 'Add variant' }).click();
await A.keyboard.type('White feather');
await section(A, 'Variants').locator('.ed-variant .rt').nth(1).click();
await A.keyboard.type('Common');
await section(A, 'Related pages').locator('input').fill('baob');
await popup(A).waitFor();
assert.equal(await popup(A).locator('.popup-item.active .popup-label').textContent(), 'Baobab Fruit');
await A.keyboard.press('Enter');
await section(A, 'Related pages').locator('.ed-chip').waitFor();
await waitSaved(A);
d = await getPage(A, 'ostrich-feather');
assert.deepEqual(d.variants, [{ name: 'White feather', note: 'Common' }]);
assert.deepEqual(d.related, ['baobab-fruit']);

// Done -> the page (the editor was opened from the sub-group, so Done opens the page)
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/p/ostrich-feather' && document.querySelector('#view h1')?.textContent === 'Ostrich Feather');
assert.deepEqual(await files(A), [d.picture, gif.src].sort());   // the replaced picture is gone
assert.equal(await A.locator('.wiki-overview .wlink').textContent(), 'Ostrich');
assert.equal(await A.locator('.infobox img').count(), 1);
assert.equal(await A.locator('.wiki-body .b-h1, .wiki-body h3').first().textContent(), 'Uses');
assert.equal(await A.locator('.wiki-body .b-todo').count(), 2);
assert.equal(await A.locator('.wiki-body strong').textContent(), 'strong');
assert.equal(await A.locator('.wiki-body .b-image img').count(), 1);
await A.screenshot({ path: SHOTS + 'e4-page.png', fullPage: true });
// Tick a checkbox while reading
await A.locator('.wiki-body .b-todo input').first().check();
await A.waitForFunction(async () => (await (await import('./js/core/store.js')).store.get('wiki', 'ostrich-feather')).data.body[1].checked === true);
// The Ostrich page lists it under Linked from
await A.goto(BASE + '#/wiki/p/ostrich');
await A.locator('section', { has: A.locator('h2', { hasText: 'Linked from' }) }).locator('.wlink', { hasText: 'Ostrich Feather' }).waitFor();

// Edit from the page: rename; Done goes back to the page
await A.locator('.wlink', { hasText: 'Ostrich Feather' }).first().click();
await A.locator('#view h1', { hasText: 'Ostrich Feather' }).waitFor();
await A.getByRole('link', { name: 'Edit' }).click();
await A.locator('.ed-name').fill('White Ostrich Feather');
await waitSaved(A);
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/p/ostrich-feather' && document.querySelector('#view h1')?.textContent === 'White Ostrich Feather');
await A.getByRole('button', { name: 'Back' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/p/ostrich');

// Undo all changes
await A.goto(BASE + '#/wiki/e/ostrich-feather');
await A.locator('.ed-name').fill('Something else');
await waitSaved(A);
assert.equal((await getPage(A, 'ostrich-feather')).name, 'Something else');
await A.getByRole('button', { name: 'Undo all changes' }).click();
await dlg(A).getByRole('button', { name: 'Undo all changes' }).click();
await waitSaved(A);
assert.equal(await A.locator('.ed-name').inputValue(), 'White Ostrich Feather');
assert.equal((await getPage(A, 'ostrich-feather')).name, 'White Ostrich Feather');

// Move to another sub-group: the info box follows the new template, old fields can be removed
await A.locator('.ed-section select[aria-label="Sub-group"]').selectOption('blocks/natural');
await field(A, 'Required tool').waitFor();
assert.ok(await A.locator('.ed-field', { hasText: 'Stack size' }).count() === 1);
await A.getByRole('button', { name: 'Remove Stack size' }).click();
await waitSaved(A);
d = await getPage(A, 'ostrich-feather');
assert.equal(d.group, 'blocks');
assert.equal(d.fields, undefined);
await A.screenshot({ path: SHOTS + 'e5-moved.png' });
await A.getByRole('button', { name: 'Done' }).click();
await A.waitForFunction(() => document.querySelector('#view h1')?.textContent === 'White Ostrich Feather');
assert.equal(await A.locator('.crumbs').textContent(), 'Wiki›Blocks›Natural');

// Create a page from a dashed link (keeps the link's id)
await A.goto(BASE + '#/wiki/p/fluffy-thing');
await A.getByRole('button', { name: 'Create this page' }).click();
assert.equal(await dlg(A).locator('input[name=name]').inputValue(), 'Fluffy Thing');
await dlg(A).locator('input[name=name]').fill('Fluffy Thing!');
await dlg(A).getByRole('button', { name: 'Create page' }).click();
await dlg(A).getByText('Choose where the page goes.').waitFor();
await dlg(A).locator('select[name=where]').selectOption('items/misc');
await dlg(A).getByRole('button', { name: 'Create page' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/e/fluffy-thing');
assert.equal((await getPage(A, 'fluffy-thing')).name, 'Fluffy Thing!');
// A name that's taken is refused
await A.goto(BASE + '#/wiki/g/items/misc');
await A.getByRole('button', { name: 'New page' }).click();
await dlg(A).locator('input[name=name]').fill('Fluffy Thing');
await dlg(A).getByRole('button', { name: 'Create page' }).click();
await dlg(A).getByText(/already a page called/).waitFor();
await dlg(A).getByRole('button', { name: 'Cancel' }).click();

// Delete a page (and its pictures)
await A.goto(BASE + '#/wiki/e/fluffy-thing');
chooser = A.waitForEvent('filechooser');
await section(A, 'Picture').getByRole('button', { name: 'Choose a picture' }).click();
await (await chooser).setFiles({ name: 'f.png', mimeType: 'image/png', buffer: PNG });
await waitSaved(A);
await A.getByRole('button', { name: 'Delete this page' }).click();
await dlg(A).getByRole('button', { name: 'Delete page' }).click();
await A.waitForFunction(() => location.hash === '#/wiki/g/items/misc');
assert.equal(await getPage(A, 'fluffy-thing'), null);
assert.ok((await files(A)).every(f => !f.includes('fluffy-thing')));

// Leaving the editor by another tab still saves
await A.goto(BASE + '#/wiki/e/rope');
await section(A, 'Notes').locator('.rt').click();
await A.keyboard.press('Control+End');
await A.keyboard.type(' Extra note.');
await A.getByRole('tab', { name: 'Ideas' }).click();
await A.waitForFunction(async () => ((await (await import('./js/core/store.js')).store.get('wiki', 'rope')).data.notes || '').endsWith('Extra note.'));

// Drag a block by its ⋮⋮ handle (the last line goes to the top); a plain click still opens the menu
await A.goto(BASE + '#/wiki/e/ostrich-feather');
await A.locator('.ed-bar').waitFor();
const blks = section(A, 'Page text').locator('.blk');
const before = (await getPage(A, 'ostrich-feather')).body.map(b => b.type);
const lastHandle = await blks.last().locator('.blk-handle').boundingBox();
const firstRow = await blks.first().boundingBox();
await A.mouse.move(lastHandle.x + lastHandle.width / 2, lastHandle.y + lastHandle.height / 2);
await A.mouse.down();
await A.mouse.move(lastHandle.x + 8, lastHandle.y - 30, { steps: 4 });
await A.mouse.move(firstRow.x + 10, firstRow.y + 4, { steps: 8 });
await A.locator('.blk-drop').waitFor();
await A.screenshot({ path: SHOTS + 'e9-dragging.png' });
await A.mouse.up();
await waitSaved(A);
d = await getPage(A, 'ostrich-feather');
assert.deepEqual(d.body.map(b => b.type), [before[before.length - 1], ...before.slice(0, -1)]);
assert.equal(await popup(A).count(), 0);
await blks.first().locator('.blk-handle').click();
await popup(A).waitFor();
assert.ok((await popup(A).locator('.popup-label').allTextContents()).includes('Delete block'));
await A.keyboard.press('Escape');
await A.mouse.click(5, 5);

// Crafting recipe is a picture field (and every item template has it)
const tplRecipe = await A.evaluate(async () => {
  const { TEMPLATES } = await import('./js/config/wiki.js');
  return ['item', 'food', 'tool', 'weapon', 'armor', 'utility', 'block'].map(t => TEMPLATES[t].fields.find(f => f.key === 'craftingRecipe')?.kind);
});
assert.deepEqual(tplRecipe, Array(7).fill('image'));
await A.goto(BASE + '#/wiki/e/rope');
await A.locator('.ed-bar').waitFor();
const recipeRow = A.locator('.ed-field-pic', { hasText: 'Crafting recipe' });
assert.match(await recipeRow.textContent(), /Written as text: 3 String/);
chooser = A.waitForEvent('filechooser');
await recipeRow.getByRole('button', { name: 'Choose a picture or GIF' }).click();
await (await chooser).setFiles({ name: 'recipe.gif', mimeType: 'image/gif', buffer: GIF });
await waitSaved(A);
d = await getPage(A, 'rope');
assert.match(d.fields.craftingRecipe, /^images\/rope-.+\.gif$/);
await recipeRow.locator('img').waitFor();
await A.getByRole('button', { name: 'Done' }).click();
await A.locator('.infobox .infobox-field-pic img').waitFor();
await A.screenshot({ path: SHOTS + 'e10-recipe.png' });
assert.ok((await files(A)).includes(d.fields.craftingRecipe));

// Delete a page from its list with the ⋯ button (its pictures go too)
await A.goto(BASE + `#/wiki/g/${d.group}/${d.subgroup}`);
const ropeItem = A.locator('.page-item', { has: A.locator('.page-row-name', { hasText: /^Rope$/ }) });
await ropeItem.getByRole('button', { name: 'More for Rope' }).click();
await popup(A).waitFor();
assert.deepEqual(await popup(A).locator('.popup-label').allTextContents(), ['Edit', 'Delete page']);
await A.screenshot({ path: SHOTS + 'e11-row-menu.png' });
await popup(A).locator('.popup-item', { hasText: 'Delete page' }).click();
await dlg(A).getByRole('button', { name: 'Delete page' }).click();
await A.waitForFunction(() => ![...document.querySelectorAll('.page-row-name')].some(e => e.textContent === 'Rope'));
assert.equal(await getPage(A, 'rope'), null);
assert.ok((await files(A)).every(f => !f.includes('rope-')));

/* ---------------- Phone ---------------- */
const B = await device('B', { viewport: { width: 384, height: 832 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' });
await B.goto(BASE + '#/wiki/p/termite');
await B.locator('#view h1', { hasText: 'Termite' }).waitFor();
await B.getByRole('link', { name: 'Edit' }).tap();
await B.locator('.ed-bar').waitFor();
await B.screenshot({ path: SHOTS + 'e6-phone-editor.png' });
await section(B, 'Page text').locator('.blk .rt').last().tap();
await B.keyboard.press('Control+End');
await B.keyboard.press('Enter');
await B.keyboard.type('/check');
await popup(B).waitFor();
await B.screenshot({ path: SHOTS + 'e7-phone-menu.png' });
await popup(B).locator('.popup-item').first().tap();
await B.keyboard.type('Test on phone');
await waitSaved(B);
d = await getPage(B, 'termite');
assert.equal(d.body.length, 3);
assert.equal(d.body[d.body.length - 1].type, 'todo');
assert.equal(d.body[d.body.length - 1].text, 'Test on phone');
await B.screenshot({ path: SHOTS + 'e8-phone-editor-body.png', fullPage: true });
const overflow = await B.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
assert.equal(overflow, false, 'the editor is wider than the phone screen');
await B.getByRole('button', { name: 'Done' }).tap();
await B.waitForFunction(() => location.hash === '#/wiki/p/termite');

console.log('errors:', errors.length ? errors : 'none');
assert.equal(errors.length, 0);
await browser.close();
console.log('ALL WIKI EDITING CHECKS PASSED');
