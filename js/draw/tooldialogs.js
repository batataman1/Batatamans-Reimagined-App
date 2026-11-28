// Dialogs for the drawing tools (part 2e): the Text tool's text box and the Effects
// (hue/saturation/lightness, blur, noise, pixelate, outline), each with a live preview.

import { h, clear } from '../core/util.js';
import { openModal, toast } from '../ui/dialogs.js';
import { hexToRgb } from './model.js';
import { FONTS, textCanvas, pixelFontCovers } from './font.js';
import { adjustData, blurData, noiseData, pixelateData, outlineData } from './effects.js';

const seg = (name, options, value, onPick) => h('div', { class: 'seg', role: 'group', 'aria-label': name },
  options.map(([v, text]) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(v === value), dataset: { value: v }, onclick: e => {
    for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
    onPick(v);
  } }, text)));
function slider(label, { min, max, value, show, onInput, name, step = 1 }) {
  const out = h('span', { class: 'dr-slider-value', text: show(value) });
  const input = h('input', { type: 'range', min, max, step, value, name, 'aria-label': label });
  input.addEventListener('input', () => { out.textContent = show(+input.value); onInput(+input.value); });
  return h('label', { class: 'dr-slider fx-slider' }, h('span', { class: 'dr-slider-label', text: label }), input, out);
}
const field = (label, ...content) => h('div', { class: 'field' }, h('span', { class: 'field-label', text: label }), content);

/* ---------- Text ---------- */

/**
 * The text and how it looks. Resolves with { canvas, unit } (canvas pixels per square) to place
 * on the drawing, or null.
 */
