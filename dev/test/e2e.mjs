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
import { createMockGitHub } from './mockgithub.mjs';
const { chromium } = await loadPlaywright();
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';

const BASE = process.env.BASE || 'http://localhost:8123/';
const SHOTS = process.env.SHOTS || '/tmp/brr-shots/';
fs.mkdirSync(SHOTS, { recursive: true });
const gh = createMockGitHub();
const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined, args: ['--no-sandbox'] });
const errors = [];

async function device(name, opts) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...opts });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await ctx.route('https://api.github.com/**', async route => {
    const r = route.request();
    const res = gh.handle(r.method(), r.url(), await r.allHeaders(), r.postData());
    await route.fulfill(res);
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  await page.goto(BASE);
  await page.waitForSelector('.topbar');
  return page;
}

const dlg = page => page.locator('dialog[open]').last();
async function clickInDialog(page, name) {
  await dlg(page).getByRole('button', { name, exact: true }).click();
}
async function expectToast(page, re) {
  try {
    await page.waitForFunction(src => [...document.querySelectorAll('.toast')].some(t => new RegExp(src).test(t.textContent)), re.source, { timeout: 8000 });
    await clearToasts(page);
  } catch {
    const all = await page.locator('.toast').allTextContents();
    const dialogs = await page.locator('dialog[open]').allTextContents();
    throw new Error(`No toast matching ${re}. Toasts: ${JSON.stringify(all)} Dialogs: ${JSON.stringify(dialogs)}`);
  }
}
async function clearToasts(page) { await page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); }
async function waitNoDialog(page) { await page.waitForFunction(() => !document.querySelector('dialog[open]')); }

async function connect(page, deviceName, token = 'github_pat_test') {
  const form = page.locator('.welcome .connect-form');
  await form.locator('input[name=token]').fill(token);
  await form.locator('input[name=device]').fill(deviceName);
  await form.getByRole('button', { name: 'Test and save' }).click();
}

async function importUpdate(page, update, { tick = [] } = {}) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await dlg(page).getByRole('button', { name: 'Import from Claude' }).click();
  await dlg(page).locator('textarea').fill('Here you go:\n```json\n' + JSON.stringify(update, null, 2) + '\n```');
  await clickInDialog(page, 'Preview changes');
  for (const label of tick) await dlg(page).getByRole('checkbox', { name: `Include ${label}` }).check();
  await dlg(page).locator('.modal-actions button.btn-primary').click();
}

async function expectBadge(page, text) {
  await page.waitForFunction(t => { const b = document.querySelector('.sync-btn .badge'); return t === null ? b.hidden : (!b.hidden && b.textContent === t); }, text, { timeout: 5000 });
}
async function savedNames(page) {
  return page.locator('.saved-name').allTextContents();
}

const upd = (changes, summary) => ({ format: 'batataman-import', version: 1, summary, changes });
const wiki = (id, data) => ({ action: 'upsert', collection: 'wiki', id, data });

/* ---------------- Device A: desktop ---------------- */
const A = await device('A', { viewport: { width: 1280, height: 820 } });
await A.screenshot({ path: SHOTS + 'a1-welcome.png' });

// Wrong token first
await connect(A, 'PC', 'github_pat_wrong');
await A.locator('.welcome .status-error').waitFor();
assert.match(await A.locator('.welcome .status-error').textContent(), /rejected the token/);
await connect(A, 'PC');
await expectToast(A, /Connected to GitHub/);
await A.waitForFunction(() => !document.querySelector('.welcome'));

// Import three items
await importUpdate(A, upd([
  wiki('ostrich', { name: 'Ostrich', category: 'Mob', fields: { health: '10', drops: 'Feathers' } }),
  wiki('rope', { name: 'Rope', category: 'Block', fields: { stackSize: '64' } }),
  { action: 'upsert', collection: 'tasks', id: 't-ostrich-ai', data: { title: 'Ostrich flee AI', type: 'task', priority: 'high', status: 'todo', links: [{ collection: 'wiki', id: 'ostrich' }] } },
], 'Starter pages'));
await expectToast(A, /Saved 3 changes/);
await A.waitForFunction(() => document.querySelectorAll('.saved-name').length === 2);
assert.deepEqual(await savedNames(A), ['Ostrich', 'Rope']);
await expectBadge(A, '3');
await A.screenshot({ path: SHOTS + 'a2-wiki-unpushed.png' });

