// The Drawings gallery in Ideas (#/ideas/d/<section>), the dialogs for a drawing (new, name and
// section, export, duplicate, delete) and the Drawings box on an idea's page.

import { h, clear } from '../core/util.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { openModal, confirmDialog, errorDialog, toast } from '../ui/dialogs.js';
import { openPopup } from '../wiki/popup.js';
import { getIdeas } from '../ideas/model.js';
import { sectionSelect } from '../ideas/actions.js';
import { createEngine } from './engine.js';
import {
  getDrawings, createDrawing, removeDrawing, storableDrawing, fileOf, scaleFor, importReference,
  PIXEL_SIZES, FREE_SHAPES, MAX_SIDE,
} from './model.js';

const drawingHref = id => `#/ideas/draw/${encodeURIComponent(id)}`;
const sizeText = d => `${d.data.width} × ${d.data.height}`;
const kindText = d => (d.data.kind === 'reference' ? `Reference picture ${sizeText(d)}` : d.data.kind === 'pixel' ? `Pixel art ${sizeText(d)}` : 'Free drawing');

/* ---------- Thumbnails ---------- */

// Small copies of the pictures, made once per saved version.
const thumbs = new Map();
store.on(e => { if (e?.type === 'sync') thumbs.clear(); });

export function thumbCanvas(d, size = 160) {
  const px = size * 2;
  // Pixel art, and small reference pictures (like a texture), stay sharp.
  const sharp = d.data.kind === 'pixel' || (d.data.kind === 'reference' && Math.max(d.data.width, d.data.height) <= 128);
  const c = h('canvas', { class: `dg-thumb${sharp ? ' pixelated' : ''}`, width: px, height: px, 'aria-hidden': 'true' });
  const blob = d.file?.blob;
  if (!blob) return c;
  (async () => {
    const key = `${d.id}|${d.file.updatedAt}`;
    let bmp = thumbs.get(key);
    if (!bmp) {
      const f = px / Math.max(d.data.width, d.data.height);
      try {
        bmp = await createImageBitmap(blob, {
          resizeWidth: Math.max(1, Math.round(d.data.width * f)), resizeHeight: Math.max(1, Math.round(d.data.height * f)),
          resizeQuality: sharp ? 'pixelated' : 'high',
        });
      } catch { bmp = await createImageBitmap(blob).catch(() => null); }
      if (!bmp) return;
      for (const k of thumbs.keys()) if (k.startsWith(`${d.id}|`)) thumbs.delete(k);
      thumbs.set(key, bmp);
    }
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = !sharp;
    const f = Math.min(px / bmp.width, px / bmp.height);
    const w = bmp.width * f, hh = bmp.height * f;
    g.drawImage(bmp, (px - w) / 2, (px - hh) / 2, w, hh);
  })();
  return c;
}

/* ---------- The gallery ---------- */

/** The gallery for a section key ("all", "none" or a section id). */
export function galleryContent(ctx, key) {
  const { model, drawings } = ctx;
  const list = drawings.inSection(key, model);
  const where = d => {
    const s = d.data.section && model.section(d.data.section);
    return s ? model.path(s.id).map(x => x.name).join(' › ') : 'Not sorted';
  };
  const section = key === 'all' || key === 'none' ? null : key;
  return h('div', { class: 'dg' },
    list.length
      ? h('div', { class: 'dg-grid' }, list.map(d => drawingCard(d, ctx, { where: (key === 'all' || d.data.section !== section) ? where(d) : '' })))
      : h('div', { class: 'dg-empty' },
        icon('brush', { size: 40 }),
        h('p', { text: key === 'all' ? 'No drawings yet.' : 'No drawings in here yet.' }),
        h('p', { class: 'muted small', text: 'Pixel art for textures, or free drawings for sketches and ideas.' }),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => newDrawingDialog(ctx, { section }) }, icon('plus', { size: 16 }), 'New drawing')));
}

export function drawingCard(d, ctx, { where = '', small = false } = {}) {
  const { model } = ctx;
  const idea = d.data.idea ? model.get(d.data.idea) : null;
  const more = h('button', {
    type: 'button', class: 'row-menu dg-more', 'aria-label': `More for ${d.data.name}`, title: 'Name, export, duplicate, delete',
    onclick: e => { e.preventDefault(); drawingMenu(d, more, ctx); },
  }, '⋯');
  return h('article', { class: `dg-card${small ? ' small' : ''}`, dataset: { drawing: d.id } },
    h('div', { class: 'dg-pic' }, thumbCanvas(d, small ? 110 : 160)),
    h('div', { class: 'dg-body' },
      h('a', { class: 'dg-name tk-open', href: drawingHref(d.id), text: d.data.name }),
      h('span', { class: 'muted small dg-sub' },
        [kindText(d), where, small ? '' : idea ? `Idea: ${idea.data.title || '(no title)'}` : ''].filter(Boolean).join(' · ')),
      d.dirty ? h('span', { class: 'tag tag-dirty', text: 'Not pushed' }) : null),
    more);
}

