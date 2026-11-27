// The drawing editor (#/ideas/draw/<id>): full screen, one picture, pixel pen and free pen.
//
// Moving around: one finger (or the mouse) draws; two fingers move and zoom; the mouse wheel
// zooms; the middle or right mouse button (or holding Space) moves the picture.
// Every finished stroke is saved on this device a moment later (like the other editors).

import { h, clear } from '../core/util.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { choiceDialog, errorDialog, toast } from '../ui/dialogs.js';
import { openPopup, closePopup } from '../wiki/popup.js';
import { createEngine, swapData, grayscaleData } from './engine.js';
import { colorPicker, palettePanel, pickColorDialog, swapColorsDialog, currentPaletteColors } from './colors.js';
import { drawingFile, storableDrawing, normHex, rgbToHex, removeDrawing } from './model.js';
import { detailsDialog, exportDialog, duplicateDrawing, confirmDeleteDrawing, copyWithPicture } from './gallery.js';

const APP_TITLE = "Batataman's Reimagined";
const PREFS = 'brr.draw';
const SAVE_AFTER = 900;
const ZOOM_MAX = 16;

export const TOOLS = [
  { id: 'pen', label: 'Pen', key: 'b' },
  { id: 'eraser', label: 'Eraser', key: 'e' },
  { id: 'fill', label: 'Fill', key: 'g' },
  { id: 'picker', label: 'Pick a colour', key: 'i' },
  { id: 'line', label: 'Line', key: 'l' },
  { id: 'rect', label: 'Rectangle', key: 'r' },
  { id: 'ellipse', label: 'Ellipse', key: 'o' },
];
const toolIcon = (id, mode) => (id === 'pen' ? (mode === 'pixel' ? 'pencil' : 'brush') : id === 'picker' ? 'dropper' : id === 'fill' ? 'bucket' : id);
const MIRRORS = { none: 'Off', x: 'Left and right', y: 'Top and bottom', xy: 'All four corners' };

function loadPrefs() {
  const p = { tool: 'pen', pixelSize: 1, freeSize: null, opacity: 1, soft: false, filled: false, fillAll: false, pixelPerfect: true, color: '#000000', recent: [] };
  try { Object.assign(p, JSON.parse(localStorage.getItem(PREFS) || '{}')); } catch { /* ignore */ }
  if (!TOOLS.some(t => t.id === p.tool)) p.tool = 'pen';
  if (!normHex(p.color)) p.color = '#000000';
  if (!Array.isArray(p.recent)) p.recent = [];
  return p;
}