// Copy tasks for Claude
await clearToasts(A);
await A.getByRole('button', { name: 'Settings' }).click();
await dlg(A).getByRole('button', { name: 'Copy tasks for Claude' }).click();
await expectToast(A, /Copied 1 task/);
const clip = await A.evaluate(() => navigator.clipboard.readText());
assert.match(clip, /t-ostrich-ai \| Task \| High \| To do \| Ostrich flee AI \| links: wiki\/ostrich/);
await A.keyboard.press('Escape'); await waitNoDialog(A);

// Push
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Push' }).click();
await expectToast(A, /Pushed 3 changes/);
let files = gh.files();
assert.ok(files['data/wiki/ostrich.json'] && files['data/tasks/t-ostrich-ai.json'] && files['README.md']);
assert.equal(JSON.parse(files['data/wiki/rope.json']).data.fields.stackSize, '64');
await expectBadge(A, null);
assert.equal(gh.commitMessages()[0], 'PC: 3 changes');

/* ---------------- Device B: phone ---------------- */
const B = await device('B', { viewport: { width: 384, height: 832 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' });
await B.screenshot({ path: SHOTS + 'b1-phone-welcome.png' });
assert.equal(await B.locator('.welcome input[name=device]').inputValue(), 'Phone');
await connect(B, 'Phone');
await B.waitForFunction(() => !document.querySelector('.welcome'));
await clearToasts(B);
await B.locator('.sync-btn').first().click(); // Pull
await expectToast(B, /Pulled 3 changes/);
await B.waitForFunction(() => document.querySelectorAll('.saved-name').length === 2);
await B.screenshot({ path: SHOTS + 'b2-phone-pulled.png' });

// Pull again: up to date
await clearToasts(B);
await B.locator('.sync-btn').first().click();
await expectToast(B, /Already up to date/);

/* ---- Conflict: both edit Ostrich; B pushes first; A gets warned and pulls first, uses repo version ---- */
await importUpdate(B, upd([wiki('ostrich', { fields: { health: '20' } })]));
await clearToasts(B);
await B.locator('.sync-btn').nth(1).click();
await expectToast(B, /Pushed 1 change/);

await importUpdate(A, upd([wiki('ostrich', { fields: { health: '30' } }), wiki('monkey', { name: 'Monkey', category: 'Mob' })]));
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Push' }).click();
await dlg(A).getByText('The repo changed since your last Pull').waitFor();
assert.match(await dlg(A).textContent(), /Ostrich/);
await A.screenshot({ path: SHOTS + 'a3-conflict.png' });
await clickInDialog(A, 'Pull first');
await dlg(A).getByText('Some items changed in both places').waitFor();
await A.screenshot({ path: SHOTS + 'a4-overlap.png' });
await clickInDialog(A, "Use the repo's versions");
await expectToast(A, /Pulled. Check the changes/);
let ostrichA = await A.evaluate(async () => (await import('./js/core/store.js')).store.get('wiki', 'ostrich'));
assert.equal(ostrichA.data.fields.health, '20');
assert.equal(ostrichA.dirty, false);
await expectBadge(A, '1'); // monkey still pending
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Push' }).click();
await expectToast(A, /Pushed 1 change/);

/* ---- No-overlap warning: B changes Rope, repo has A's Monkey ---- */
await importUpdate(B, upd([wiki('rope', { fields: { stackSize: '32' } })]));
await clearToasts(B);
await B.locator('.sync-btn').nth(1).click();
await dlg(B).getByText('The repo has newer changes').waitFor();
await B.screenshot({ path: SHOTS + 'b3-newer-changes.png' });
await clickInDialog(B, 'Pull them, then push');
await expectToast(B, /Pushed 1 change/);
await B.waitForFunction(() => [...document.querySelectorAll('.saved-name')].some(e => e.textContent === 'Monkey'));
assert.equal(JSON.parse(gh.files()['data/wiki/rope.json']).data.fields.stackSize, '32');

/* ---- Delete through import: unticked by default, needs confirm ---- */
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Pull' }).click();
await expectToast(A, /Pulled 1 change/);
await A.getByRole('button', { name: 'Settings' }).click();
await dlg(A).getByRole('button', { name: 'Import from Claude' }).click();
await dlg(A).locator('textarea').fill(JSON.stringify(upd([{ action: 'delete', collection: 'tasks', id: 't-ostrich-ai' }, { action: 'delete', collection: 'wiki', id: 'nope' }, { action: 'upsert', collection: 'weird', id: 'x', data: {} }])));
await clickInDialog(A, 'Preview changes');
const box = dlg(A).getByRole('checkbox', { name: 'Include Ostrich flee AI' });
assert.equal(await box.isChecked(), false);
assert.equal(await dlg(A).locator('.modal-actions button.btn-primary').isDisabled(), true);
await A.screenshot({ path: SHOTS + 'a5-import-delete.png' });
await box.check();
await dlg(A).locator('.modal-actions button.btn-primary').click();
await dlg(A).getByText('Delete 1 item?').waitFor();
await clickInDialog(A, 'Delete');
await expectToast(A, /deleted 1/);
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Push' }).click();
await expectToast(A, /Pushed 1 change/);
assert.equal(gh.files()['data/tasks/t-ostrich-ai.json'], undefined);
assert.equal(gh.commitMessages()[0], 'PC: 1 removed');

/* ---- Race: another device pushes during A's push ---- */
await importUpdate(A, upd([wiki('monkey', { fields: { health: '8' } })]));
gh.state.raceNext = true;
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Push' }).click();
await dlg(A).getByText("Push didn't finish").waitFor();
assert.match(await dlg(A).textContent(), /Another device pushed at the same moment/);
await clickInDialog(A, 'OK');
assert.notEqual(JSON.parse(gh.files()['data/wiki/monkey.json']).data.fields?.health, '8');
await A.locator('.sync-btn', { hasText: 'Push' }).click();
await clickInDialog(A, 'Pull them, then push');
await expectToast(A, /Pushed 1 change/);
assert.equal(JSON.parse(gh.files()['data/wiki/monkey.json']).data.fields.health, '8');

/* ---- Keep mine: both edit Rope; B pushes; A keeps its version ---- */
await clearToasts(B);
await B.locator('.sync-btn').first().click();
await expectToast(B, /Pulled/);
await importUpdate(B, upd([wiki('rope', { fields: { stackSize: '16' } })]));
await expectToast(B, /Saved 1 change/);
await B.locator('.sync-btn').nth(1).click();
await expectToast(B, /Pushed 1 change/);
await importUpdate(A, upd([wiki('rope', { fields: { stackSize: '99' } })]));
await A.locator('.sync-btn', { hasText: 'Push' }).click();
await clickInDialog(A, 'Keep mine and push');
await dlg(A).getByText('Replace these items in the repo?').waitFor();
await clickInDialog(A, 'Replace and push');
await expectToast(A, /Pushed 1 change/);
assert.equal(JSON.parse(gh.files()['data/wiki/rope.json']).data.fields.stackSize, '99');
await clearToasts(B);
await B.locator('.sync-btn').first().click();
await expectToast(B, /Pulled/);
const ropeB = await B.evaluate(async () => (await import('./js/core/store.js')).store.get('wiki', 'rope'));
assert.equal(ropeB.data.fields.stackSize, '99');

/* ---- Pull with local unpushed overlap: keep mine ---- */
await importUpdate(A, upd([wiki('ostrich', { fields: { drops: 'Feathers, eggs' } })]));
gh.pushDirect('data/wiki/ostrich.json', JSON.stringify({ id: 'ostrich', collection: 'wiki', updated: new Date().toISOString(), data: { name: 'Ostrich', category: 'Mob', fields: { health: '25' } } }));
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Pull' }).click();
await dlg(A).getByText('Some items changed in both places').waitFor();
await clickInDialog(A, "Keep this device's versions");
await expectToast(A, /Kept your versions of 1 item/);
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Push' }).click();
await expectToast(A, /Pushed 1 change/);
assert.equal(JSON.parse(gh.files()['data/wiki/ostrich.json']).data.fields.drops, 'Feathers, eggs');

/* ---- Unicode and image files round-trip ---- */
await importUpdate(A, upd([wiki('baobab-fruit', { name: 'Baobab Fruit', category: 'Food', notes: 'Sweet & sour — “tangy” 🍈' })]));
await A.evaluate(async () => {
  const { store } = await import('./js/core/store.js');
  const c = document.createElement('canvas'); c.width = 16; c.height = 16;
  const g = c.getContext('2d'); g.fillStyle = '#2BB3C0'; g.fillRect(0, 0, 8, 8);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  await store.putFile('images/test.png', blob);
});
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Push' }).click();
await expectToast(A, /Pushed 2 changes/);
await clearToasts(B);
await B.locator('.sync-btn').first().click();
await expectToast(B, /Pulled/);
const roundTrip = await B.evaluate(async () => {
  const { store } = await import('./js/core/store.js');
  const page = await store.get('wiki', 'baobab-fruit');
  const f = await store.getFile('images/test.png');
  const bmp = await createImageBitmap(f.blob);
  return { notes: page.data.notes, w: bmp.width, type: f.blob.type };
});
assert.deepEqual(roundTrip, { notes: 'Sweet & sour — “tangy” 🍈', w: 16, type: 'image/png' });

/* ---- Download everything again ---- */
await A.getByRole('button', { name: 'Settings' }).click();
await dlg(A).getByRole('button', { name: 'Download everything again' }).waitFor();
await dlg(A).getByRole('button', { name: 'Download everything again' }).click();
await clickInDialog(A, 'Download everything');
const managed = Object.keys(gh.files()).filter(p => p.startsWith('data/') || p.startsWith('files/')).length;
await expectToast(A, new RegExp(`Pulled ${managed} changes`));
await waitNoDialog(A);
await clearToasts(A);
await A.locator('.sync-btn', { hasText: 'Pull' }).click();
await expectToast(A, /Already up to date/);

/* ---- Themes and settings screenshots ---- */
await A.getByRole('button', { name: 'Switch to the light theme' }).click();
await A.screenshot({ path: SHOTS + 'a6-light.png' });
await A.getByRole('button', { name: 'Switch to the dark theme' }).click();
assert.equal(await A.evaluate(() => document.documentElement.dataset.mode), 'dark');
await A.getByRole('button', { name: 'Settings' }).click();
await A.waitForTimeout(300);
await A.screenshot({ path: SHOTS + 'a7-settings.png' });
for (const [style, color] of [['Black', 'Gold'], ['Dark', 'Pink'], ['Light', 'Green'], ['White', 'Purple']]) {
  await dlg(A).getByRole('radio', { name: style, exact: true }).click();
  await dlg(A).getByRole('radio', { name: color, exact: true }).click();
  await A.waitForTimeout(100);
  await A.screenshot({ path: SHOTS + `a8-${style}-${color}.png`.toLowerCase() });
}
await dlg(A).getByRole('radio', { name: 'Dark', exact: true }).click();
await dlg(A).getByRole('radio', { name: 'Cyan', exact: true }).click();
assert.equal(await A.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), '#0B1A2E');
await A.keyboard.press('Escape');
await B.getByRole('button', { name: 'Settings' }).click();
await B.waitForTimeout(300);
await B.screenshot({ path: SHOTS + 'b4-phone-settings.png' });
// Danger zone: connection form is hidden until asked for
assert.equal(await dlg(B).locator('.danger-form').isHidden(), true);
await dlg(B).getByRole('button', { name: 'Change connection' }).click();
await dlg(B).locator('.danger-form input[name=token]').waitFor();
await dlg(B).locator('#settings-danger').scrollIntoViewIfNeeded();
await B.screenshot({ path: SHOTS + 'b6-phone-danger.png' });
await dlg(B).getByRole('button', { name: 'Cancel' }).click();
assert.equal(await dlg(B).locator('.danger-form').isHidden(), true);
// Light themes and one-tap toggle memory
await dlg(B).getByRole('radio', { name: 'Light', exact: true }).click();
await dlg(B).getByRole('radio', { name: 'Pink', exact: true }).click();
const lightPink = await B.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
await dlg(B).getByRole('radio', { name: 'Dark', exact: true }).click();
const darkPink = await B.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
assert.notEqual(lightPink, darkPink);
await B.keyboard.press('Escape');
await B.getByRole('button', { name: 'Switch to the light theme' }).click();
assert.equal(await B.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), lightPink);
await B.screenshot({ path: SHOTS + 'b7-phone-light-pink.png' });
await B.getByRole('button', { name: 'Switch to the dark theme' }).click();
assert.equal(await B.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), darkPink);
await B.getByRole('tab', { name: 'Tasks & Bugs' }).click();
await B.screenshot({ path: SHOTS + 'b5-phone-tasks.png' });

// Theme persists across reload
await A.getByRole('button', { name: 'Switch to the light theme' }).click();
await A.reload(); await A.waitForSelector('.topbar');
assert.equal(await A.evaluate(() => document.documentElement.dataset.mode), 'light');

console.log('commits:', gh.commitMessages().join(' <- '));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
console.log('ALL E2E CHECKS PASSED');