export function textDialog({ prefs, savePrefs, mode, k }) {
  const pixel = mode === 'pixel';
  const text = h('textarea', { class: 'input tx-text', name: 'text', rows: 3, placeholder: 'Your text', 'aria-label': 'Text' });
  text.value = prefs.lastText || '';
  const font = h('select', { class: 'input', name: 'font', 'aria-label': 'Font' }, Object.entries(FONTS).map(([id, f]) => h('option', { value: id, text: f.name })));
  font.value = FONTS[prefs.font] ? prefs.font : 'pixel';
  const sizeHost = h('div', { class: 'tx-size' });
  const bold = h('input', { type: 'checkbox', name: 'bold', checked: !!prefs.fontBold });
  const boldRow = h('label', { class: 'ed-check small' }, bold, h('span', { text: 'Bold' }));
  let align = prefs.textAlign || 'left';
  const preview = h('canvas', { class: `tx-preview${pixel ? ' pixelated' : ''}`, width: 10, height: 10 });
  const note = h('p', { class: 'muted small tx-note' });
  const swatch = h('span', { class: 'tx-swatch', style: { '--c': prefs.color } });

  function drawSize() {
    clear(sizeHost, font.value === 'pixel'
      ? slider('Dot size', { name: 'dot', min: 1, max: 4, value: prefs.pixelDot || 1, show: v => `${v} square${v > 1 ? 's' : ''}`, onInput: v => { prefs.pixelDot = v; render(); } })
      : slider('Height', { name: 'height', min: 3, max: 64, value: prefs.fontSize || 8, show: v => `${v} squares`, onInput: v => { prefs.fontSize = v; render(); } }));
    boldRow.hidden = font.value === 'pixel';
  }
  let result = null;
  function render() {
    const c = hexToRgb(prefs.color);
    const isPixelFont = font.value === 'pixel';
    result = textCanvas(text.value, {
      font: font.value, size: isPixelFont ? prefs.pixelDot || 1 : prefs.fontSize || 8, color: [c.r, c.g, c.b], bold: bold.checked, align,
      unit: isPixelFont || pixel ? 1 : k, sharp: pixel && !isPixelFont,
    });
    const g = preview.getContext('2d');
    if (!result) { preview.width = 10; preview.height = 10; g.clearRect(0, 0, 10, 10); }
    else {
      // Shown a few times bigger, so the squares are easy to see.
      const f = Math.max(1, Math.min(12, Math.floor(320 / Math.max(result.canvas.width, result.canvas.height * 2))));
      preview.width = result.canvas.width * f;
      preview.height = result.canvas.height * f;
      g.imageSmoothingEnabled = !(pixel || isPixelFont);
      g.drawImage(result.canvas, 0, 0, preview.width, preview.height);
    }
    note.textContent = isPixelFont && !pixelFontCovers(text.value)
      ? 'The pixel font has English letters, numbers and signs only: other letters show as boxes. Pick a normal font for them.'
      : isPixelFont ? 'Every dot is a square: crisp pixel art.' : pixel ? 'With the pixel pen the letters are made of whole squares.' : '';
  }
  font.addEventListener('change', () => { drawSize(); render(); });
  text.addEventListener('input', render);
  bold.addEventListener('change', render);
  drawSize();
  render();

  const m = openModal({
    title: 'Text',
    className: 'modal-text',
    body: h('div', { class: 'connect-form' },
      text,
      h('div', { class: 'tx-row' }, h('label', { class: 'tx-font' }, h('span', { class: 'field-label', text: 'Font' }), font), boldRow),
      sizeHost,
      h('div', { class: 'tx-row' }, seg('Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], align, v => { align = v; render(); }),
        h('span', { class: 'tx-colour small' }, swatch, 'Colour 1')),
      h('div', { class: 'tx-preview-box' }, preview), note),
    actions: [{ id: 'cancel', label: 'Cancel', kind: 'quiet' }, {
      id: 'place', label: 'Place text', kind: 'primary',
      onClick: close => { if (!result) { toast('Type some text first.'); text.focus(); return; } close('place'); },
    }],
    onOpen: () => { text.focus(); text.select(); },
  });
  return m.result.then(v => {
    prefs.font = font.value; prefs.fontBold = bold.checked; prefs.textAlign = align; prefs.lastText = text.value;
    savePrefs();
    return v === 'place' ? result : null;
  });
}

/* ---------- Effects ---------- */

export const EFFECTS = {
  adjust: { name: 'Hue, saturation and lightness', icon: 'palette', copyLabel: 'new look', done: 'Colours changed.' },
  blur: { name: 'Blur', icon: 'brush', copyLabel: 'blurred', done: 'Blurred.' },
  noise: { name: 'Noise', icon: 'sparkle', copyLabel: 'noise', done: 'Noise added.' },
  pixelate: { name: 'Pixelate', icon: 'grid', copyLabel: 'pixelated', done: 'Pixelated.' },
  outline: { name: 'Outline', icon: 'rect', copyLabel: 'outline', done: 'Outline added.' },
};

/**
 * One effect with its settings and a preview. Resolves with { fn } (change this drawing),
 * { copy: true, image } (make a copy with the effect) or null.
 */
export function effectDialog(kind, { engine, mode, prefs, pixelArt }) {
  const pixel = mode === 'pixel';
  const p = {
    hue: 0, sat: 0, light: 0,
    radius: pixel ? 1 : 4,
    amount: 25, seed: (Math.random() * 1e9) | 0,
    block: pixel ? 2 : 1,
    outlineColor: 'color', where: 'outside', thickness: 1, corners: 'square',
  };
  const fnFor = () => {
    switch (kind) {
      case 'adjust': return pc => adjustData(pc, { hue: p.hue, sat: p.sat / 100, light: p.light / 100 });
      case 'blur': return pc => blurData(pc, { radius: p.radius });
      case 'noise': return pc => noiseData(pc, { amount: p.amount / 100, seed: p.seed });
      case 'pixelate': return pc => pixelateData(pc, { block: p.block });
      case 'outline': {
        const c = hexToRgb(p.outlineColor === 'color2' ? prefs.color2 : prefs.color);
        return pc => outlineData(pc, { color: [c.r, c.g, c.b, 255], where: p.where, thickness: p.thickness, corners: p.corners });
      }
      default: return () => false;
    }
  };

  const controls = [];
  const again = () => schedule();
  if (kind === 'adjust') {
    controls.push(slider('Hue', { name: 'hue', min: -180, max: 180, value: 0, show: v => `${v > 0 ? '+' : ''}${v}°`, onInput: v => { p.hue = v; again(); } }));
    controls.push(slider('Saturation', { name: 'saturation', min: -100, max: 100, value: 0, show: v => `${v > 0 ? '+' : ''}${v}`, onInput: v => { p.sat = v; again(); } }));
    controls.push(slider('Lightness', { name: 'lightness', min: -100, max: 100, value: 0, show: v => `${v > 0 ? '+' : ''}${v}`, onInput: v => { p.light = v; again(); } }));
  } else if (kind === 'blur') {
    controls.push(pixel
      ? slider('Strength', { name: 'radius', min: 1, max: 4, value: p.radius, show: v => `${v} square${v > 1 ? 's' : ''}`, onInput: v => { p.radius = v; again(); } })
      : slider('Strength', { name: 'radius', min: 1, max: 48, value: p.radius, show: v => `${v} px`, onInput: v => { p.radius = v; again(); } }));
  } else if (kind === 'noise') {
    controls.push(slider('Amount', { name: 'amount', min: 1, max: 100, value: p.amount, show: v => `${v}%`, onInput: v => { p.amount = v; again(); } }));
    controls.push(h('button', { type: 'button', class: 'btn btn-small', onclick: () => { p.seed = (Math.random() * 1e9) | 0; again(); } }, 'New pattern'));
  } else if (kind === 'pixelate') {
    controls.push(slider('Block size', {
      name: 'block', min: pixel ? 2 : 1, max: 16, value: p.block, onInput: v => { p.block = v; again(); },
      show: v => (v === 1 ? 'the squares' : `${v} squares`),
    }));
  } else if (kind === 'outline') {
    const sw = c => h('span', { class: 'tx-swatch', style: { '--c': c } });
    controls.push(field('Colour', seg('Outline colour', [['color', [sw(prefs.color), 'Colour 1']], ['color2', [sw(prefs.color2), 'Colour 2']]], p.outlineColor, v => { p.outlineColor = v; again(); })));
    controls.push(field('Where', seg('Where', [['outside', 'Outside'], ['inside', 'Inside']], p.where, v => { p.where = v; again(); })));
    controls.push(pixel
      ? slider('Thickness', { name: 'thickness', min: 1, max: 8, value: 1, show: v => `${v} square${v > 1 ? 's' : ''}`, onInput: v => { p.thickness = v; again(); } })
      : slider('Thickness', { name: 'thickness', min: 1, max: 32, value: 1, show: v => `${v} px`, onInput: v => { p.thickness = v; again(); } }));
    controls.push(field('Corners', seg('Corners', [['square', 'Square'], ['round', 'Round']], p.corners, v => { p.corners = v; again(); })));
  }

  // The preview: at most 300 pixels across, sharp for pixel art.
  const f = Math.min(1, 300 / Math.max(engine.W, engine.H));
  const preview = h('canvas', { class: `fx-preview${pixelArt || pixel ? ' pixelated' : ''}`, width: Math.max(1, Math.round(engine.W * f)), height: Math.max(1, Math.round(engine.H * f)) });
  const full = Object.assign(document.createElement('canvas'), { width: engine.W, height: engine.H });
  let image = null, timer = 0;
  function draw() {
    timer = 0;
    image = engine.previewEffect(fnFor(), mode);
    const fg = full.getContext('2d');
    fg.clearRect(0, 0, full.width, full.height);
    if (image) fg.putImageData(image, 0, 0); else fg.drawImage(engine.canvas, 0, 0);
    const g = preview.getContext('2d');
    g.clearRect(0, 0, preview.width, preview.height);
    g.imageSmoothingEnabled = !(pixelArt || pixel);
    g.imageSmoothingQuality = 'high';
    g.drawImage(full, 0, 0, preview.width, preview.height);
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(draw, 90); }
  draw();

  const where = engine.hasSelection ? 'Only inside the selection. ' : '';
  const how = kind === 'adjust' ? '' : pixel ? 'Works in whole squares (pixel pen).' : 'Works on the fine pixels (free pen).';
  const m = openModal({
    title: EFFECTS[kind].name,
    className: 'modal-wide modal-fx',
    body: h('div', { class: 'fx-layout' },
      h('div', { class: 'fx-controls' }, controls, (where || how) ? h('p', { class: 'muted small', text: `${where}${how}` }) : null),
      h('div', { class: 'fx-side' }, preview)),
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'copy', label: 'Make a copy', onClick: close => { if (timer) draw(); if (!image) { toast('Nothing changes yet: move a slider first.'); return; } close('copy'); } },
      { id: 'apply', label: 'Change this drawing', kind: 'primary', onClick: close => close('apply') },
    ],
  });
  return m.result.then(v => {
    clearTimeout(timer);
    if (v === 'apply') return { fn: fnFor() };
    if (v === 'copy') return { copy: true, image };
    return null;
  });
}