function drawingMenu(d, anchor, ctx) {
  const ref = d.data.kind === 'reference';
  openPopup({
    rect: anchor.getBoundingClientRect(),
    title: d.data.name,
    items: [
      { label: 'Open', icon: ref ? 'image' : 'brush', onPick: () => ctx.ui.go(`draw/${d.id}`) },
      { label: 'Name, section and idea…', icon: 'edit', onPick: () => detailsDialog(d, ctx.model) },
      ref ? null : { label: 'Export PNG…', icon: 'download', onPick: () => exportDialog(d) },
      ref ? null : { label: 'Duplicate', icon: 'copy', onPick: () => duplicateDrawing(d, ctx.ui) },
      {
        label: 'Delete', icon: 'trash',
        onPick: async () => {
          if (!(await confirmDeleteDrawing(d))) return;
          try { await removeDrawing(d.id, d.data); } catch (err) { errorDialog(err, "It couldn't be deleted"); return; }
          toast(`${ref ? 'Picture' : 'Drawing'} deleted. Push to remove it from GitHub too.`);
        },
      },
    ].filter(Boolean),
  });
}

/** A picture from the device, saved as a reference (to look at and pick colours from) and opened. */
export function addReferenceFromDevice(ctx, { section = null, idea = null } = {}) {
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, class: 'dg-file' });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const ref = await importReference(file, { section, idea });
      ctx.ui.go(`draw/${ref.id}`);
    } catch (err) { errorDialog(err, "The picture couldn't be added"); }
  });
  input.click();
}

/* ---------- New drawing ---------- */

/** The ideas you can tie a drawing to: the ones in the chosen section (or with no section). */
function fillIdeaSelect(sel, model, sectionId, value) {
  const list = model.ideasIn(sectionId || 'none').sort((a, b) => (a.data.title || '').localeCompare(b.data.title || ''));
  clear(sel, h('option', { value: '', text: 'No idea (just a drawing)' }),
    list.map(i => h('option', { value: i.id, text: i.data.title || '(no title)' })));
  sel.value = value && list.some(i => i.id === value) ? value : '';
}

export function newDrawingDialog(ctx, { section = null, idea = null } = {}) {
  const { model, ui } = ctx;
  const name = h('input', { class: 'input', name: 'name', autocomplete: 'off', maxLength: 60, placeholder: 'For example: Baobab log' });
  let kind = 'pixel', pixelSize = '16', shape = 'square';
  const wIn = h('input', { class: 'input dg-num', type: 'number', name: 'width', min: 1, max: MAX_SIDE, value: 24, 'aria-label': 'Width in squares' });
  const hIn = h('input', { class: 'input dg-num', type: 'number', name: 'height', min: 1, max: MAX_SIDE, value: 24, 'aria-label': 'Height in squares' });
  const sizeHost = h('div', { class: 'field' });
  const seg = (label, options, value, onPick) => h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([v, text]) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(v === value), dataset: { value: v }, onclick: () => onPick(v) }, text)));
  function drawSize() {
    clear(sizeHost,
      h('span', { class: 'field-label', text: kind === 'pixel' ? 'Size (squares)' : 'Shape' }),
      kind === 'pixel'
        ? [seg('Size', [...PIXEL_SIZES.map(n => [String(n), `${n} × ${n}`]), ['own', 'Own size']], pixelSize, v => { pixelSize = v; drawSize(); }),
          pixelSize === 'own' ? h('div', { class: 'dg-own' }, wIn, h('span', { text: '×' }), hIn, h('span', { class: 'muted small', text: `up to ${MAX_SIDE}` })) : null,
          h('span', { class: 'field-hint', text: 'Minecraft textures are 16 × 16. The pixel pen fills one square at a time.' })]
        : [seg('Shape', Object.entries(FREE_SHAPES).map(([k, v]) => [k, v.name]), shape, v => { shape = v; drawSize(); }),
          h('span', { class: 'field-hint', text: 'Smooth lines for sketches. The pixel pen still works on it, in bigger squares.' })]);
  }
  const kindHost = h('div', { class: 'field' });
  function drawKind() {
    clear(kindHost, h('span', { class: 'field-label', text: 'Kind' }),
      seg('Kind', [['pixel', 'Pixel art'], ['free', 'Free drawing']], kind, v => { kind = v; drawKind(); drawSize(); }));
  }
  const secSel = sectionSelect(model, section);
  const ideaSel = h('select', { class: 'input', name: 'idea', 'aria-label': 'Belongs to idea' });
  fillIdeaSelect(ideaSel, model, secSel.value, idea);
  secSel.addEventListener('change', () => fillIdeaSelect(ideaSel, model, secSel.value, ideaSel.value));
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  drawKind();
  drawSize();

  const make = async close => {
    const n = name.value.trim();
    if (!n) { error.textContent = 'Give it a name.'; error.hidden = false; name.focus(); return; }
    let width, height;
    if (kind === 'pixel') {
      if (pixelSize === 'own') {
        width = Math.round(+wIn.value); height = Math.round(+hIn.value);
        if (!(width >= 1 && width <= MAX_SIDE && height >= 1 && height <= MAX_SIDE)) { error.textContent = `Width and height go from 1 to ${MAX_SIDE}.`; error.hidden = false; return; }
      } else width = height = +pixelSize;
    } else ({ width, height } = FREE_SHAPES[shape]);
    try {
      const d = await createDrawing({ name: n, section: secSel.value || null, idea: ideaSel.value || null, width, height, kind });
      close('made');
      ui.go(`draw/${d.id}`);
    } catch (err) { error.textContent = err.message || String(err); error.hidden = false; }
  };
  const m = openModal({
    title: 'New drawing',
    body: h('div', { class: 'connect-form' },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Name' }), name),
      kindHost, sizeHost,
      h('div', { class: 'field-grid' },
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Section' }), secSel),
        h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Belongs to idea' }), ideaSel)),
      error),
    actions: [{ id: 'cancel', label: 'Cancel', kind: 'quiet' }, { id: 'make', label: 'Make drawing', kind: 'primary', onClick: make }],
    onOpen: () => name.focus(),
  });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); make(m.close); } });
  return m.result;
}

