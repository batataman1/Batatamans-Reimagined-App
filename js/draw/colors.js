// Colour tools for the drawing studio: the colour picker, palettes (yours are synced),
// Swap colours and the colour dialog used on phones.

import { h, clear, plural } from '../core/util.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { openModal, confirmDialog, errorDialog, toast } from '../ui/dialogs.js';
import { openPopup } from '../wiki/popup.js';
import { nameDialog } from '../tasks/views.js';
import { swapData } from './engine.js';
import {
  normHex, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb,
  getPalettes, savePalette, createPalette, BUILTIN_PALETTES,
} from './model.js';

/* ---------- Colour picker: a shade square, a hue bar and the colour code ---------- */

/** onInput(hex) while you drag; set(hex) from outside. */
export function colorPicker({ value = '#000000', onInput }) {
  let hsv = rgbToHsv(hexToRgb(value));
  const svThumb = h('span', { class: 'cp-thumb' });
  const sv = h('div', { class: 'cp-sv', role: 'slider', 'aria-label': 'Shade (lighter or darker, greyer or brighter)', tabindex: '0' }, svThumb);
  const hueThumb = h('span', { class: 'cp-thumb' });
  const hue = h('div', { class: 'cp-hue', role: 'slider', 'aria-label': 'Colour', tabindex: '0' }, hueThumb);
  const code = h('input', { class: 'input cp-code', value, maxLength: 7, spellcheck: false, autocomplete: 'off', 'aria-label': 'Colour code' });
  const swatch = h('span', { class: 'cp-swatch', 'aria-hidden': 'true' });

  const hex = () => rgbToHex(hsvToRgb(hsv));
  function draw({ typing = false } = {}) {
    sv.style.setProperty('--hue', `hsl(${hsv.h} 100% 50%)`);
    svThumb.style.left = `${hsv.s * 100}%`;
    svThumb.style.top = `${(1 - hsv.v) * 100}%`;
    hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
    swatch.style.background = hex();
    if (!typing) code.value = hex();
  }
  const drag = (el, at) => {
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      const go = ev => {
        const r = el.getBoundingClientRect();
        at(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
        draw();
        onInput?.(hex());
      };
      go(e);
      const up = () => { el.removeEventListener('pointermove', go); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', go);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  };
  drag(sv, (x, y) => { hsv = { ...hsv, s: x, v: 1 - y }; });
  drag(hue, x => { hsv = { ...hsv, h: Math.min(359.9, x * 360) }; });
  const keys = (el, fn) => el.addEventListener('keydown', e => {
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    fn(...d);
    draw();
    onInput?.(hex());
  });
  keys(sv, (dx, dy) => { hsv = { ...hsv, s: Math.max(0, Math.min(1, hsv.s + dx / 100)), v: Math.max(0, Math.min(1, hsv.v + dy / 100)) }; });
  keys(hue, dx => { hsv = { ...hsv, h: (hsv.h + dx * 2 + 360) % 360 }; });
  code.addEventListener('input', () => {
    const v = normHex(code.value);
    if (!v || v.length !== 7) return;
    hsv = rgbToHsv(hexToRgb(v));
    draw({ typing: true });
    onInput?.(v);
  });
  code.addEventListener('blur', () => draw());
  draw();
  return {
    el: h('div', { class: 'cp' }, sv, hue, h('div', { class: 'cp-row' }, swatch, code)),
    set(v) {
      v = normHex(v);
      if (!v || v === hex()) return;
      const next = rgbToHsv(hexToRgb(v));
      // Keep the hue when the colour is grey (grey has no hue of its own).
      hsv = next.s === 0 || next.v === 0 ? { ...next, h: hsv.h } : next;
      draw();
    },
  };
}

/* ---------- Palettes ---------- */

const PREF = 'brr.draw.palette';
const chosenId = () => { try { return localStorage.getItem(PREF) || BUILTIN_PALETTES[0].id; } catch { return BUILTIN_PALETTES[0].id; } };
const choose = id => { try { localStorage.setItem(PREF, id); } catch { /* storage blocked */ } };

/**
 * The palette box: a palette to pick from (built-in ones and yours), its colours, and for your
 * own palettes "+" to add the colour you're using and "Remove colours".
 * getColor(): the colour in use; onPick(hex); drawingColors(): the drawing's colours.
 */
export function palettePanel({ getColor, onPick, drawingColors, onChoose = null }) {
  const el = h('div', { class: 'pal' });
  let palettes = [];
  let removing = false;

  async function load() {
    palettes = await getPalettes();
    draw();
  }
  const current = () => palettes.find(p => p.id === chosenId()) || palettes[0];

  function draw() {
    const p = current();
    if (!p) { clear(el); return; }
    const select = h('select', { class: 'input pal-select', 'aria-label': 'Palette' },
      palettes.map(x => h('option', { value: x.id, text: x.builtin ? x.name : `${x.name}` })));
    select.value = p.id;
    select.addEventListener('change', () => { choose(select.value); removing = false; draw(); onChoose?.(); });
    const more = h('button', { type: 'button', class: 'icon-btn pal-more', 'aria-label': 'Palette options', title: 'New palette, rename, delete…', onclick: () => menu(more) }, '⋯');
    const swatches = p.colors.map(c => h('button', {
      type: 'button', class: `pal-sw${removing ? ' removing' : ''}`, style: { '--c': c }, title: removing ? `Remove ${c}` : c,
      'aria-label': removing ? `Remove ${c}` : `Use ${c}`, dataset: { color: c },
      onclick: () => (removing ? removeColor(p, c) : onPick(c)),
    }, removing ? '×' : null));
    clear(el,
      h('div', { class: 'pal-head' }, select, more),
      h('div', { class: 'pal-grid' },
        swatches,
        p.builtin ? null : h('button', {
          type: 'button', class: 'pal-sw pal-add', 'aria-label': 'Add the colour you are using', title: 'Add the colour you are using',
          onclick: () => addColor(p, getColor()),
        }, icon('plus', { size: 14 }))),
      removing ? h('div', { class: 'pal-bar' }, h('span', { class: 'small', text: 'Tap a colour to take it out.' }),
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => { removing = false; draw(); } }, 'Done')) : null,
      p.builtin ? h('p', { class: 'muted small pal-hint', text: 'Built-in palette. ⋯ → Make a copy to add your own colours.' })
        : !p.colors.length ? h('p', { class: 'muted small pal-hint', text: 'Empty. Tap + to add the colour you are using.' }) : null);
  }

  async function addColor(p, c) {
    if (p.colors.includes(c)) { toast('That colour is already in the palette.'); return; }
    try { await savePalette({ ...p, colors: [...p.colors, c] }); } catch (err) { errorDialog(err, "The colour couldn't be added"); }
  }
  async function removeColor(p, c) {
    try { await savePalette({ ...p, colors: p.colors.filter(x => x !== c) }); } catch (err) { errorDialog(err, "The colour couldn't be taken out"); }
  }

  function menu(anchor) {
    const p = current();
    openPopup({
      rect: anchor.getBoundingClientRect(),
      title: p.name,
      items: [
        { label: 'New palette…', icon: 'plus', onPick: () => newPaletteDialog({ from: p, drawingColors }) },
        { label: 'Make a copy', icon: 'copy', onPick: () => newPaletteDialog({ from: p, drawingColors, copy: true }) },
        p.builtin ? null : { label: 'Add the drawing’s colours', icon: 'palette', onPick: () => addDrawingColors(p) },
        p.builtin || !p.colors.length ? null : { label: removing ? 'Stop removing' : 'Remove colours', icon: 'eraser', onPick: () => { removing = !removing; draw(); } },
        p.builtin ? null : { label: 'Rename', icon: 'edit', onPick: () => nameDialog({ title: 'Rename palette', value: p.name, confirm: 'Save', placeholder: 'For example: Baobab wood', onSave: name => savePalette({ ...p, name }) }) },
        p.builtin ? null : { label: 'Delete palette', icon: 'trash', onPick: () => deletePalette(p) },
      ].filter(Boolean),
    });
  }
  async function addDrawingColors(p) {
    const add = drawingColors().filter(c => !p.colors.includes(c));
    if (!add.length) { toast('The palette already has all of the drawing’s colours.'); return; }
    try { await savePalette({ ...p, colors: [...p.colors, ...add] }); toast(`Added ${plural(add.length, 'colour')}.`); }
    catch (err) { errorDialog(err, "The colours couldn't be added"); }
  }
  async function deletePalette(p) {
    const ok = await confirmDialog({ title: `Delete the palette “${p.name}”?`, body: h('p', { text: 'Drawings keep their colours; only the palette goes.' }), confirm: 'Delete palette', danger: true });
    if (!ok) return;
    try { await store.remove('palettes', p.id); choose(BUILTIN_PALETTES[0].id); } catch (err) { errorDialog(err, "The palette couldn't be deleted"); }
  }

  const off = store.on(d => { if (d?.type === 'sync' || d?.collection === 'palettes') load(); });
  load();
  return { el, cleanup: off, reload: load };
}

/** New palette: empty, the drawing's colours, or a copy of a palette. */
function newPaletteDialog({ from, drawingColors, copy = false }) {
  const start = h('select', { class: 'input', name: 'start', 'aria-label': 'Start with' },
    h('option', { value: 'empty', text: 'No colours yet' }),
    h('option', { value: 'drawing', text: 'The colours of this drawing' }),
    h('option', { value: 'copy', text: `The colours of “${from.name}”` }));
  start.value = copy ? 'copy' : 'empty';
  return nameDialog({
    title: copy ? 'Copy palette' : 'New palette', confirm: 'Make palette', placeholder: 'For example: Baobab wood',
    value: copy ? `${from.name} (my copy)` : '',
    extra: h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Start with' }), start),
    onSave: async name => {
      const colors = start.value === 'drawing' ? drawingColors() : start.value === 'copy' ? from.colors : [];
      const p = await createPalette({ name, colors });
      choose(p.id);
    },
  });
}

/* ---------- Picking a colour in a dialog (phones, Swap colours) ---------- */

/** The colours of the palette chosen in the palette box (for the phone's colour row). */
export async function currentPaletteColors() {
  const all = await getPalettes();
  return (all.find(p => p.id === chosenId()) || all[0])?.colors || [];
}

/**
 * A dialog with the picker and a palette. Resolves with the colour, null (cancelled), or
 * "keep" when `keepLabel` is given and that button is pressed.
 */
export function pickColorDialog({ title = 'Pick a colour', value = '#000000', keepLabel = null, drawingColors = () => [] }) {
  let chosen = value;
  const picker = colorPicker({ value, onInput: v => { chosen = v; } });
  const pal = palettePanel({ getColor: () => chosen, onPick: v => { chosen = v; picker.set(v); }, drawingColors });
  const keep = keepLabel ? h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => m.close('keep') }, keepLabel) : null;
  const m = openModal({
    title, className: 'modal-color',
    body: [picker.el, pal.el, keep],
    actions: [{ id: 'cancel', label: 'Cancel', kind: 'quiet' }, { id: 'ok', label: 'Use this colour', kind: 'primary' }],
  });
  return m.result.then(v => { pal.cleanup(); return v === 'ok' ? chosen : v === 'keep' ? 'keep' : null; });
}

