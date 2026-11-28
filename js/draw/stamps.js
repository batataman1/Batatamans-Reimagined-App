// Stamps (part 2e): small pictures you stamp onto a drawing with the Stamp tool.
//
// Collection "stamps", id "st-<random>": { name, kind: "pixel" | "free", scale, created }
//   scale = pixels of its picture per square (pixel stamps: 1, one pixel per square)
// Its picture: files/stamps/<id>.png. Stamps are made from a selection ("Save as stamp") or a
// whole drawing, and sync like palettes. A few built-in pixel stamps live in the code.

import { h, clear, uid } from '../core/util.js';
import { store } from '../core/store.js';
import { openModal, confirmDialog, errorDialog, toast } from '../ui/dialogs.js';
import { openPopup } from '../wiki/popup.js';
import { nameDialog } from '../tasks/views.js';

export const stampFile = id => `stamps/${id}.png`;
export const isStampFile = (path, id) => String(path).startsWith(`stamps/${id}.`);

/* ---------- Built-in stamps: one character per square ---------- */

const BUILTIN = [
  { id: 'b-heart', name: 'Heart', colors: { R: '#e0313c', W: '#ffb3b8', D: '#9c1b25' }, rows: [
    '.RR.RR.', 'RWRRRRR', 'RRRRRRD', '.RRRRD.', '..RRD..', '...D...'] },
  { id: 'b-star', name: 'Star', colors: { Y: '#f5d547', O: '#e0a020', W: '#fff6b8' }, rows: [
    '...Y...', '...W...', '..YYY..', 'YYYWYYY', '.YYYYO.', '..YYO..', '.YYOOO.', '.YO..O.'] },
  { id: 'b-leaf', name: 'Leaf', colors: { G: '#4caf50', L: '#a8d84e', D: '#2f7a33' }, rows: [
    '....GGG', '..GGGGG', '.GGGLGG', 'GGGLGGD', 'GGLGGD.', 'GLGGD..', 'L.DD...'] },
  { id: 'b-sparkle', name: 'Sparkle', colors: { W: '#ffffff', Y: '#fff3a0' }, rows: [
    '..W..', '..W..', 'WWYWW', '..W..', '..W..'] },
  { id: 'b-flower', name: 'Flower', colors: { P: '#f08ba8', Y: '#f5d547', G: '#4caf50' }, rows: [
    '.P.P.', 'PPYPP', '.PPP.', '..G..', 'G.G..', '.GG.G', '..GG.'] },
  { id: 'b-mushroom', name: 'Mushroom', colors: { R: '#c9302c', W: '#ffffff', B: '#e6d3a8', S: '#b89f6e' }, rows: [
    '..RRR..', '.RWRRR.', 'RRRRWRR', 'RWRRRRR', '..BBS..', '..BBS..', '..BBS..'] },
  { id: 'b-gem', name: 'Gem', colors: { C: '#3ab3da', L: '#bff0ff', D: '#1f6e9e' }, rows: [
    '.CCCCC.', 'CLCCCDC', '.CCCCD.', '..CCD..', '...D...'] },
  { id: 'b-cloud', name: 'Cloud', colors: { W: '#ffffff', G: '#d0d6dc' }, rows: [
    '..WWW...', '.WWWWWW.', 'WWWWWWWW', '.GGGGGG.'] },
];

function builtinCanvas(b) {
  const w = Math.max(...b.rows.map(r => r.length)), hh = b.rows.length;
  const c = Object.assign(document.createElement('canvas'), { width: w, height: hh });
  const g = c.getContext('2d');
  b.rows.forEach((row, y) => [...row].forEach((ch, x) => { if (b.colors[ch]) { g.fillStyle = b.colors[ch]; g.fillRect(x, y, 1, 1); } }));
  return c;
}

/* ---------- Loading ---------- */

const pictures = new Map();   // id|version -> canvas
store.on(e => { if (e?.type === 'sync') pictures.clear(); });

async function canvasOfBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

/**
 * Every stamp: built-in ones first, then yours (oldest first).
 * [{ id, name, kind, scale, builtin, canvas (null if its picture isn't on this device) }]
 */
export async function getStamps() {
  const out = BUILTIN.map(b => {
    if (!pictures.has(b.id)) pictures.set(b.id, builtinCanvas(b));
    return { id: b.id, name: b.name, kind: 'pixel', scale: 1, builtin: true, canvas: pictures.get(b.id) };
  });
  const rows = (await store.list('stamps')).sort((a, b) => String(a.data.created || '').localeCompare(String(b.data.created || '')));
  for (const r of rows) {
    const f = await store.getFile(stampFile(r.id));
    let canvas = null;
    if (f?.blob) {
      const key = `${r.id}|${f.updatedAt}`;
      if (!pictures.has(key)) { try { pictures.set(key, await canvasOfBlob(f.blob)); } catch { /* broken picture */ } }
      canvas = pictures.get(key) || null;
    }
    out.push({ id: r.id, name: String(r.data?.name || 'Stamp'), kind: r.data?.kind === 'free' ? 'free' : 'pixel', scale: Math.max(1, Number(r.data?.scale) || 1), builtin: false, canvas, dirty: r.dirty });
  }
  return out;
}