/* ---------- Name, section and idea ---------- */

/** Resolves with the saved data, or null. */
export function detailsDialog(d, model) {
  const name = h('input', { class: 'input', name: 'name', value: d.data.name, autocomplete: 'off', maxLength: 60 });
  const secSel = sectionSelect(model, d.data.section);
  const ideaSel = h('select', { class: 'input', name: 'idea', 'aria-label': 'Belongs to idea' });
  fillIdeaSelect(ideaSel, model, secSel.value, d.data.idea);
  secSel.addEventListener('change', () => fillIdeaSelect(ideaSel, model, secSel.value, ideaSel.value));
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  let saved = null;
  const save = async close => {
    const n = name.value.trim();
    if (!n) { error.textContent = 'Give it a name.'; error.hidden = false; return; }
    const data = storableDrawing({ ...d.data, name: n, section: secSel.value || null, idea: ideaSel.value || null });
    try { await store.put('drawings', d.id, data); } catch (err) { error.textContent = err.message || String(err); error.hidden = false; return; }
    saved = data;
    close('saved');
  };
  const m = openModal({
    title: 'Name, section and idea',
    body: h('div', { class: 'connect-form' },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Name' }), name),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Section' }), secSel),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Belongs to idea' }), ideaSel,
        h('span', { class: 'field-hint', text: 'The idea shows this drawing on its page.' })),
      h('p', { class: 'muted small', text: d.data.kind === 'reference' ? `Reference picture, ${d.data.width} × ${d.data.height} pixels.` : `${d.data.kind === 'pixel' ? 'Pixel art' : 'Free drawing'}, ${d.data.width} × ${d.data.height} squares.` }),
      error),
    actions: [{ id: 'cancel', label: 'Cancel', kind: 'quiet' }, { id: 'save', label: 'Save', kind: 'primary', onClick: save }],
  });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(m.close); } });
  return m.result.then(() => saved);
}

/* ---------- Copies ---------- */

const canvasBlob = c => new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error("The picture couldn't be made"))), 'image/png'));

async function madeCopy(id, ui) {
  toast('Copy made.', { action: { label: 'Open it', onClick: () => ui.go(`draw/${id}`) } });
}

export async function duplicateDrawing(d, ui) {
  try {
    const file = await store.getFile(fileOf(d));
    const copy = await createDrawing({ ...d.data, name: `${d.data.name} (copy)`, file: file?.blob || null });
    madeCopy(copy.id, ui);
  } catch (err) { errorDialog(err, "The drawing couldn't be copied"); }
}

/** A copy whose picture is the source canvas changed by fn(pixel data). */
export async function copyWithPicture(d, ui, source, fn, label) {
  try {
    const c = Object.assign(document.createElement('canvas'), { width: source.width, height: source.height });
    const g = c.getContext('2d');
    const img = source.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, source.width, source.height);
    fn(img.data);
    g.putImageData(img, 0, 0);
    const copy = await createDrawing({ ...d.data, name: `${d.data.name} (${label})`, file: await canvasBlob(c) });
    madeCopy(copy.id, ui);
  } catch (err) { errorDialog(err, "The copy couldn't be made"); }
}