/* ---------- Swap colours ---------- */

const MAX_ROWS = 40;

/**
 * Pick new colours for the drawing's colours and see the result. Resolves with
 * { map, similar, copy } ("Make a copy" sets copy), or null.
 */
export function swapColorsDialog(engine, { pixel }) {
  const used = engine.colorsUsed();
  if (!used.length) { toast('The drawing is empty: there are no colours to swap yet.'); return Promise.resolve(null); }
  const total = used.reduce((a, c) => a + c.count, 0);
  const shown = used.slice(0, MAX_ROWS);
  const map = {};
  const original = engine.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, engine.W, engine.H);

  // The preview: at most 256 pixels per side is enough to see the result.
  const f = Math.max(1, Math.ceil(Math.max(engine.W, engine.H) / 256));
  const pw = Math.ceil(engine.W / f), ph = Math.ceil(engine.H / f);
  const small = new ImageData(pw, ph);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const i = ((y * f) * engine.W + x * f) * 4, j = (y * pw + x) * 4;
    small.data[j] = original.data[i]; small.data[j + 1] = original.data[i + 1]; small.data[j + 2] = original.data[i + 2]; small.data[j + 3] = original.data[i + 3];
  }
  const preview = h('canvas', { class: `sw-preview${pixel ? ' pixelated' : ''}`, width: pw, height: ph });
  const similar = h('input', { type: 'checkbox', name: 'similar' });
  function drawPreview() {
    const copy = new ImageData(new Uint8ClampedArray(small.data), pw, ph);
    swapData(copy.data, map, similar.checked ? 48 : 0);
    preview.getContext('2d').putImageData(copy, 0, 0);
  }
  similar.addEventListener('change', drawPreview);

  const colorsOf = () => used.map(c => c.hex);
  const rows = shown.map(c => {
    const to = h('button', { type: 'button', class: 'sw-to', 'aria-label': `New colour for ${c.hex}`, dataset: { from: c.hex } });
    const drawTo = () => {
      const v = map[c.hex];
      to.style.setProperty('--c', v || c.hex);
      to.classList.toggle('same', !v);
      clear(to, h('span', { class: 'sw-to-text', text: v ? v : 'Same' }));
    };
    to.addEventListener('click', async () => {
      const v = await pickColorDialog({
        title: `New colour for ${c.hex}`, value: map[c.hex] || c.hex, drawingColors: colorsOf,
        keepLabel: map[c.hex] ? 'Keep the old colour' : null,
      });
      if (!v) return;
      if (v === 'keep' || v === c.hex) delete map[c.hex]; else map[c.hex] = v;
      drawTo();
      drawPreview();
    });
    drawTo();
    const share = c.count / total * 100;
    return h('li', { class: 'sw-row' },
      h('span', { class: 'sw-from', style: { '--c': c.hex }, title: c.hex }),
      h('span', { class: 'sw-arrow', 'aria-hidden': 'true', text: '→' }),
      to,
      h('span', { class: 'muted small sw-share', text: share >= 1 ? `${Math.round(share)}%` : '<1%' }));
  });
  drawPreview();

  const m = openModal({
    title: 'Swap colours', className: 'modal-wide modal-swap',
    body: [
      h('p', { class: 'small', text: 'Tap a colour on the right to pick its new colour. Every pixel of the old colour changes.' }),
      h('div', { class: 'sw-layout' },
        h('ul', { class: 'sw-list' }, rows),
        h('div', { class: 'sw-side' }, preview,
          h('label', { class: 'ed-check small' }, similar, h('span', { text: 'Also change shades close to these colours (for smooth edges and shading)' })))),
      used.length > MAX_ROWS ? h('p', { class: 'muted small', text: `Showing the ${MAX_ROWS} most used colours of ${used.length}.` }) : null,
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'copy', label: 'Make a copy with these colours', onClick: close => (Object.keys(map).length ? close('copy') : toast('Pick a new colour first.')) },
      { id: 'apply', label: 'Change this drawing', kind: 'primary', onClick: close => (Object.keys(map).length ? close('apply') : toast('Pick a new colour first.')) },
    ],
  });
  return m.result.then(v => (v === 'apply' || v === 'copy' ? { map: { ...map }, similar: similar.checked ? 48 : 0, copy: v === 'copy' } : null));
}