export function drawingEditorView(el, ctx, id) {
  const { model, drawings, ui } = ctx;
  const d = drawings.get(id);
  if (!d) {
    clear(el, h('div', { class: 'notice' }, h('p', { text: "This drawing doesn't exist (anymore)." }),
      h('a', { class: 'btn btn-small', href: '#/ideas/d/all' }, 'All drawings')));
    return null;
  }
  let rec = d.data;
  document.title = `${rec.name} · Drawings · ${APP_TITLE}`;
  const prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* storage blocked */ } };

  const engine = createEngine({ width: rec.width, height: rec.height, scale: rec.scale });
  const { W, H } = engine;
  const fineMax = Math.max(W, H);
  const freeMax = Math.max(8, Math.round(fineMax / 4));
  if (!prefs.freeSize) prefs.freeSize = Math.max(2, Math.round(fineMax / 90));
  const st = {
    mode: rec.kind === 'free' ? 'free' : 'pixel',
    grid: rec.kind !== 'free',
    tiles: false,
    mirror: 'none',
    prevTool: 'pen',
  };

  /* ---------- Saving ---------- */

  let saveTimer = null, saving = null, unsaved = false, closed = false;
  const statusEl = h('span', { class: 'dr-status muted small', role: 'status' });
  async function save() {
    clearTimeout(saveTimer);
    if (!unsaved) return;
    if (engine.drawing) { saveTimer = setTimeout(save, 300); return; }
    unsaved = false;
    statusEl.textContent = 'Saving…';
    saving = (async () => {
      const blob = await engine.toBlob();
      await store.putFile(drawingFile(id), blob, { source: 'draw' });
      await store.put('drawings', id, storableDrawing(rec), { source: 'draw' });
    })();
    try { await saving; if (!closed) statusEl.textContent = 'Saved on this device'; }
    catch (err) { unsaved = true; statusEl.textContent = 'Not saved'; errorDialog(err, "The drawing couldn't be saved"); }
    finally { saving = null; }
  }
  const flush = async () => { await saving; await save(); };
  engine.onChange = () => {
    unsaved = true;
    statusEl.textContent = 'Saving soon…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_AFTER);
    drawUndo();
    tilesSoon();
  };
  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);

  /* ---------- The stage: picture, mirror tiles, grid ---------- */

  const pic = engine.canvas;
  pic.className = 'dr-pic';
  pic.style.width = `${W}px`;
  pic.style.height = `${H}px`;
  pic.style.setProperty('--checker', `${rec.kind === 'pixel' && rec.scale >= 8 ? rec.scale : 16}px`);
  // Tiles: the picture repeated around itself, at a lower detail (just to see the edges meet).
  const t = Math.max(1, Math.floor(256 / Math.max(rec.width, rec.height)));
  const tiles = h('canvas', { class: `dr-tiles${rec.kind === 'pixel' ? ' pixelated' : ''}`, width: rec.width * t * 3, height: rec.height * t * 3, hidden: true });
  Object.assign(tiles.style, { left: `${-W}px`, top: `${-H}px`, width: `${W * 3}px`, height: `${H * 3}px` });
  tiles.style.setProperty('--checker', pic.style.getPropertyValue('--checker'));
  const world = h('div', { class: 'dr-world' }, tiles, pic);
  const overlay = h('canvas', { class: 'dr-overlay', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'dr-stage', role: 'application', 'aria-label': `Drawing: ${rec.name}` }, world, overlay);

  let tilesTimer = null;
  function drawTiles() {
    tilesTimer = null;
    if (!st.tiles) return;
    const g = tiles.getContext('2d');
    g.imageSmoothingEnabled = rec.kind !== 'pixel';
    g.clearRect(0, 0, tiles.width, tiles.height);
    const tw = tiles.width / 3, th = tiles.height / 3;
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (x !== 1 || y !== 1) g.drawImage(pic, x * tw, y * th, tw, th);
  }
  function tilesSoon() { if (st.tiles && !tilesTimer) tilesTimer = setTimeout(drawTiles, 120); }

  /* View: zoom (screen pixels per fine pixel) and position */
  let view = { k: 1, tx: 0, ty: 0 };
  let fitK = 1;
  const applyView = () => {
    world.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`;
    pic.classList.toggle('pixelated', view.k >= 1 || rec.kind === 'pixel');
    zoomText.textContent = `${Math.round(view.k * 100)}%`;
    drawOverlay();
  };
  function fit() {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const n = st.tiles ? 3 : 1;
    fitK = Math.min((r.width - 24) / (W * n), (r.height - 24) / (H * n));
    view = { k: fitK, tx: (r.width - W * fitK) / 2, ty: (r.height - H * fitK) / 2 };
    applyView();
  }
  function zoomAt(f, cx, cy) {
    const k = Math.max(Math.min(fitK, 1) * 0.25, Math.min(ZOOM_MAX, view.k * f));
    view = { k, tx: cx - ((cx - view.tx) * k) / view.k, ty: cy - ((cy - view.ty) * k) / view.k };
    applyView();
  }
  const zoomMiddle = f => { const r = stage.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); };
  const local = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const toFine = q => ({ x: (q.x - view.tx) / view.k, y: (q.y - view.ty) / view.k });

  /* Overlay: grid, edges, mirror lines and the brush outline (screen pixels, sharp at any zoom) */
  let hover = null;
  function drawOverlay() {
    const r = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), hh = Math.round(r.height * dpr);
    if (overlay.width !== w || overlay.height !== hh) { overlay.width = w; overlay.height = hh; }
    const g = overlay.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const x0 = view.tx, y0 = view.ty, x1 = view.tx + W * view.k, y1 = view.ty + H * view.k;
    const cell = rec.scale * view.k;
    if (st.grid && cell >= 5) {
      g.beginPath();
      const fromX = Math.max(0, Math.floor(-x0 / cell)), toX = Math.min(rec.width, Math.ceil((r.width - x0) / cell));
      const fromY = Math.max(0, Math.floor(-y0 / cell)), toY = Math.min(rec.height, Math.ceil((r.height - y0) / cell));
      for (let i = fromX; i <= toX; i++) { const x = Math.round(x0 + i * cell) + 0.5; g.moveTo(x, Math.max(0, y0)); g.lineTo(x, Math.min(r.height, y1)); }
      for (let j = fromY; j <= toY; j++) { const y = Math.round(y0 + j * cell) + 0.5; g.moveTo(Math.max(0, x0), y); g.lineTo(Math.min(r.width, x1), y); }
      g.strokeStyle = 'rgba(120,128,140,0.55)';
      g.lineWidth = 1;
      g.stroke();
    }
    g.strokeStyle = st.tiles ? 'rgba(43,179,192,0.9)' : 'rgba(120,128,140,0.8)';
    g.lineWidth = 1;
    g.strokeRect(Math.round(x0) - 0.5, Math.round(y0) - 0.5, Math.round(x1 - x0) + 1, Math.round(y1 - y0) + 1);
    if (st.mirror !== 'none') {
      const accent = getComputedStyle(stage).getPropertyValue('--accent').trim() || '#2bb3c0';
      g.save();
      g.setLineDash([6, 5]);
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.beginPath();
      if (st.mirror === 'x' || st.mirror === 'xy') { const x = (x0 + x1) / 2; g.moveTo(x, y0); g.lineTo(x, y1); }
      if (st.mirror === 'y' || st.mirror === 'xy') { const y = (y0 + y1) / 2; g.moveTo(x0, y); g.lineTo(x1, y); }
      g.stroke();
      g.restore();
    }
    if (hover && !gesture && (prefs.tool === 'pen' || prefs.tool === 'eraser' || ['line', 'rect', 'ellipse'].includes(prefs.tool))) {
      g.save();
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.shadowColor = 'rgba(0,0,0,0.9)';
      g.shadowBlur = 2;
      if (st.mode === 'pixel') {
        const c = engine.cellOf(toFine(hover));
        const n = prefs.pixelSize, a = Math.floor((n - 1) / 2);
        g.strokeRect(Math.round(x0 + (c.x - a) * cell) + 0.5, Math.round(y0 + (c.y - a) * cell) + 0.5, Math.round(n * cell) - 1, Math.round(n * cell) - 1);
      } else {
        g.beginPath();
        g.arc(hover.x, hover.y, Math.max(1.5, (prefs.freeSize / 2) * view.k), 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
    }
  }

  /* ---------- Drawing with the pointer ---------- */

  const pointers = new Map();
  let gesture = null, raf = 0, spaceDown = false;

  const strokeOptions = () => ({
    tool: prefs.tool, mode: st.mode, color: prefs.color, opacity: prefs.opacity,
    size: st.mode === 'pixel' ? prefs.pixelSize : prefs.freeSize,
    soft: prefs.soft, filled: prefs.filled, fillAll: prefs.fillAll,
    pixelPerfect: prefs.tool === 'pen' && prefs.pixelPerfect, symmetry: st.mirror,
  });
  function run() {
    raf = 0;
    if (gesture?.kind !== 'draw') return;
    for (const p of gesture.queue.splice(0)) engine.move(p, { constrain: gesture.constrain });
    engine.show();
    tilesSoon();
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };

  function pickAt(p) {
    const c = engine.pick(p, st.mode);
    if (!c || !c.a) { toast('Nothing to pick up there (it’s see-through).'); return; }
    setColor(rgbToHex(c));
    if (prefs.tool === 'picker') setTool(st.prevTool || 'pen');
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    gesture = { kind: 'pinch', d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: { ...view } };
  }
  function movePinch() {
    const [a, b] = [...pointers.values()];
    const g = gesture;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const k = Math.max(Math.min(fitK, 1) * 0.25, Math.min(ZOOM_MAX, g.view.k * (Math.hypot(b.x - a.x, b.y - a.y) / g.d0)));
    const wx = (g.m0.x - g.view.tx) / g.view.k, wy = (g.m0.y - g.view.ty) / g.view.k;
    view = { k, tx: m.x - wx * k, ty: m.y - wy * k };
    applyView();
  }

  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    e.preventDefault();
    stage.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, local(e));
    closePopup();
    if (pointers.size === 2 && e.pointerType === 'touch') {
      if (gesture?.kind === 'draw') {
        // A second finger right away means move/zoom, not draw; later it's a resting hand.
        if (performance.now() - gesture.t0 > 350) return;
        engine.cancel();
      }
      startPinch();
      return;
    }
    if (pointers.size > 1) return;
    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || spaceDown)) {
      gesture = { kind: 'pan', id: e.pointerId, start: local(e), view: { ...view } };
      stage.classList.add('is-panning');
      return;
    }
    const p = toFine(local(e));
    if (prefs.tool === 'picker' || (e.altKey && e.pointerType === 'mouse')) { pickAt(p); gesture = { kind: 'done', id: e.pointerId }; return; }
    if (prefs.tool !== 'eraser') remember(prefs.color);
    const started = engine.begin(strokeOptions(), p);
    gesture = started ? { kind: 'draw', id: e.pointerId, t0: performance.now(), queue: [], constrain: e.shiftKey } : { kind: 'done', id: e.pointerId };
    drawOverlay();
  });
  stage.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') { hover = local(e); if (!gesture) drawOverlay(); }
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (gesture?.kind === 'pinch' && pointers.size >= 2) { movePinch(); return; }
    if (gesture?.kind === 'pan' && e.pointerId === gesture.id) {
      const q = local(e);
      view = { ...gesture.view, tx: gesture.view.tx + q.x - gesture.start.x, ty: gesture.view.ty + q.y - gesture.start.y };
      applyView();
      return;
    }
    if (gesture?.kind === 'draw' && e.pointerId === gesture.id) {
      const evs = e.getCoalescedEvents?.() || [];
      for (const ev of evs.length ? evs : [e]) gesture.queue.push(toFine(local(ev)));
      gesture.constrain = e.shiftKey;
      schedule();
    }
  });
  const up = e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (gesture?.kind === 'draw' && e.pointerId === gesture.id) {
      cancelAnimationFrame(raf); raf = 0;
      for (const p of gesture.queue.splice(0)) engine.move(p, { constrain: gesture.constrain });
      if (e.type === 'pointercancel') engine.cancel(); else engine.end();
      gesture = null;
      tilesSoon();
    } else if (gesture?.kind === 'pinch') {
      if (pointers.size < 2) gesture = pointers.size ? { kind: 'done' } : null;
    } else if (!pointers.size) {
      gesture = null;
    }
    if (!pointers.size) { gesture = null; stage.classList.remove('is-panning'); }
    drawOverlay();
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { hover = null; drawOverlay(); } });
  stage.addEventListener('contextmenu', e => e.preventDefault());
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const q = local(e);
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), q.x, q.y);
  }, { passive: false });

  /* ---------- Tools, options and colours ---------- */

  function setTool(id) {
    if (id === 'picker' && prefs.tool !== 'picker') st.prevTool = prefs.tool;
    prefs.tool = id;
    savePrefs();
    drawTools();
    drawOptions();
    stage.dataset.tool = id;
    drawOverlay();
  }
  function setMode(m) {
    st.mode = m;
    drawTools();
    drawOptions();
    drawOverlay();
  }
  function setColor(hex) {
    hex = normHex(hex);
    if (!hex) return;
    prefs.color = hex;
    savePrefs();
    picker?.set(hex);
    drawColors();
  }
  function remember(hex) {
    prefs.recent = [hex, ...prefs.recent.filter(c => c !== hex)].slice(0, 12);
    savePrefs();
    drawRecent();
  }

  const toolsEl = h('div', { class: 'dr-tools', role: 'toolbar', 'aria-label': 'Tools' });
  function drawTools() {
    clear(toolsEl, TOOLS.map(tl => h('button', {
      type: 'button', class: 'dr-tool', 'aria-pressed': String(prefs.tool === tl.id), dataset: { tool: tl.id },
      'aria-label': tl.id === 'pen' ? (st.mode === 'pixel' ? 'Pixel pen' : 'Free pen') : tl.label,
      title: `${tl.id === 'pen' ? (st.mode === 'pixel' ? 'Pixel pen' : 'Free pen') : tl.label} (${tl.key.toUpperCase()})`,
      onclick: () => setTool(tl.id),
    }, icon(toolIcon(tl.id, st.mode), { size: 22 }))));
  }

  const seg = (name, options, value, onPick) => h('div', { class: 'seg dr-seg', role: 'group', 'aria-label': name },
    options.map(([v, label, ic]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': String(value === v), dataset: { value: v },
      onclick: () => onPick(v),
    }, ic ? icon(ic, { size: 14 }) : null, label)));
  const sizeToSlider = s => Math.round((Math.log(s) / Math.log(freeMax)) * 100);
  const sliderToSize = v => Math.max(1, Math.round(Math.exp((v / 100) * Math.log(freeMax))));
  function slider(label, { min, max, value, show, onInput, name }) {
    const out = h('span', { class: 'dr-slider-value', text: show(value) });
    const input = h('input', { type: 'range', min, max, step: 1, value, name, 'aria-label': label });
    input.addEventListener('input', () => { out.textContent = show(+input.value); onInput(+input.value); });
    return h('label', { class: 'dr-slider' }, h('span', { class: 'dr-slider-label', text: label }), input, out);
  }

  const optsEl = h('div', { class: 'dr-opts' });
  function drawOptions() {
    const tl = prefs.tool;
    const parts = [seg('Pen', [['pixel', 'Pixel', 'pencil'], ['free', 'Free', 'brush']], st.mode, setMode)];
    if (tl === 'picker') {
      parts.push(h('span', { class: 'muted small dr-hint', text: 'Tap the drawing to pick up a colour.' }));
    } else {
      if (tl !== 'fill') {
        parts.push(st.mode === 'pixel'
          ? slider('Size', { name: 'size', min: 1, max: 16, value: prefs.pixelSize, show: v => `${v}`, onInput: v => { prefs.pixelSize = v; savePrefs(); } })
          : slider('Size', { name: 'size', min: 0, max: 100, value: sizeToSlider(prefs.freeSize), show: v => `${sliderToSize(v)}`, onInput: v => { prefs.freeSize = sliderToSize(v); savePrefs(); } }));
      }
      if (tl !== 'eraser') {
        parts.push(slider('Opacity', { name: 'opacity', min: 5, max: 100, value: Math.round(prefs.opacity * 100), show: v => `${v}%`, onInput: v => { prefs.opacity = v / 100; savePrefs(); } }));
      }
      if ((tl === 'pen' || tl === 'eraser') && st.mode === 'free') parts.push(seg('Brush', [[false, 'Hard'], [true, 'Soft']], prefs.soft, v => { prefs.soft = v; savePrefs(); drawOptions(); }));
      if (tl === 'pen' && st.mode === 'pixel') {
        parts.push(h('label', { class: 'dr-check', title: 'Keeps lines one square thin: no extra squares in the corners' },
          h('input', { type: 'checkbox', name: 'pixelPerfect', checked: prefs.pixelPerfect, onchange: e => { prefs.pixelPerfect = e.target.checked; savePrefs(); } }), 'Pixel-perfect'));
      }
      if (tl === 'rect' || tl === 'ellipse') parts.push(seg('Shape', [[false, 'Outline'], [true, 'Filled']], prefs.filled, v => { prefs.filled = v; savePrefs(); drawOptions(); }));
      if (tl === 'fill') parts.push(seg('Fill', [[false, 'Connected'], [true, 'Everywhere']], prefs.fillAll, v => { prefs.fillAll = v; savePrefs(); drawOptions(); }));
    }
    clear(optsEl, parts);
  }

  /* Colours: a side panel on a PC, a row with a colour button on a phone */
  const drawingColors = () => engine.paletteColors();
  let picker = null, pal = null;
  const recentPC = h('div', { class: 'dr-recent', 'aria-label': 'Recent colours' });
  const side = h('aside', { class: 'dr-side' });
  const colorsRow = h('div', { class: 'dr-colors' });
  const swatch = (c, label) => h('button', { type: 'button', class: 'pal-sw', style: { '--c': c }, title: c, 'aria-label': `${label} ${c}`, dataset: { color: c }, onclick: () => setColor(c) });
  function drawRecent() {
    clear(recentPC, prefs.recent.length ? prefs.recent.map(c => swatch(c, 'Recent colour')) : h('span', { class: 'muted small', text: 'Colours you draw with show up here.' }));
    drawColors();
  }
  let rowPalette = [];
  async function loadRowPalette() { rowPalette = await currentPaletteColors(); drawColors(); }
  function drawColors() {
    const current = h('button', {
      type: 'button', class: 'dr-current-btn', style: { '--c': prefs.color }, 'aria-label': `Colour ${prefs.color}: change it`, title: 'Change the colour',
      onclick: async () => {
        const v = await pickColorDialog({ title: 'Colour', value: prefs.color, drawingColors });
        if (v && v !== 'keep') setColor(v);
        loadRowPalette();
      },
    });
    clear(colorsRow, current,
      h('div', { class: 'dr-colors-scroll' },
        prefs.recent.filter(c => c !== prefs.color).slice(0, 6).map(c => swatch(c, 'Recent colour')),
        rowPalette.length ? h('span', { class: 'dr-colors-gap', 'aria-hidden': 'true' }) : null,
        rowPalette.map(c => swatch(c, 'Palette colour'))));
  }
  function buildSide() {
    picker = colorPicker({ value: prefs.color, onInput: v => { prefs.color = v; savePrefs(); drawColors(); } });
    pal = palettePanel({ getColor: () => prefs.color, onPick: setColor, drawingColors });
    clear(side,
      h('h2', { class: 'dr-side-title', text: 'Colour' }), picker.el,
      h('h2', { class: 'dr-side-title', text: 'Recent' }), recentPC,
      h('h2', { class: 'dr-side-title', text: 'Palette' }), pal.el);
  }
  const offPal = store.on(dd => { if (dd?.type === 'sync' || dd?.collection === 'palettes') loadRowPalette(); });

  /* ---------- Top bar ---------- */

  const zoomText = h('span', { class: 'dr-zoom muted small', text: '100%' });
  const undoBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Undo', title: 'Undo (Ctrl+Z)', onclick: () => engine.undo() }, icon('undo', { size: 20 }));
  const redoBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Redo', title: 'Redo (Ctrl+Y)', onclick: () => engine.redo() }, icon('redo', { size: 20 }));
  function drawUndo() { undoBtn.disabled = !engine.canUndo(); redoBtn.disabled = !engine.canRedo(); }
  const toggle = (label, ic, on, fn, cls = '') => h('button', { type: 'button', class: `icon-btn dr-toggle ${cls}`, 'aria-label': label, title: label, 'aria-pressed': String(!!on), onclick: fn }, icon(ic, { size: 20 }));
  const nameBtn = h('button', { type: 'button', class: 'dr-name', title: 'Name, section and idea', onclick: () => details() }, rec.name);
  const topEl = h('div', { class: 'dr-top' });
  function drawTop() {
    const more = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'More', title: 'Swap colours, grayscale, export…', onclick: () => menu(more) }, '⋯');
    const mirrorBtn = h('button', {
      type: 'button', class: 'icon-btn dr-toggle dr-pc', 'aria-label': `Mirror drawing: ${MIRRORS[st.mirror]}`, title: `Mirror drawing: ${MIRRORS[st.mirror]}`,
      'aria-pressed': String(st.mirror !== 'none'), onclick: () => mirrorMenu(mirrorBtn),
    }, icon('mirror', { size: 20 }));
    clear(topEl,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', title: 'Back to the drawings', onclick: leave }, icon('back', { size: 20 })),
      h('div', { class: 'dr-title' }, nameBtn, statusEl),
      h('div', { class: 'dr-top-tools' },
        undoBtn, redoBtn,
        h('span', { class: 'dr-sep dr-pc' }),
        h('button', { type: 'button', class: 'icon-btn dr-pc', 'aria-label': 'Zoom out', title: 'Zoom out', onclick: () => zoomMiddle(1 / 1.4) }, '−'),
        zoomText,
        h('button', { type: 'button', class: 'icon-btn dr-pc', 'aria-label': 'Zoom in', title: 'Zoom in', onclick: () => zoomMiddle(1.4) }, '+'),
        h('button', { type: 'button', class: 'icon-btn dr-pc', 'aria-label': 'Fit', title: 'Fit the drawing on screen (F)', onclick: fit }, icon('fit', { size: 20 })),
        h('span', { class: 'dr-sep dr-pc' }),
        toggle('Grid', 'grid', st.grid, () => toggleGrid(), 'dr-pc'),
        toggle('Tiles: see it repeated, for blocks', 'tiles', st.tiles, () => toggleTiles(), 'dr-pc'),
        mirrorBtn,
        more));
    drawUndo();
  }
  function toggleGrid() { st.grid = !st.grid; drawTop(); drawOverlay(); }
  function toggleTiles() {
    st.tiles = !st.tiles;
    tiles.hidden = !st.tiles;
    if (st.tiles) drawTiles();
    drawTop();
    fit();
  }
  function setMirror(m) { st.mirror = m; drawTop(); drawOverlay(); }
  function mirrorMenu(anchor) {
    openPopup({
      rect: anchor.getBoundingClientRect(), title: 'Mirror drawing',
      items: Object.entries(MIRRORS).map(([k, label]) => ({ label, hint: st.mirror === k ? '✓' : '', icon: k === 'none' ? 'close' : 'mirror', onPick: () => setMirror(k) })),
    });
  }
  function menu(anchor) {
    openPopup({
      rect: anchor.getBoundingClientRect(), title: rec.name,
      items: [
        { label: 'Fit on screen', icon: 'fit', onPick: fit, phone: true },
        { label: st.grid ? 'Hide the grid' : 'Show the grid', icon: 'grid', onPick: toggleGrid, phone: true },
        { label: st.tiles ? 'Stop showing tiles' : 'Tiles (see it repeated)', icon: 'tiles', onPick: toggleTiles, phone: true },
        { label: 'Mirror drawing…', hint: MIRRORS[st.mirror], icon: 'mirror', onPick: () => mirrorMenu(anchor), phone: true },
        { label: 'Swap colours…', icon: 'swap', onPick: swapColors },
        { label: 'Make it grayscale…', icon: 'gray', onPick: grayscale },
        { label: 'Export PNG…', icon: 'download', onPick: () => exportDialog({ name: rec.name, data: rec }, engine) },
        { label: 'Name, section and idea…', icon: 'edit', onPick: details },
        { label: 'Duplicate', icon: 'copy', onPick: async () => { await flush(); duplicateDrawing({ id, data: rec }, ui); } },
        { label: 'Delete this drawing', icon: 'trash', onPick: remove },
      ].filter(it => !it.phone || matchMedia('(max-width: 759px)').matches).map(({ phone, ...it }) => it),
    });
  }

  async function details() {
    const changed = await detailsDialog({ id, data: rec }, model);
    if (!changed) return;
    rec = changed;
    nameBtn.textContent = rec.name;
    document.title = `${rec.name} · Drawings · ${APP_TITLE}`;
  }
  async function swapColors() {
    const r = await swapColorsDialog(engine, { pixel: rec.kind === 'pixel' });
    if (!r) return;
    if (r.copy) {
      await flush();
      await copyWithPicture({ id, data: rec }, ui, engine.canvas, data => swapData(data, r.map, r.similar), 'new colours');
      return;
    }
    engine.swapColors(r.map, r.similar);
    toast('Colours swapped. Undo brings the old ones back.');
  }
  async function grayscale() {
    const how = await choiceDialog({
      title: 'Make it grayscale?',
      body: h('p', { text: 'Every colour becomes the gray of the same brightness, like Minecraft textures that the game tints (grass, leaves).' }),
      choices: [{ id: 'copy', label: 'Make a gray copy' }, { id: 'here', label: 'Change this drawing', kind: 'primary' }],
    });
    if (how === 'here') { if (engine.grayscale()) toast('Grayscale. Undo brings the colours back.'); else toast('It has no colours to change.'); }
    if (how === 'copy') { await flush(); await copyWithPicture({ id, data: rec }, ui, engine.canvas, data => grayscaleData(data), 'gray'); }
  }
  async function remove() {
    if (!(await confirmDeleteDrawing({ id, data: rec }))) return;
    closed = true;
    unsaved = false;
    clearTimeout(saveTimer);
    await saving;
    try { await removeDrawing(id); } catch (err) { errorDialog(err, "The drawing couldn't be deleted"); return; }
    ui.leaveTo(rec.section && model.section(rec.section) ? `d/${rec.section}` : 'd/all');
    toast('Drawing deleted. Push to remove it from GitHub too.');
  }
  function leave() {
    ui.back(rec.section && model.section(rec.section) ? `d/${rec.section}` : 'd/all');
  }

  /* ---------- Keys (PC) ---------- */

  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
  const onKey = e => {
    if (document.querySelector('dialog[open]')) return;
    if (e.type === 'keyup') { if (e.code === 'Space') { spaceDown = false; stage.classList.remove('is-space'); } return; }
    if (typing()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) engine.redo(); else engine.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); engine.redo(); return; }
    if (mod || e.altKey) return;
    if (e.code === 'Space') { spaceDown = true; stage.classList.add('is-space'); e.preventDefault(); return; }
    if (e.key === 'Escape' && gesture?.kind === 'draw') { engine.cancel(); gesture = null; return; }
    const tl = TOOLS.find(x => x.key === e.key.toLowerCase());
    if (tl) { setTool(tl.id); return; }
    if (e.key.toLowerCase() === 'p') { setMode(st.mode === 'pixel' ? 'free' : 'pixel'); return; }
    if (e.key.toLowerCase() === 'f') { fit(); return; }
    if (e.key === '[' || e.key === ']') {
      const up = e.key === ']';
      if (st.mode === 'pixel') prefs.pixelSize = Math.max(1, Math.min(16, prefs.pixelSize + (up ? 1 : -1)));
      else prefs.freeSize = Math.max(1, Math.min(freeMax, Math.round(prefs.freeSize * (up ? 1.25 : 0.8)) + (up ? 1 : 0)));
      savePrefs(); drawOptions(); drawOverlay();
    }
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKey);

  /* ---------- Put it together ---------- */

  const root = h('div', { class: 'dr' }, topEl, toolsEl, optsEl, stage, side, colorsRow);
  clear(el, root);
  document.body.classList.add('dr-open');
  drawTop();
  drawTools();
  drawOptions();
  buildSide();
  drawRecent();
  loadRowPalette();
  stage.dataset.tool = prefs.tool;

  const ro = new ResizeObserver(() => { if (!fitted) { fitted = true; fit(); } else drawOverlay(); });
  let fitted = false;
  ro.observe(stage);
  engine.load(d.file?.blob).then(() => { fit(); fitted = true; drawUndo(); if (st.tiles) drawTiles(); })
    .catch(err => errorDialog(err, "The picture couldn't be opened"));

  return async () => {
    closed = true;
    ro.disconnect();
    cancelAnimationFrame(raf);
    clearTimeout(tilesTimer);
    if (engine.drawing) engine.end();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup', onKey);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flush);
    document.body.classList.remove('dr-open');
    closePopup();
    pal?.cleanup();
    offPal();
    if (unsaved || saving) { closed = false; await flush(); closed = true; }
  };
}