/** A copy whose picture is the given pixels (ImageData at the fine size, from an effect's preview). */
export async function copyWithImage(d, ui, image, label) {
  try {
    const c = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
    c.getContext('2d').putImageData(image, 0, 0);
    const copy = await createDrawing({ ...d.data, name: `${d.data.name} (${label})`, file: await canvasBlob(c) });
    madeCopy(copy.id, ui);
  } catch (err) { errorDialog(err, "The copy couldn't be made"); }
}

export function confirmDeleteDrawing(d) {
  const ref = d.data.kind === 'reference';
  return confirmDialog({
    title: `Delete “${d.data.name}”?`,
    body: h('p', { text: ref ? 'The reference picture is deleted. Your drawings keep their colours.' : 'The drawing and its picture are deleted.' }),
    confirm: ref ? 'Delete picture' : 'Delete drawing', danger: true,
  });
}

/* ---------- Export ---------- */

/** A file name like Minecraft's: "baobab_log.png". */
const fileName = name => `${String(name || 'drawing').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'drawing'}.png`;

/** Download the picture as a PNG (see-through kept) at a size you choose. */
export async function exportDialog(d, engine = null) {
  const data = d.data;
  if (!engine) {
    const file = await store.getFile(fileOf(d));
    engine = createEngine({ width: data.width, height: data.height, scale: data.scale || scaleFor(data.width, data.height) });
    await engine.load(file?.blob);
  }
  const k = engine.scale;
  const sizes = [];
  for (let m = 1; data.width * m <= 4096 && data.height * m <= 4096 && (m <= k || m <= 16); m *= 2) sizes.push(m);
  const pick = data.kind === 'pixel' ? 1 : k;
  const choices = h('div', { class: 'dg-sizes', role: 'radiogroup', 'aria-label': 'Size' }, sizes.map(m => h('label', { class: 'dg-size' },
    h('input', { type: 'radio', name: 'size', value: m, checked: m === pick }),
    h('span', { text: `${data.width * m} × ${data.height * m}` }),
    h('span', { class: 'muted small', text: m === 1 ? (data.kind === 'pixel' ? 'one pixel per square: the size for Minecraft' : 'one pixel per square') : m === k ? 'every detail' : `${m}×` }))));
  const nameIn = h('input', { class: 'input', name: 'file', value: fileName(data.name), autocomplete: 'off', spellcheck: false });
  const m = openModal({
    title: 'Export PNG',
    body: h('div', { class: 'connect-form' },
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Size' }), choices,
        h('span', { class: 'field-hint', text: 'See-through parts stay see-through. Pixel art stays sharp at every size.' })),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'File name' }), nameIn)),
    actions: [{ id: 'cancel', label: 'Cancel', kind: 'quiet' }, {
      id: 'download', label: 'Download', kind: 'primary',
      onClick: async close => {
        const mult = +choices.querySelector('input:checked').value;
        try {
          const blob = await canvasBlob(engine.exportCanvas(mult));
          let fname = nameIn.value.trim() || fileName(data.name);
          if (!/\.png$/i.test(fname)) fname += '.png';
          const url = URL.createObjectURL(blob);
          const a = h('a', { href: url, download: fname });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          close('done');
          toast(`Downloaded ${fname}.`);
        } catch (err) { errorDialog(err, "The picture couldn't be exported"); }
      },
    }],
  });
  return m.result;
}

/* ---------- On an idea's page ---------- */

/** The Drawings box: drawings that belong to the idea, and New drawing for it. */
export function ideaDrawingsBox({ ideaId, section, ui }) {
  const host = h('div', { class: 'dg-idea' });
  async function draw() {
    const [drawings, model] = await Promise.all([getDrawings(), getIdeas()]);
    const ctx = { drawings, model, ui };
    const list = drawings.ofIdea(ideaId);
    clear(host,
      list.length
        ? h('div', { class: 'dg-grid small' }, list.map(d => drawingCard(d, ctx, { small: true })))
        : h('p', { class: 'muted small', text: 'No drawings yet. Sketch the idea, or make its texture.' }),
      h('div', { class: 'button-row' }, h('button', {
        type: 'button', class: 'btn btn-small',
        onclick: () => newDrawingDialog(ctx, { section: section(), idea: ideaId }),
      }, icon('plus', { size: 14 }), 'New drawing for this idea')));
  }
  const off = store.on(e => {
    if (e?.type === 'sync' || e?.collection === 'drawings' || (e?.type === 'file' && String(e.path || '').startsWith('drawings/'))) draw();
  });
  draw();
  return { el: host, cleanup: off };
}