/** Save a picture as a new stamp. */
export async function createStamp({ name, canvas, kind, scale }) {
  const id = uid('st');
  const blob = await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("The stamp couldn't be made"))), 'image/png'));
  await store.putFile(stampFile(id), blob, { source: 'draw' });
  await store.put('stamps', id, { name, kind, scale, created: new Date().toISOString() });
  return id;
}

export async function removeStamp(id) {
  await store.removeFile(stampFile(id));
  await store.remove('stamps', id);
}

/** A small copy of a stamp for buttons and lists. */
export function stampThumb(s, size = 28) {
  const c = h('canvas', { class: `st-thumb${s.kind === 'pixel' ? ' pixelated' : ''}`, width: size * 2, height: size * 2, 'aria-hidden': 'true' });
  if (s.canvas) {
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = s.kind !== 'pixel';
    const f = Math.min((size * 2) / s.canvas.width, (size * 2) / s.canvas.height);
    const w = s.canvas.width * f, hh = s.canvas.height * f;
    g.drawImage(s.canvas, (c.width - w) / 2, (c.height - hh) / 2, w, hh);
  }
  return c;
}

/* ---------- Choosing a stamp ---------- */

/**
 * The stamps to pick from (built-in and yours). Yours have ⋯ to rename or delete them.
 * Resolves with the chosen stamp's id, or null.
 */
export function stampsDialog({ current = null } = {}) {
  const grid = h('div', { class: 'st-grid', role: 'listbox', 'aria-label': 'Stamps' });
  let m = null;
  async function draw() {
    const list = await getStamps();
    const mine = list.filter(s => !s.builtin);
    clear(grid,
      list.map(s => {
        const pick = h('button', {
          type: 'button', class: `st-item${s.id === current ? ' current' : ''}`, role: 'option', 'aria-selected': String(s.id === current),
          title: s.name, dataset: { stamp: s.id }, onclick: () => m.close(s.id),
        }, stampThumb(s, 30), h('span', { class: 'st-name', text: s.name }));
        if (s.builtin) return pick;
        const more = h('button', { type: 'button', class: 'icon-btn st-more', 'aria-label': `More for ${s.name}`, title: 'Rename or delete', onclick: () => stampMenu(s, more) }, '⋯');
        return h('div', { class: 'st-cell' }, pick, more);
      }),
      mine.length ? null : h('p', { class: 'muted small st-hint', text: 'To make your own: select part of a drawing and tap Save as stamp, or ⋯ → Use this drawing as a stamp.' }));
  }
  function stampMenu(s, anchor) {
    openPopup({
      rect: anchor.getBoundingClientRect(), title: s.name,
      items: [
        { label: 'Rename', icon: 'edit', onPick: () => nameDialog({ title: 'Rename stamp', value: s.name, confirm: 'Save', placeholder: 'For example: Baobab leaf', onSave: async name => { const r = await store.get('stamps', s.id); await store.put('stamps', s.id, { ...(r?.data || {}), name }); draw(); } }) },
        { label: 'Delete stamp', icon: 'trash', onPick: async () => {
          const ok = await confirmDialog({ title: `Delete the stamp “${s.name}”?`, body: h('p', { text: 'Drawings keep what you stamped with it.' }), confirm: 'Delete stamp', danger: true });
          if (!ok) return;
          try { await removeStamp(s.id); draw(); toast('Stamp deleted.'); } catch (err) { errorDialog(err, "The stamp couldn't be deleted"); }
        } },
      ],
    });
  }
  m = openModal({ title: 'Stamps', className: 'modal-stamps', body: grid, actions: [{ id: 'cancel', label: 'Close', kind: 'quiet' }] });
  draw();
  return m.result.then(v => (v && v !== 'cancel' ? v : null));
}

/** Ask for a name, then save the picture as a stamp. */
export function saveStampDialog({ canvas, kind, scale, name = '' }) {
  return nameDialog({
    title: 'Save as stamp', confirm: 'Save stamp', placeholder: 'For example: Baobab leaf', value: name,
    extra: h('p', { class: 'muted small', text: 'It shows up in the Stamp tool, on all your devices after a Push.' }),
    onSave: async n => { await createStamp({ name: n, canvas, kind, scale }); toast('Stamp saved. Pick it in the Stamp tool.'); },
  });
}

