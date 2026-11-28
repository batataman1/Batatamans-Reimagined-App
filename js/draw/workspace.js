// The drawing workspace (#/ideas/draw/<id>).
//
// Every drawing (or reference picture) you open stays open as a tab at the top, like Chrome's
// tabs, until you close it with its ×, also after going back to the gallery or to another part
// of the app (open drawings keep their Undo). Long-press a tab (or drag it with the mouse) to
// move it along the row, or drag it down into the picture area to show two tabs at once (split
// screen). Drag the border between them to change the sizes; its handle swaps the sides, turns
// the split, or closes it. Tools, options and colours are shared: pick a colour in one half and
// draw with it in the other.
//
// Part 2e: Select (rectangle, free shape, colour area) with Move, Copy, Cut, Paste, Flip and
// Turn; Polygon, Gradient, Effect brush, Text and Stamp tools; a second colour; the Effects menu.
// Each half of a split screen has its own selection; copy in one half and paste in the other.

import { h, clear } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { choiceDialog, confirmDialog, errorDialog, toast } from '../ui/dialogs.js';
import { openPopup, closePopup } from '../wiki/popup.js';
import { getIdeas } from '../ideas/model.js';
import { swapData, grayscaleData } from './engine.js';
import { createDoc } from './doc.js';
import { colorPicker, palettePanel, pickColorDialog, swapColorsDialog, currentPaletteColors } from './colors.js';
import { getDrawings, normHex, hexToRgb, removeDrawing, importReference } from './model.js';
import { detailsDialog, exportDialog, duplicateDrawing, confirmDeleteDrawing, copyWithPicture, copyWithImage, newDrawingDialog, thumbCanvas } from './gallery.js';
import { pieceFromCanvas, scalePiece, flipPiece, turnPiece, tintPiece, pieceCells, cellsToPiece } from './select.js';
import { BRUSH_EFFECTS } from './effects.js';
import { getStamps, stampsDialog, saveStampDialog, stampThumb } from './stamps.js';
import { textDialog, effectDialog, EFFECTS } from './tooldialogs.js';
import { drawingToWikiDialog } from './wikipic.js';
import { store } from '../core/store.js';

const APP_TITLE = "Batataman's Reimagined";
const PREFS = 'brr.draw';
const TABS = 'brr.draw.tabs';

// Keys go by the key's place on the keyboard (e.code), so they work with any keyboard layout.
export const TOOLS = [
  { id: 'pen', label: 'Pen', key: 'B', code: 'KeyB' },
  { id: 'eraser', label: 'Eraser', key: 'E', code: 'KeyE' },
  { id: 'fill', label: 'Fill', key: 'G', code: 'KeyG' },
  { id: 'picker', label: 'Pick a colour', key: 'I', code: 'KeyI' },
  { id: 'select', label: 'Select', key: 'M', code: 'KeyM' },
  { id: 'line', label: 'Line', key: 'L', code: 'KeyL' },
  { id: 'rect', label: 'Rectangle', key: 'R', code: 'KeyR' },
  { id: 'ellipse', label: 'Ellipse', key: 'O', code: 'KeyO' },
  { id: 'polygon', label: 'Polygon', key: 'Y', code: 'KeyY' },
  { id: 'gradient', label: 'Gradient', key: 'D', code: 'KeyD' },
  { id: 'effect', label: 'Effect brush', key: 'U', code: 'KeyU' },
  { id: 'text', label: 'Text', key: 'T', code: 'KeyT' },
  { id: 'stamp', label: 'Stamp', key: 'S', code: 'KeyS' },
];
// On a phone some tools share one button (the options row switches between them).
const GROUPS = {
  shapes: { label: 'Shapes', tools: ['line', 'rect', 'ellipse', 'polygon'] },
  paint: { label: 'Gradient and effects', tools: ['gradient', 'effect'] },
  add: { label: 'Text and stamps', tools: ['text', 'stamp'] },
};
const groupOf = id => Object.keys(GROUPS).find(g => GROUPS[g].tools.includes(id)) || null;
const PHONE_BAR = ['pen', 'eraser', 'fill', 'picker', 'select', 'shapes', 'paint', 'add'];
const SELECT_ICON = { rect: 'select', lasso: 'lasso', wand: 'wand' };
const toolIcon = (id, mode, prefs) => (id === 'pen' ? (mode === 'pixel' ? 'pencil' : 'brush') : id === 'picker' ? 'dropper' : id === 'fill' ? 'bucket'
  : id === 'select' ? SELECT_ICON[prefs.selShape] || 'select' : id === 'effect' ? 'fxbrush' : id);
const MIRRORS = { none: 'Off', x: 'Left and right', y: 'Top and bottom', xy: 'All four corners' };
const isPhone = () => matchMedia('(max-width: 759px)').matches;
const label = id => TOOLS.find(t => t.id === id)?.label || id;

function loadPrefs() {
  const p = {
    tool: 'pen', pixelSize: 1, freeSize: 11, opacity: 1, soft: false, filled: false, fillAll: false,
    pixelPerfect: true, eraseTap: false, eraseAll: false, color: '#000000', color2: '#ffffff', recent: [],
    groupLast: { shapes: 'line', paint: 'gradient', add: 'text' },
    selShape: 'rect', selOp: 'new', wandAll: false, wandTol: 32,
    gradShape: 'straight', gradTo: 'color2', gradArea: 'area', gradSteps: 4, gradDither: 'ordered',
    fx: 'lighten', fxStrength: 0.3, fxAlongPalette: false, fxDither: 'checker',
    font: 'pixel', pixelDot: 1, fontSize: 8, fontBold: false, textAlign: 'left', lastText: '',
    stamp: 'b-heart', stampSize: 1, stampFlipX: false, stampFlipY: false, stampTurn: 0, stampTint: false,
  };
  try { Object.assign(p, JSON.parse(localStorage.getItem(PREFS) || '{}')); } catch { /* ignore */ }
  if (!TOOLS.some(t => t.id === p.tool)) p.tool = 'pen';
  if (!normHex(p.color)) p.color = '#000000';
  if (!normHex(p.color2)) p.color2 = '#ffffff';
  if (!Array.isArray(p.recent)) p.recent = [];
  if (!(p.freeSize > 0)) p.freeSize = 11;
  if (!p.groupLast || typeof p.groupLast !== 'object') p.groupLast = { shapes: 'line', paint: 'gradient', add: 'text' };
  if (!SELECT_ICON[p.selShape]) p.selShape = 'rect';
  if (!['new', 'add', 'subtract'].includes(p.selOp)) p.selOp = 'new';
  if (!BRUSH_EFFECTS[p.fx]) p.fx = 'lighten';
  return p;
}

function loadTabs() {
  const t = { open: [], active: null, split: null };
  try { Object.assign(t, JSON.parse(localStorage.getItem(TABS) || '{}')); } catch { /* ignore */ }
  t.open = Array.isArray(t.open) ? [...new Set(t.open.filter(x => typeof x === 'string' && x))] : [];
  if (!t.open.includes(t.active)) t.active = t.open[0] || null;
  const s = t.split;
  t.split = s && s.a !== s.b && t.open.includes(s.a) && t.open.includes(s.b)
    ? { a: s.a, b: s.b, ratio: Math.max(0.15, Math.min(0.85, Number(s.ratio) || 0.5)), dir: ['row', 'col'].includes(s.dir) ? s.dir : 'auto' }
    : null;
  return t;
}

/** The drawings open as tabs on this device: { open: [ids], active }. */
export const openDrawingTabs = () => loadTabs();

let workspace = null;
/** The screen for #/ideas/draw/<id>. */
export function drawingWorkspaceView(el, ctx, id) {
  workspace ||= createWorkspace();
  return workspace.show(el, ctx, id);
}

function createWorkspace() {
  const prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* storage blocked */ } };
  const tabs = loadTabs();
  const saveTabs = () => { try { localStorage.setItem(TABS, JSON.stringify(tabs)); } catch { /* storage blocked */ } };
  const docs = new Map();
  let ctx = null, mounted = false, prevActive = null, prevTool = 'pen', spaceDown = false;
  /** What Copy and Cut keep, for Paste in any open drawing: { piece, k, pixel, at, from }. */
  let clip = null;

  /* ---------- What's open ---------- */

  const activeDoc = () => docs.get(tabs.active) || null;
  const recOf = id => docs.get(id)?.rec || ctx.drawings.get(id)?.data || null;
  const splitShown = () => !!tabs.split && (tabs.split.a === tabs.active || tabs.split.b === tabs.active);
  const shownIds = () => (splitShown() ? [tabs.split.a, tabs.split.b] : tabs.active ? [tabs.active] : []);
  /** The drawing the colour tools work on: the active one, or the drawing next to a reference. */
  const drawingDoc = () => shownIds().map(id => docs.get(id)).find(d => d && !d.isRef && d.id === tabs.active)
    || shownIds().map(id => docs.get(id)).find(d => d && !d.isRef) || null;
  /** The active drawing (not a reference), or null. */
  const workDoc = () => { const d = activeDoc(); return d && !d.isRef ? d : null; };
  function getDoc(id) {
    let doc = docs.get(id);
    if (!doc) {
      const d = ctx.drawings.get(id);
      if (!d) return null;
      doc = createDoc(d, api);
      docs.set(id, doc);
    }
    return doc;
  }
  async function refresh() {
    const [drawings, model] = await Promise.all([getDrawings(), getIdeas()]);
    ctx = { ...ctx, drawings, model };
  }
  const galleryPath = (id = tabs.active) => {
    const r = id ? recOf(id) : null;
    return r?.section && ctx.model.section(r.section) ? `d/${r.section}` : 'd/all';
  };
  const leave = (path = galleryPath()) => ctx.ui.back(path);

  /** Keep the address on the tab you're looking at (no extra Back step). */
  function syncHash() {
    if (!mounted || !tabs.active) return;
    const target = `#/ideas/draw/${encodeURIComponent(tabs.active)}`;
    if (location.hash === target) return;
    history.replaceState(history.state, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  function activate(id) {
    if (!tabs.open.includes(id)) return;
    if (tabs.active !== id) { prevActive = tabs.active; tabs.active = id; }
    saveTabs();
    layout();
    syncHash();
  }

  async function open(id) {
    if (tabs.active === id && tabs.open.includes(id) && docs.has(id)) { layout(); return; }
    if (!ctx.drawings.get(id)) await refresh();
    if (!ctx.drawings.get(id)) { toast("That drawing doesn't exist (anymore)."); if (!tabs.active) leave('d/all'); else syncHash(); return; }
    if (!tabs.open.includes(id)) tabs.open.push(id);
    activate(id);
  }

  /** Forget a tab without saving it (its drawing is gone). */
  function dropTab(id) {
    docs.get(id)?.destroy({ discard: true });
    docs.delete(id);
    const i = tabs.open.indexOf(id);
    if (i >= 0) tabs.open.splice(i, 1);
    if (tabs.split && (tabs.split.a === id || tabs.split.b === id)) tabs.split = null;
    if (tabs.active === id) tabs.active = tabs.open[i] || tabs.open[i - 1] || null;
  }

  /** Close a tab (its drawing is saved first unless `discard`), then do `after` (e.g. delete it). */
  async function closeTab(id, { discard = false, after = null } = {}) {
    const i = tabs.open.indexOf(id);
    if (i < 0) return;
    const back = galleryPath(id);
    const doc = docs.get(id);
    docs.delete(id);
    tabs.open.splice(i, 1);
    if (tabs.split && (tabs.split.a === id || tabs.split.b === id)) tabs.split = null;
    if (prevActive === id) prevActive = null;
    if (tabs.active === id) tabs.active = tabs.open[i] || tabs.open[i - 1] || null;
    saveTabs();
    if (doc) await doc.destroy({ discard });
    if (after) await after();
    if (!mounted) return;
    if (!tabs.active) { leave(back); return; }
    layout();
    refitShown();
    syncHash();
  }

  /* ---------- Split screen ---------- */

  function splitDir() {
    const d = tabs.split?.dir;
    if (d === 'row' || d === 'col') return d;
    const r = panes.getBoundingClientRect();
    return (r.width || innerWidth) >= (r.height || innerHeight) ? 'row' : 'col';
  }
  const refitShown = () => { for (const id of shownIds()) docs.get(id)?.refit(); };

  /**
   * Show `id` in split screen on side 0 (left/top) or 1 (right/bottom), next to what's on screen
   * now. `focus`: make it the active tab (otherwise you keep working where you were).
   */
  function splitWith(id, side = 1, { focus = false } = {}) {
    if (!tabs.open.includes(id)) return;
    let pair;
    if (splitShown()) {
      pair = [tabs.split.a, tabs.split.b];
      if (pair.includes(id)) { if (pair[side] !== id) pair.reverse(); }
      else pair[side] = id;
    } else {
      const other = tabs.active !== id ? tabs.active : [prevActive, ...tabs.open].find(x => x && x !== id && tabs.open.includes(x));
      if (!other) { toast('Open a second drawing or picture first, then drag its tab down here.'); return; }
      pair = side === 0 ? [id, other] : [other, id];
    }
    tabs.split = { a: pair[0], b: pair[1], ratio: tabs.split?.ratio ?? 0.5, dir: tabs.split?.dir || 'auto' };
    // The two sit together in the tab row.
    tabs.open = tabs.open.filter(x => x !== pair[1]);
    tabs.open.splice(tabs.open.indexOf(pair[0]) + 1, 0, pair[1]);
    if (focus || !pair.includes(tabs.active)) { prevActive = tabs.active; tabs.active = focus ? id : pair[0] === id ? pair[1] : pair[0]; }
    saveTabs();
    layout();
    refitShown();
    syncHash();
  }
  function swapSides() {
    tabs.split = { ...tabs.split, a: tabs.split.b, b: tabs.split.a, ratio: 1 - tabs.split.ratio };
    const [x, y] = [tabs.open.indexOf(tabs.split.a), tabs.open.indexOf(tabs.split.b)];
    if (x > y) { tabs.open[x] = tabs.split.b; tabs.open[y] = tabs.split.a; }
    saveTabs(); layout(); refitShown();
  }
  function turnSplit() {
    tabs.split = { ...tabs.split, dir: splitDir() === 'row' ? 'col' : 'row' };
    saveTabs(); layout(); refitShown();
  }
  function closeSplit() {
    tabs.split = null;
    saveTabs(); layout(); refitShown();
  }
  function splitMenu(anchor) {
    openPopup({
      rect: anchor.getBoundingClientRect(), title: 'Split screen',
      items: [
        { label: 'Swap sides', icon: 'swap', onPick: swapSides },
        { label: splitDir() === 'row' ? 'Top and bottom' : 'Side by side', icon: 'split', onPick: turnSplit },
        { label: 'Close split screen', icon: 'close', onPick: closeSplit },
      ],
    });
  }
  function splitList(anchor) {
    openPopup({
      rect: anchor.getBoundingClientRect(), title: 'Split screen with',
      items: tabs.open.filter(x => x !== tabs.active).map(x => ({
        label: recOf(x)?.name || 'Drawing', icon: recOf(x)?.kind === 'reference' ? 'image' : 'brush', onPick: () => splitWith(x, 1),
      })),
    });
  }

  /** The border between the two halves: drag it; tap its handle for the split screen menu. */
  function divider(dir) {
    const handle = h('button', { type: 'button', class: 'dr-divider-handle', 'aria-label': 'Split screen: swap, turn or close', title: 'Drag to change the sizes. Tap: swap sides, turn, close' });
    const el = h('div', { class: 'dr-divider', role: 'separator', 'aria-orientation': dir === 'row' ? 'vertical' : 'horizontal', title: 'Drag to change the sizes' }, handle);
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      const tapped = e.target.closest('.dr-divider-handle');
      const pr = panes.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      let moved = false;
      const [p1, p2] = panes.querySelectorAll(':scope > .dr-pane');
      const move = ev => {
        if (ev.pointerId !== e.pointerId) return;
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true;
        el.classList.add('dragging');
        const r = dir === 'row' ? (ev.clientX - pr.left) / pr.width : (ev.clientY - pr.top) / pr.height;
        tabs.split.ratio = Math.max(0.15, Math.min(0.85, r));
        p1.style.flex = `${tabs.split.ratio} 1 0`;
        p2.style.flex = `${1 - tabs.split.ratio} 1 0`;
      };
      const up = ev => {
        if (ev.pointerId !== e.pointerId) return;
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        if (moved) saveTabs();
        else if (tapped && ev.type === 'pointerup') splitMenu(handle);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up);
    });
    return el;
  }

  /* ---------- Layout ---------- */

  const tabsEl = h('div', { class: 'dr-tabs', role: 'tablist', 'aria-label': 'Open drawings' });
  tabsEl.addEventListener('contextmenu', e => e.preventDefault());
  const plusBtn = h('button', { type: 'button', class: 'dr-newtab', 'aria-label': 'Open or make a drawing', title: 'Open or make a drawing', onclick: () => plusMenu(plusBtn) }, icon('plus', { size: 16 }));
  const tabbar = h('div', { class: 'dr-tabbar' }, tabsEl, plusBtn);
  const topEl = h('div', { class: 'dr-top' });
  const toolsEl = h('div', { class: 'dr-tools', role: 'toolbar', 'aria-label': 'Tools' });
  const optsEl = h('div', { class: 'dr-opts' });
  const selEl = h('div', { class: 'dr-selbar', role: 'toolbar', 'aria-label': 'Selection', hidden: true });
  const panes = h('div', { class: 'dr-panes' });
  const side = h('aside', { class: 'dr-side' });
  const colorsRow = h('div', { class: 'dr-colors' });
  const dropZones = [h('div', { class: 'dr-drop-zone' }), h('div', { class: 'dr-drop-zone' })];
  const dropEl = h('div', { class: 'dr-drop', hidden: true }, dropZones);
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, class: 'dr-file' });
  const root = h('div', { class: 'dr' }, tabbar, topEl, toolsEl, optsEl, selEl, panes, side, colorsRow, dropEl, fileInput);

  let shownKey = '';
  function layout() {
    if (!mounted) return;
    const shown = shownIds().filter(id => getDoc(id));
    const dir = splitDir();
    const key = `${shown.join('|')}|${dir}`;
    if (key !== shownKey) {
      shownKey = key;
      panes.className = `dr-panes dir-${dir}${shown.length > 1 ? ' split' : ''}`;
      const els = [];
      shown.forEach((id, i) => {
        const pane = h('div', { class: 'dr-pane', dataset: { id } }, docs.get(id).stage);
        if (shown.length > 1) pane.style.flex = `${i === 0 ? tabs.split.ratio : 1 - tabs.split.ratio} 1 0`;
        if (i === 1) els.push(divider(dir));
        els.push(pane);
      });
      clear(panes, els);
    }
    for (const p of panes.querySelectorAll(':scope > .dr-pane')) p.classList.toggle('active', p.dataset.id === tabs.active);
    for (const id of shown) { const d = docs.get(id); d.stage.dataset.tool = prefs.tool; d.drawOverlay(); }
    const a = activeDoc();
    document.title = a ? `${a.rec.name} · Drawings · ${APP_TITLE}` : `Drawings · ${APP_TITLE}`;
    drawTabs();
    drawTop();
    drawTools();
    drawOptions();
    drawSelBar();
  }

  /* ---------- Tabs ---------- */

  function drawTabs() {
    clear(tabsEl, tabs.open.map(tabEl));
    const a = tabsEl.querySelector('.dr-tab.active');
    if (a) {
      const r = a.getBoundingClientRect(), s = tabsEl.getBoundingClientRect();
      if (r.left < s.left) tabsEl.scrollLeft -= s.left - r.left + 8;
      else if (r.right > s.right) tabsEl.scrollLeft += r.right - s.right + 8;
    }
  }
  function tabIcon(id) {
    const doc = docs.get(id), r = recOf(id);
    if (doc) {
      const c = h('canvas', { class: `dr-tab-icon${r?.kind === 'pixel' ? ' pixelated' : ''}`, width: 36, height: 36, 'aria-hidden': 'true' });
      doc.drawInto(c);
      return c;
    }
    const d = ctx.drawings.get(id);
    const c = d ? thumbCanvas(d, 18) : h('canvas', { width: 36, height: 36 });
    c.classList.remove('dg-thumb');
    c.classList.add('dr-tab-icon');
    return c;
  }
  let thumbTimers = new Map();
  function thumbSoon(id) {
    if (thumbTimers.has(id)) return;
    thumbTimers.set(id, setTimeout(() => {
      thumbTimers.delete(id);
      const c = tabsEl.querySelector(`.dr-tab[data-id="${CSS.escape(id)}"] canvas`);
      if (c) docs.get(id)?.drawInto(c);
    }, 700));
  }
  function tabEl(id) {
    const r = recOf(id);
    const name = r?.name || 'Drawing';
    const inSplit = !!tabs.split && (tabs.split.a === id || tabs.split.b === id);
    const active = id === tabs.active;
    const el = h('div', {
      class: `dr-tab${active ? ' active' : ''}${inSplit ? ' in-split' : ''}${inSplit && splitShown() && !active ? ' visible' : ''}`,
      role: 'tab', 'aria-selected': String(active), tabindex: active ? '0' : '-1', title: name, dataset: { id },
    },
      tabIcon(id),
      h('span', { class: 'dr-tab-name', text: name }),
      inSplit ? h('span', { class: 'dr-tab-split', title: 'In split screen', 'aria-label': 'In split screen' }, icon('split', { size: 12 })) : null,
      h('button', {
        type: 'button', class: 'dr-tab-close', 'aria-label': `Close ${name}`, title: 'Close',
        onclick: e => { e.stopPropagation(); closeTab(id); },
      }, icon('close', { size: 12 })));
    el.addEventListener('pointerdown', e => tabPress(e, id, el));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(id); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const i = tabs.open.indexOf(id) + (e.key === 'ArrowRight' ? 1 : -1);
        if (tabs.open[i]) { activate(tabs.open[i]); tabsEl.querySelector('.dr-tab.active')?.focus(); }
      }
    });
    return el;
  }

  /**
   * A tab: tap = show it; mouse drag or long-press (finger) = pick it up. Dragged along the row
   * it moves there; dragged down into the pictures it opens in split screen. A quick finger
   * swipe scrolls the row.
   */
  function tabPress(e, id, el) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.dr-tab-close')) return;
    e.preventDefault();
    const touch = e.pointerType !== 'mouse';
    const sx = e.clientX, sy = e.clientY, scroll0 = tabsEl.scrollLeft;
    let mode = 'press', drag = null;
    const timer = touch ? setTimeout(() => { if (mode === 'press') { mode = 'drag'; navigator.vibrate?.(15); startDrag(); } }, 400) : null;

    function startDrag() {
      closePopup();
      const r = el.getBoundingClientRect();
      const ghost = el.cloneNode(true);
      ghost.classList.add('dr-tab-ghost');
      ghost.classList.remove('dragging');
      Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px` });
      const marker = h('div', { class: 'dr-tab-marker', hidden: true });
      document.body.append(ghost, marker);
      el.classList.add('dragging');
      drag = { ghost, marker, offX: sx - r.left, offY: sy - r.top, target: null };
      dragMove(sx, sy);
    }
    function dragMove(x, y) {
      drag.ghost.style.transform = `translate(${x - drag.offX}px, ${y - drag.offY}px)`;
      const bar = tabbar.getBoundingClientRect();
      if (y < bar.bottom + 24) {
        dropEl.hidden = true;
        const els = [...tabsEl.children];
        let index = els.length;
        for (let i = 0; i < els.length; i++) { const rr = els[i].getBoundingClientRect(); if (x < rr.left + rr.width / 2) { index = i; break; } }
        const ref = els[Math.min(index, els.length - 1)].getBoundingClientRect();
        const mx = index < els.length ? ref.left : ref.right;
        Object.assign(drag.marker.style, { left: `${mx - 1}px`, top: `${bar.top + 6}px`, height: `${bar.height - 8}px` });
        drag.marker.hidden = false;
        drag.target = { kind: 'order', index };
        if (x < bar.left + 40) tabsEl.scrollLeft -= 10;
        else if (x > bar.right - 70) tabsEl.scrollLeft += 10;
      } else {
        drag.marker.hidden = true;
        const pr = panes.getBoundingClientRect();
        const dir = splitDir();
        const first = dir === 'row' ? x < pr.left + pr.width / 2 : y < pr.top + pr.height / 2;
        Object.assign(dropEl.style, { left: `${pr.left}px`, top: `${pr.top}px`, width: `${pr.width}px`, height: `${pr.height}px` });
        dropEl.className = `dr-drop dir-${dir}`;
        dropEl.hidden = false;
        dropZones[0].classList.toggle('on', first);
        dropZones[1].classList.toggle('on', !first);
        drag.target = { kind: 'split', side: first ? 0 : 1 };
      }
    }
    function dragEnd(cancelled) {
      drag.ghost.remove();
      drag.marker.remove();
      el.classList.remove('dragging');
      dropEl.hidden = true;
      const t = drag.target;
      drag = null;
      if (cancelled || !t) return;
      if (t.kind === 'order') {
        const from = tabs.open.indexOf(id);
        let to = t.index;
        if (to > from) to--;
        if (to !== from) { tabs.open.splice(from, 1); tabs.open.splice(to, 0, id); saveTabs(); }
        drawTabs();
      } else {
        splitWith(id, t.side);
      }
    }
    const move = ev => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (mode === 'press' && Math.hypot(dx, dy) > 8) {
        if (touch) { mode = 'scroll'; clearTimeout(timer); } else { mode = 'drag'; startDrag(); }
      }
      if (mode === 'scroll') tabsEl.scrollLeft = scroll0 - dx;
      else if (mode === 'drag' && drag) { ev.preventDefault(); dragMove(ev.clientX, ev.clientY); }
    };
    const up = ev => {
      if (ev.pointerId !== e.pointerId) return;
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      clearTimeout(timer);
      if (mode === 'press' && ev.type === 'pointerup') activate(id);
      if (mode === 'drag' && drag) dragEnd(ev.type === 'pointercancel');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }

  function plusMenu(anchor) {
    openPopup({
      rect: anchor.getBoundingClientRect(), title: 'Open',
      items: [
        { label: 'New drawing…', icon: 'plus', onPick: () => newDrawingDialog(ctx, { section: recOf(tabs.active)?.section || null }) },
        { label: 'Open a drawing…', icon: 'brush', onPick: () => openList(anchor) },
        { label: 'Add a reference picture…', icon: 'image', onPick: () => addReference({ split: false }) },
      ],
    });
  }
  function openList(anchor) {
    openPopup({
      rect: anchor.getBoundingClientRect(), title: 'Open a drawing', emptyText: 'Everything is open already.',
      items: ctx.drawings.drawings.filter(d => !tabs.open.includes(d.id)).map(d => ({
        label: d.data.name, hint: d.data.kind === 'reference' ? 'Picture' : `${d.data.width} × ${d.data.height}`,
        icon: d.data.kind === 'reference' ? 'image' : 'brush', onPick: () => open(d.id),
      })),
    });
  }

  /** A picture from the device: saved as a reference, shown next to the drawing (split screen). */
  function addReference({ split = true } = {}) {
    fileInput.value = '';
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const base = recOf(tabs.active);
      try {
        const ref = await importReference(file, { section: base?.section || null, idea: base?.idea || null });
        await refresh();
        if (!tabs.open.includes(ref.id)) tabs.open.push(ref.id);
        if (split && tabs.active && !docs.get(tabs.active)?.isRef) splitWith(ref.id, 1);
        else activate(ref.id);
        toast('Picture added. Tap it to pick a colour.');
      } catch (err) { errorDialog(err, "The picture couldn't be added"); }
    };
    fileInput.click();
  }

  /* ---------- Stamps ---------- */

  let stamps = [];
  async function loadStamps() { stamps = await getStamps(); if (mounted) { drawOptions(); } }
  const currentStamp = () => stamps.find(s => s.id === prefs.stamp && s.canvas) || stamps.find(s => s.canvas) || null;
  const stampPieces = new Map();
  /** The chosen stamp, ready for this drawing: its size in squares kept, flipped, turned, coloured. */
  function stampPiece(doc) {
    const s = currentStamp();
    if (!s) return null;
    const k = doc.engine.scale;
    const key = [s.id, s.canvas.width, k, prefs.stampSize, prefs.stampFlipX, prefs.stampFlipY, prefs.stampTurn, prefs.stampTint ? prefs.color : ''].join('|');
    let p = stampPieces.get(key);
    if (!p) {
      p = scalePiece(pieceFromCanvas(s.canvas, { maskAll: false }), (k / s.scale) * prefs.stampSize, s.kind !== 'pixel');
      if (prefs.stampFlipX) p = flipPiece(p, true);
      if (prefs.stampFlipY) p = flipPiece(p, false);
      if (prefs.stampTurn) p = turnPiece(p, prefs.stampTurn / 90);
      if (prefs.stampTint) { const c = hexToRgb(prefs.color); p = tintPiece(p, [c.r, c.g, c.b]); }
      if (stampPieces.size > 20) stampPieces.clear();
      stampPieces.set(key, p);
    }
    return p;
  }

  /* ---------- What documents tell the workspace ---------- */

  const api = {
    prefs,
    get spaceDown() { return spaceDown; },
    statusChanged(doc) { if (doc.id === tabs.active) statusEl.textContent = doc.status; },
    changed(doc) { if (doc.id === tabs.active) { drawUndo(); if (prefs.tool === 'polygon') drawOptions(); } thumbSoon(doc.id); },
    viewChanged(doc) { if (doc.id === tabs.active) zoomText.textContent = doc.zoomText; },
    activate(doc) { if (doc.id !== tabs.active) activate(doc.id); },
    selectionChanged(doc) { if (doc.id === tabs.active) { drawSelBar(); drawUndo(); } },
    picked(hex) {
      if (!hex) { toast('Nothing to pick up there (it’s see-through).'); return; }
      setColor(hex);
      if (prefs.tool === 'picker') setTool(prevTool || 'pen');
    },
    remember(hex) {
      prefs.recent = [hex, ...prefs.recent.filter(c => c !== hex)].slice(0, 12);
      savePrefs();
      drawRecent();
    },
    strokeOptions(doc) {
      const wrap = !!doc.st.tiles;
      if (prefs.tool === 'eraser' && prefs.eraseTap) {
        // The tap eraser: a fill with nothing (see-through).
        return { tool: 'fill', mode: doc.st.mode, color: '#000000', opacity: 0, fillAll: prefs.eraseAll, symmetry: doc.st.mirror, wrap };
      }
      const pal = prefs.tool === 'effect' && prefs.fxAlongPalette && doc.st.mode === 'pixel' && (prefs.fx === 'lighten' || prefs.fx === 'darken')
        ? rowPalette.map(c => { const v = hexToRgb(c); return [v.r, v.g, v.b]; }) : null;
      return {
        tool: prefs.tool, mode: doc.st.mode, color: prefs.color, color2: prefs.color2, opacity: prefs.opacity,
        size: doc.st.mode === 'pixel' ? prefs.pixelSize : prefs.freeSize,
        soft: prefs.soft, filled: prefs.filled, fillAll: prefs.fillAll,
        pixelPerfect: prefs.tool === 'pen' && prefs.pixelPerfect, symmetry: doc.st.mirror, wrap,
        gradShape: prefs.gradShape, gradTo: prefs.gradTo, gradArea: prefs.gradArea, gradSteps: prefs.gradSteps, gradDither: prefs.gradDither,
        fx: prefs.fx, strength: prefs.fxStrength, fxPalette: pal && pal.length ? pal : null, fxDither: prefs.fxDither,
        stampPiece: prefs.tool === 'stamp' ? stampPiece(doc) : null,
      };
    },
    brushOutline() {
      const t = prefs.tool;
      if (t === 'stamp') {
        const d = drawingDoc();
        const p = d && stampPiece(d);
        return p ? { stamp: { w: p.w, h: p.h } } : null;
      }
      return t === 'pen' || (t === 'eraser' && !prefs.eraseTap) || ['line', 'rect', 'ellipse', 'polygon', 'effect'].includes(t)
        ? { pixelSize: prefs.pixelSize, freeSize: prefs.freeSize } : null;
    },
    /** The Text tool was tapped at p (fine pixels): ask for the text, then place it there. */
    async textAt(doc, p) {
      const r = await textDialog({ prefs, savePrefs, mode: doc.st.mode, k: doc.engine.scale });
      if (!r) return;
      const pixel = doc.st.mode === 'pixel';
      let piece = pieceFromCanvas(r.canvas, { maskAll: false });
      if (r.unit !== doc.engine.scale) piece = scalePiece(piece, doc.engine.scale / r.unit, !pixel && r.unit > 1);
      // Its top-left corner goes on the square you tapped.
      const k = doc.engine.scale;
      doc.engine.pasteFloat(piece, pixel ? { x: Math.floor(p.x / k) * k, y: Math.floor(p.y / k) * k, pixel } : { x: Math.round(p.x), y: Math.round(p.y), pixel });
      if (prefs.color) api.remember(prefs.color);
      toast('Drag the text where you want it, then tap Done.');
    },
    closeMenus: () => closePopup(),
    /** Where the selection bar floats over the pictures (Fit leaves room for it). */
    fitInset: () => (isPhone() ? { top: 0, bottom: 52 } : { top: 58, bottom: 0 }),
  };

  /* ---------- Tools and options ---------- */

  function setTool(id) {
    if (id === 'picker' && prefs.tool !== 'picker') prevTool = prefs.tool;
    // A polygon you were drawing is finished when you take another tool.
    for (const sid of shownIds()) { const d = docs.get(sid); if (d?.engine?.polygon && id !== 'polygon') { d.engine.polyClose(); d.drawOverlay(); } }
    prefs.tool = id;
    const g = groupOf(id);
    if (g) prefs.groupLast[g] = id;
    savePrefs();
    drawTools();
    drawOptions();
    drawSelBar();
    for (const sid of shownIds()) { const d = docs.get(sid); if (d) { d.stage.dataset.tool = id; d.drawOverlay(); } }
  }
  function setMode(m) {
    const d = activeDoc();
    if (!d || d.isRef) return;
    d.setMode(m);
    drawTools();
    drawOptions();
  }
  const penMode = () => { const d = activeDoc(); return d && !d.isRef ? d.st.mode : (drawingDoc()?.st.mode || 'pixel'); };

  function toolButton(id, mode, { lbl = null, ic = null, pressed = prefs.tool === id, onclick = () => setTool(id), data = id } = {}) {
    const name = lbl || (id === 'pen' ? (mode === 'pixel' ? 'Pixel pen' : 'Free pen') : label(id));
    const key = TOOLS.find(t => t.id === id)?.key;
    return h('button', {
      type: 'button', class: 'dr-tool', 'aria-pressed': String(pressed), dataset: { tool: data },
      'aria-label': name, title: key ? `${name} (${key})` : name, onclick,
    }, icon(ic || toolIcon(id, mode, prefs), { size: 22 }));
  }
  function drawTools() {
    const mode = penMode();
    if (!isPhone()) { clear(toolsEl, TOOLS.map(tl => toolButton(tl.id, mode))); return; }
    clear(toolsEl, PHONE_BAR.map(id => {
      const g = GROUPS[id];
      if (!g) return toolButton(id, mode);
      const last = g.tools.includes(prefs.groupLast[id]) ? prefs.groupLast[id] : g.tools[0];
      const on = g.tools.includes(prefs.tool);
      const shown = on ? prefs.tool : last;
      return toolButton(shown, mode, {
        lbl: g.label, pressed: on, data: id, ic: toolIcon(shown, mode, prefs),
        onclick: e => (on ? groupMenu(id, e.currentTarget) : setTool(last)),
      });
    }));
  }
  function groupMenu(g, anchor) {
    openPopup({
      rect: anchor.getBoundingClientRect(), title: GROUPS[g].label,
      items: GROUPS[g].tools.map(id => ({ label: label(id), icon: toolIcon(id, penMode(), prefs), hint: prefs.tool === id ? '✓' : '', onPick: () => setTool(id) })),
    });
  }

  const seg = (name, options, value, onPick) => h('div', { class: 'seg dr-seg', role: 'group', 'aria-label': name },
    options.map(([v, lbl, ic]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': String(value === v), dataset: { value: v },
      title: lbl, 'aria-label': lbl,
      onclick: () => onPick(v),
    }, ic ? icon(ic, { size: 14 }) : null, ic && isPhone() ? null : lbl)));
  const freeMax = () => { const d = drawingDoc(); return Math.max(8, Math.round(Math.max(d?.engine.W || 1024, d?.engine.H || 1024) / 4)); };
  const sizeToSlider = s => Math.round((Math.log(Math.max(1, s)) / Math.log(freeMax())) * 100);
  const sliderToSize = v => Math.max(1, Math.round(Math.exp((v / 100) * Math.log(freeMax()))));
  function slider(lbl, { min, max, value, show, onInput, name, step = 1 }) {
    const out = h('span', { class: 'dr-slider-value', text: show(value) });
    const input = h('input', { type: 'range', min, max, step, value, name, 'aria-label': lbl });
    input.addEventListener('input', () => { out.textContent = show(+input.value); onInput(+input.value); });
    return h('label', { class: 'dr-slider' }, h('span', { class: 'dr-slider-label', text: lbl }), input, out);
  }
  const check = (lbl, name, value, onChange, title = '') => h('label', { class: 'dr-check', title },
    h('input', { type: 'checkbox', name, checked: value, onchange: e => onChange(e.target.checked) }), lbl);
  const hint = text => h('span', { class: 'muted small dr-hint', text });
  const redrawOverlays = () => { for (const id of shownIds()) docs.get(id)?.drawOverlay(); };
  const set = (key, after = drawOptions) => v => { prefs[key] = v; savePrefs(); after?.(); redrawOverlays(); };

  const sizeSlider = mode => (mode === 'pixel'
    ? slider('Size', { name: 'size', min: 1, max: 16, value: prefs.pixelSize, show: v => `${v}`, onInput: v => { prefs.pixelSize = v; savePrefs(); } })
    : slider('Size', { name: 'size', min: 0, max: 100, value: sizeToSlider(prefs.freeSize), show: v => `${sliderToSize(v)}`, onInput: v => { prefs.freeSize = sliderToSize(v); savePrefs(); } }));
  const opacitySlider = () => slider('Opacity', { name: 'opacity', min: 5, max: 100, value: Math.round(prefs.opacity * 100), show: v => `${v}%`, onInput: v => { prefs.opacity = v / 100; savePrefs(); } });

  function drawOptions() {
    const tl = prefs.tool;
    const a = activeDoc();
    if (a?.isRef) {
      clear(optsEl, hint('Reference picture: tap it to pick a colour. Drag to move it, pinch or scroll to zoom.'));
      return;
    }
    const mode = penMode();
    const parts = [seg('Pen', [['pixel', 'Pixel', 'pencil'], ['free', 'Free', 'brush']], mode, setMode)];
    const g = groupOf(tl);
    if (g && isPhone()) parts.push(seg(GROUPS[g].label, GROUPS[g].tools.map(id => [id, label(id), toolIcon(id, mode, prefs)]), tl, setTool));
    const tapErase = tl === 'eraser' && prefs.eraseTap;
    if (tl === 'picker') {
      parts.push(hint('Tap a picture to pick up a colour (the other half of a split screen works too).'));
    } else if (tl === 'select') {
      parts.push(seg('Select', [['rect', 'Rectangle', 'select'], ['lasso', 'Free shape', 'lasso'], ['wand', 'Colour area', 'wand']], prefs.selShape, set('selShape', () => { drawTools(); drawOptions(); })));
      parts.push(seg('Selection', [['new', 'New'], ['add', 'Add'], ['subtract', 'Take away']], prefs.selOp, set('selOp')));
      if (prefs.selShape === 'wand') {
        parts.push(seg('Colour area', [[false, 'Connected'], [true, 'Everywhere']], prefs.wandAll, set('wandAll')));
        if (mode === 'free') parts.push(slider('Tolerance', { name: 'tolerance', min: 0, max: 120, value: prefs.wandTol, show: v => `${v}`, onInput: v => { prefs.wandTol = v; savePrefs(); } }));
      }
      if (!isPhone()) parts.push(hint(prefs.selShape === 'wand' ? 'Tap a colour to select its area. Shift adds, Alt takes away.' : 'Drag to select. Drag inside the selection to move it (Ctrl: a copy). Shift adds, Alt takes away.'));
    } else if (tl === 'polygon') {
      parts.push(sizeSlider(mode), opacitySlider());
      parts.push(seg('Shape', [[false, 'Outline'], [true, 'Filled']], prefs.filled, set('filled')));
      const poly = workDoc()?.engine.polygon;
      if (poly) {
        parts.push(h('button', { type: 'button', class: 'btn btn-small', onclick: () => { workDoc()?.engine.polyBack(); redrawOverlays(); drawOptions(); } }, icon('undo', { size: 14 }), 'Undo corner'));
        parts.push(h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => finishPolygon() }, icon('check', { size: 14 }), 'Done'));
      } else parts.push(hint('Tap the corners. Tap the first corner again (or double-click) to finish.'));
    } else if (tl === 'gradient') {
      parts.push(seg('Gradient', [['straight', 'Straight'], ['round', 'Round']], prefs.gradShape, set('gradShape')));
      parts.push(seg('Gradient colours', [['color2', 'To colour 2'], ['clear', 'To see-through']], prefs.gradTo, set('gradTo')));
      if (!workDoc()?.engine.hasSelection) parts.push(seg('Gradient area', [['area', 'Tapped area'], ['all', 'Whole picture']], prefs.gradArea, set('gradArea')));
      if (mode === 'pixel') {
        parts.push(slider('Steps', { name: 'steps', min: 1, max: 16, value: prefs.gradSteps < 2 ? 1 : prefs.gradSteps, show: v => (v < 2 ? 'Smooth' : `${v}`), onInput: v => { prefs.gradSteps = v < 2 ? 0 : v; savePrefs(); } }));
        parts.push(seg('Dither', [['off', 'No dither'], ['checker', 'Checker'], ['ordered', 'Ordered']], prefs.gradDither, set('gradDither')));
      }
      parts.push(opacitySlider());
    } else if (tl === 'effect') {
      const sel = h('select', { class: 'input dr-select', name: 'effect', 'aria-label': 'Effect' }, Object.entries(BRUSH_EFFECTS).map(([k, v]) => h('option', { value: k, text: v })));
      sel.value = prefs.fx;
      sel.addEventListener('change', () => set('fx')(sel.value));
      parts.push(sel, sizeSlider(mode));
      parts.push(slider('Strength', { name: 'strength', min: 1, max: 100, value: Math.round(prefs.fxStrength * 100), show: v => `${v}%`, onInput: v => { prefs.fxStrength = v / 100; savePrefs(); } }));
      if (mode === 'free') parts.push(seg('Brush', [[false, 'Hard'], [true, 'Soft']], prefs.soft, set('soft')));
      if (mode === 'pixel' && (prefs.fx === 'lighten' || prefs.fx === 'darken')) {
        parts.push(check('Along the palette', 'alongPalette', prefs.fxAlongPalette, set('fxAlongPalette'), 'Each square steps to the next lighter (or darker) colour of the palette you chose'));
      }
      if (prefs.fx === 'dither') {
        parts.push(seg('Pattern', [['checker', 'Checker'], ['ordered', 'Ordered']], prefs.fxDither, set('fxDither')));
        if (!isPhone()) parts.push(hint('Paints colour 1 and colour 2 in a pattern. Strength = how much is colour 1.'));
      }
    } else if (tl === 'text') {
      parts.push(hint('Tap where the text goes. You can drag it into place before tapping Done.'));
    } else if (tl === 'stamp') {
      const s = currentStamp();
      parts.push(h('button', { type: 'button', class: 'btn btn-small dr-stamp-btn', title: 'Choose a stamp', onclick: chooseStamp },
        s ? stampThumb(s, 12) : icon('stamp', { size: 14 }), s ? s.name : 'Choose a stamp'));
      parts.push(seg('Stamp size', [[1, '1×'], [2, '2×'], [3, '3×'], [4, '4×']], prefs.stampSize, set('stampSize')));
      parts.push(h('div', { class: 'dr-iconrow' },
        toggleBtn('Mirror the stamp left-right', 'fliph', prefs.stampFlipX, () => set('stampFlipX')(!prefs.stampFlipX)),
        toggleBtn('Mirror the stamp top-bottom', 'flipv', prefs.stampFlipY, () => set('stampFlipY')(!prefs.stampFlipY)),
        toggleBtn(`Turn the stamp (now ${prefs.stampTurn}°)`, 'turnright', !!prefs.stampTurn, () => set('stampTurn')((prefs.stampTurn + 90) % 360))));
      parts.push(seg('Stamp colours', [[false, 'Own colours'], [true, 'My colour']], prefs.stampTint, set('stampTint')));
      parts.push(opacitySlider());
    } else {
      if (tl === 'eraser') parts.push(seg('Eraser', [[false, 'Brush'], [true, 'Tap a colour']], prefs.eraseTap, v => { prefs.eraseTap = v; savePrefs(); drawOptions(); redrawOverlays(); }));
      if (tapErase) {
        parts.push(seg('Erase', [[false, 'Connected'], [true, 'Everywhere']], prefs.eraseAll, v => { prefs.eraseAll = v; savePrefs(); drawOptions(); }));
        parts.push(hint(prefs.eraseAll ? 'Tap a colour: it goes everywhere.' : 'Tap a colour: the area of that colour it touches goes.'));
      } else if (tl !== 'fill') {
        parts.push(sizeSlider(mode));
      }
      if (tl !== 'eraser') parts.push(opacitySlider());
      if ((tl === 'pen' || (tl === 'eraser' && !tapErase)) && mode === 'free') parts.push(seg('Brush', [[false, 'Hard'], [true, 'Soft']], prefs.soft, v => { prefs.soft = v; savePrefs(); drawOptions(); }));
      if (tl === 'pen' && mode === 'pixel') {
        parts.push(check('Pixel-perfect', 'pixelPerfect', prefs.pixelPerfect, v => { prefs.pixelPerfect = v; savePrefs(); }, 'Keeps lines one square thin: no extra squares in the corners'));
      }
      if (tl === 'rect' || tl === 'ellipse') parts.push(seg('Shape', [[false, 'Outline'], [true, 'Filled']], prefs.filled, v => { prefs.filled = v; savePrefs(); drawOptions(); }));
      if (tl === 'fill') parts.push(seg('Fill', [[false, 'Connected'], [true, 'Everywhere']], prefs.fillAll, v => { prefs.fillAll = v; savePrefs(); drawOptions(); }));
    }
    clear(optsEl, parts);
  }
  const toggleBtn = (lbl, ic, on, fn) => h('button', { type: 'button', class: 'icon-btn dr-toggle', 'aria-label': lbl, title: lbl, 'aria-pressed': String(!!on), onclick: fn }, icon(ic, { size: 18 }));
  async function chooseStamp() {
    const id = await stampsDialog({ current: currentStamp()?.id });
    await loadStamps();
    if (id) { prefs.stamp = id; savePrefs(); drawOptions(); redrawOverlays(); }
  }
  function finishPolygon() {
    const d = workDoc();
    if (!d?.engine.polygon) return;
    d.engine.polyClose();
    d.drawOverlay();
    drawOptions();
    drawUndo();
  }

  /* ---------- The selection bar ---------- */

  const barBtn = (lbl, ic, fn, { primary = false, text = false, disabled = false } = {}) => h('button', {
    type: 'button', class: `${text ? 'btn btn-small' : 'icon-btn'} dr-selbtn${primary ? ' btn-primary' : ''}`, 'aria-label': lbl, title: lbl, disabled, onclick: fn,
  }, icon(ic, { size: text ? 14 : 18 }), text ? lbl : null);

  function drawSelBar() {
    const d = workDoc();
    const e = d?.engine;
    const show = !!d && (e.hasSelection || prefs.tool === 'select');
    selEl.hidden = !show;
    if (!show) { clear(selEl); return; }
    const mode = d.st.mode;
    const parts = [];
    if (e.floating) {
      parts.push(barBtn('Done', 'check', () => commitFloat(), { primary: true, text: true }));
      parts.push(barBtn('Put it back', 'close', () => { e.cancelFloat(); afterChange(d); }));
      parts.push(h('span', { class: 'dr-sep' }));
      parts.push(barBtn('Mirror left-right', 'fliph', () => { e.flipFloat(true); afterChange(d); }));
      parts.push(barBtn('Mirror top-bottom', 'flipv', () => { e.flipFloat(false); afterChange(d); }));
      parts.push(barBtn('Turn a quarter left', 'turnleft', () => { e.turnFloat(-1); afterChange(d); }));
      parts.push(barBtn('Turn a quarter right', 'turnright', () => { e.turnFloat(1); afterChange(d); }));
      const angle = slider('Angle', {
        name: 'angle', min: -180, max: 180, value: Math.round(e.floatAngle), show: v => `${v}°`,
        onInput: v => { angleTarget = v; if (!angleRaf) angleRaf = requestAnimationFrame(() => { angleRaf = 0; e.setFloatAngle(angleTarget); }); },
      });
      angle.classList.add('dr-angle');
      angle.title = mode === 'pixel' ? 'Pixel art turns with RotSprite: lines stay clean, no blur' : 'Turns smoothly';
      parts.push(angle);
      parts.push(h('span', { class: 'dr-sep' }));
      parts.push(barBtn('Copy', 'copy', () => copySel(d)));
      parts.push(barBtn('Delete it', 'trash', () => { e.clearSelected(); afterChange(d); }));
    } else if (e.hasSelection) {
      // On a phone the less used ones are in More, so the bar stays one row.
      const phone = isPhone();
      parts.push(barBtn('Copy', 'copy', () => copySel(d)));
      parts.push(barBtn('Cut', 'cut', () => cutSel(d)));
      parts.push(barBtn('Paste', 'paste', () => pasteInto(d), { disabled: !clip }));
      parts.push(barBtn('Delete what is selected', 'trash', () => { e.clearSelected(); afterChange(d); }));
      if (!phone) parts.push(h('span', { class: 'dr-sep' }));
      parts.push(barBtn('Mirror left-right', 'fliph', () => transform(d, f => f.flipFloat(true))));
      if (!phone) parts.push(barBtn('Mirror top-bottom', 'flipv', () => transform(d, f => f.flipFloat(false))));
      if (!phone) parts.push(barBtn('Turn a quarter left', 'turnleft', () => transform(d, f => f.turnFloat(-1))));
      parts.push(barBtn('Turn a quarter right', 'turnright', () => transform(d, f => f.turnFloat(1))));
      parts.push(barBtn('Turn by any angle', 'turnany', () => transform(d, () => {})));
      const more = barBtn('More', 'sliders', () => selMenu(d, more));
      parts.push(more);
      parts.push(barBtn('Deselect', 'close', () => { e.deselect(); afterChange(d); }, { text: !phone }));
    } else {
      parts.push(barBtn('Paste', 'paste', () => pasteInto(d), { disabled: !clip, text: true }));
      parts.push(barBtn('Select all', 'select', () => { e.selectAll(); afterChange(d); }, { text: true }));
      parts.push(barBtn('Mirror the whole picture left-right', 'fliph', () => transform(d, f => f.flipFloat(true))));
      parts.push(barBtn('Mirror the whole picture top-bottom', 'flipv', () => transform(d, f => f.flipFloat(false))));
      parts.push(barBtn('Turn the whole picture', 'turnright', () => transform(d, f => f.turnFloat(1))));
    }
    clear(selEl, parts);
  }
  let angleTarget = 0, angleRaf = 0;
  function afterChange(d) { d.drawOverlay(); drawSelBar(); drawUndo(); }
  function commitFloat(d = workDoc()) { d?.engine.commitFloat(); if (d) afterChange(d); }
  /** Lift what's selected (everything if nothing is) and change it; Done lays it down. */
  function transform(d, fn) {
    d.engine.lift({ mode: d.st.mode });
    fn(d.engine);
    afterChange(d);
  }
  function selMenu(d, anchor) {
    const e = d.engine;
    openPopup({
      rect: anchor.getBoundingClientRect(), title: 'Selection',
      items: [
        isPhone() ? { label: 'Mirror top-bottom', icon: 'flipv', onPick: () => transform(d, f => f.flipFloat(false)) } : null,
        isPhone() ? { label: 'Turn a quarter left', icon: 'turnleft', onPick: () => transform(d, f => f.turnFloat(-1)) } : null,
        { label: 'Select all', icon: 'select', onPick: () => { e.selectAll(); afterChange(d); } },
        { label: 'Select the rest', hint: 'everything else', icon: 'swap', onPick: () => { e.invertSelection(); afterChange(d); } },
        { label: 'Save as stamp…', icon: 'stamp', onPick: () => saveSelAsStamp(d) },
        { label: 'Deselect', icon: 'close', onPick: () => { e.deselect(); afterChange(d); } },
      ].filter(Boolean),
    });
  }
  function copySel(d) {
    const { piece, at } = d.engine.copyPiece();
    clip = { piece, k: d.engine.scale, pixel: d.st.mode === 'pixel' || d.rec.kind === 'pixel', at, from: d.id };
    toast('Copied. Paste it here or in another drawing.');
    drawSelBar();
  }
  function cutSel(d) {
    copySel(d);
    d.engine.clearSelected();
    afterChange(d);
  }
  /** Paste what was copied: the same size in squares, where it was (or the middle of the screen). */
  function pasteInto(d, item = clip) {
    if (!d || !item) return;
    const k = d.engine.scale, f = k / item.k;
    const piece = f === 1 ? item.piece : scalePiece(item.piece, f, !item.pixel);
    let x = Math.round(item.at.x * f), y = Math.round(item.at.y * f);
    const c = d.viewCenter();
    if (item.from !== d.id || x + piece.w <= 0 || y + piece.h <= 0 || x >= d.engine.W || y >= d.engine.H) { x = c.x - piece.w / 2; y = c.y - piece.h / 2; }
    if (d.st.mode === 'pixel') { x = Math.round(x / k) * k; y = Math.round(y / k) * k; }
    d.engine.pasteFloat(piece, { x, y, pixel: d.st.mode === 'pixel' });
    afterChange(d);
  }
  /** A picture pasted from the computer: one pixel per square if it fits, otherwise fitted in. */
  async function pastePicture(d, file) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { toast("That picture couldn't be pasted."); return; }
    const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    const e = d.engine, k = e.scale;
    const fits = c.width <= e.width && c.height <= e.height;
    const f = fits ? k : Math.min(e.W / c.width, e.H / c.height, k);
    const piece = scalePiece(pieceFromCanvas(c), f, !fits);
    const mid = d.viewCenter();
    d.engine.pasteFloat(piece, { x: Math.round((mid.x - piece.w / 2) / k) * k, y: Math.round((mid.y - piece.h / 2) / k) * k, pixel: d.st.mode === 'pixel' });
    afterChange(d);
    toast(fits ? 'Pasted, one pixel per square. Drag it into place, then tap Done.' : 'Pasted (made smaller to fit). Drag it into place, then tap Done.');
  }
  function saveSelAsStamp(d) {
    const { piece } = d.engine.copyPiece();
    const pixel = d.st.mode === 'pixel';
    let canvas = piece.canvas, scale = d.engine.scale;
    if (pixel) {
      // Pixel stamps keep one pixel per square.
      const cells = pieceCells(piece, scale);
      canvas = cellsToPiece(cells, 1).canvas;
      scale = 1;
    }
    saveStampDialog({ canvas, kind: pixel ? 'pixel' : 'free', scale }).then(() => loadStamps());
  }

  /* ---------- Colours: a side panel on a PC, a row with a colour button on a phone ---------- */

  const drawingColors = () => drawingDoc()?.engine.paletteColors() || [];
  let picker = null, pal = null;
  const recentPC = h('div', { class: 'dr-recent', 'aria-label': 'Recent colours' });
  const pairPC = h('div', { class: 'dr-pair-host' });
  const swatch = (c, lbl) => h('button', { type: 'button', class: 'pal-sw', style: { '--c': c }, title: c, 'aria-label': `${lbl} ${c}`, dataset: { color: c }, onclick: () => setColor(c) });
  function setColor(hex) {
    hex = normHex(hex);
    if (!hex) return;
    prefs.color = hex;
    savePrefs();
    picker?.set(hex);
    drawColors();
  }
  function swapPair() {
    [prefs.color, prefs.color2] = [prefs.color2, prefs.color];
    savePrefs();
    picker?.set(prefs.color);
    drawColors();
    if (prefs.tool === 'stamp') redrawOverlays();
  }
  async function pickColor2() {
    const v = await pickColorDialog({ title: 'Colour 2', value: prefs.color2, drawingColors });
    if (v && v !== 'keep') { prefs.color2 = normHex(v) || prefs.color2; savePrefs(); drawColors(); }
  }
  /** Colour 1 (big) with colour 2 behind it, and the swap button. */
  function pairEl(phone) {
    return h('div', { class: 'dr-pair' },
      phone ? h('button', {
        type: 'button', class: 'dr-current-btn', style: { '--c': prefs.color }, 'aria-label': `Colour ${prefs.color}: change it`, title: 'Change the colour',
        onclick: async () => {
          const v = await pickColorDialog({ title: 'Colour', value: prefs.color, drawingColors });
          if (v && v !== 'keep') setColor(v);
          loadRowPalette();
        },
      }) : h('span', { class: 'dr-pair-front', style: { '--c': prefs.color }, title: `Colour 1: ${prefs.color}` }),
      h('button', { type: 'button', class: 'dr-pair-back', style: { '--c': prefs.color2 }, 'aria-label': `Colour 2 ${prefs.color2}: change it`, title: `Colour 2: ${prefs.color2} (for gradients and dither). Tap to change it.`, onclick: pickColor2 }),
      h('button', { type: 'button', class: 'icon-btn dr-pair-swap', 'aria-label': 'Swap colour 1 and colour 2 (X)', title: 'Swap colour 1 and colour 2 (X)', onclick: swapPair }, icon('swap', { size: 16 })));
  }
  function drawRecent() {
    clear(recentPC, prefs.recent.length ? prefs.recent.map(c => swatch(c, 'Recent colour')) : h('span', { class: 'muted small', text: 'Colours you draw with show up here.' }));
    drawColors();
  }
  let rowPalette = [];
  async function loadRowPalette() { rowPalette = await currentPaletteColors(); drawColors(); }
  function drawColors() {
    clear(pairPC, pairEl(false));
    clear(colorsRow, pairEl(true),
      h('div', { class: 'dr-colors-scroll' },
        prefs.recent.filter(c => c !== prefs.color).slice(0, 6).map(c => swatch(c, 'Recent colour')),
        rowPalette.length ? h('span', { class: 'dr-colors-gap', 'aria-hidden': 'true' }) : null,
        rowPalette.map(c => swatch(c, 'Palette colour'))));
  }
  function buildSide() {
    picker = colorPicker({ value: prefs.color, onInput: v => { prefs.color = v; savePrefs(); drawColors(); } });
    pal = palettePanel({ getColor: () => prefs.color, onPick: setColor, drawingColors, onChoose: () => loadRowPalette() });
    clear(side,
      h('h2', { class: 'dr-side-title', text: 'Colour' }), pairPC, picker.el,
      h('h2', { class: 'dr-side-title', text: 'Recent' }), recentPC,
      h('h2', { class: 'dr-side-title', text: 'Palette' }), pal.el);
  }
  buildSide();
  store.on(e => {
    if (!mounted) return;
    if (e?.type === 'sync' || e?.collection === 'palettes') loadRowPalette();
    if (e?.type === 'sync' || e?.collection === 'stamps') loadStamps();
  });

  /* ---------- Top bar ---------- */

  const zoomText = h('span', { class: 'dr-zoom muted small' });
  const statusEl = h('span', { class: 'dr-status muted small', role: 'status' });
  const nameBtn = h('button', { type: 'button', class: 'dr-name', title: 'Name, section and idea', onclick: () => details() });
  const undoBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Undo', title: 'Undo (Ctrl+Z)', onclick: () => { activeDoc()?.undo(); drawSelBar(); } }, icon('undo', { size: 20 }));
  const redoBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Redo', title: 'Redo (Ctrl+Y)', onclick: () => { activeDoc()?.redo(); drawSelBar(); } }, icon('redo', { size: 20 }));
  function drawUndo() { const d = activeDoc(); undoBtn.disabled = !d?.canUndo(); redoBtn.disabled = !d?.canRedo(); }
  const toggle = (lbl, ic, on, fn, cls = '') => h('button', { type: 'button', class: `icon-btn dr-toggle ${cls}`, 'aria-label': lbl, title: lbl, 'aria-pressed': String(!!on), onclick: fn }, icon(ic, { size: 20 }));
  function drawTop() {
    const d = activeDoc();
    if (!d) { clear(topEl); return; }
    nameBtn.textContent = d.rec.name;
    statusEl.textContent = d.status;
    zoomText.textContent = d.zoomText;
    const more = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'More', title: 'Effects, split screen, export…', onclick: () => menu(more) }, '⋯');
    const fxBtn = d.isRef ? null : h('button', { type: 'button', class: 'icon-btn dr-pc', 'aria-label': 'Effects', title: 'Effects: colours, blur, noise, pixelate, outline…', onclick: () => effectsMenu(fxBtn) }, icon('sparkle', { size: 20 }));
    const mirrorBtn = d.isRef ? null : h('button', {
      type: 'button', class: 'icon-btn dr-toggle dr-pc', 'aria-label': `Mirror drawing: ${MIRRORS[d.st.mirror]}`, title: `Mirror drawing: ${MIRRORS[d.st.mirror]}`,
      'aria-pressed': String(d.st.mirror !== 'none'), onclick: () => mirrorMenu(mirrorBtn),
    }, icon('mirror', { size: 20 }));
    clear(topEl,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', title: 'Back to the drawings (they stay open as tabs)', onclick: () => leave() }, icon('back', { size: 20 })),
      h('div', { class: 'dr-title' }, nameBtn, statusEl),
      h('div', { class: 'dr-top-tools' },
        d.isRef ? null : [undoBtn, redoBtn, h('span', { class: 'dr-sep dr-pc' })],
        h('button', { type: 'button', class: 'icon-btn dr-pc', 'aria-label': 'Zoom out', title: 'Zoom out', onclick: () => activeDoc()?.zoomMiddle(1 / 1.4) }, '−'),
        zoomText,
        h('button', { type: 'button', class: 'icon-btn dr-pc', 'aria-label': 'Zoom in', title: 'Zoom in', onclick: () => activeDoc()?.zoomMiddle(1.4) }, '+'),
        h('button', { type: 'button', class: 'icon-btn dr-pc', 'aria-label': 'Fit', title: 'Fit on screen (F)', onclick: () => activeDoc()?.fit() }, icon('fit', { size: 20 })),
        d.isRef ? null : [
          h('span', { class: 'dr-sep dr-pc' }),
          toggle('Grid', 'grid', d.st.grid, toggleGrid, 'dr-pc'),
          toggle('Tiles: see it repeated, for blocks (you can draw across the edges)', 'tiles', d.st.tiles, toggleTiles, 'dr-pc'),
          mirrorBtn,
          fxBtn,
        ],
        more));
    drawUndo();
  }
  function toggleGrid() { activeDoc()?.toggleGrid(); drawTop(); }
  function toggleTiles() { activeDoc()?.toggleTiles(); drawTop(); }
  function mirrorMenu(anchor) {
    const d = activeDoc();
    openPopup({
      rect: anchor.getBoundingClientRect(), title: 'Mirror drawing',
      items: Object.entries(MIRRORS).map(([k, lbl]) => ({ label: lbl, hint: d.st.mirror === k ? '✓' : '', icon: k === 'none' ? 'close' : 'mirror', onPick: () => { d.setMirror(k); drawTop(); } })),
    });
  }
  function effectsMenu(anchor) {
    const d = workDoc();
    if (!d) return;
    const where = d.engine.hasSelection ? ' (selection)' : '';
    openPopup({
      rect: anchor.getBoundingClientRect(), title: `Effects${where}`,
      items: [
        ...Object.entries(EFFECTS).map(([k, v]) => ({ label: `${v.name}…`, icon: v.icon, onPick: () => runEffect(k) })),
        { label: 'Swap colours…', icon: 'swap', onPick: swapColors },
        { label: 'Make it grayscale…', icon: 'gray', onPick: grayscale },
      ],
    });
  }
  async function runEffect(kind) {
    const d = workDoc();
    if (!d) return;
    const r = await effectDialog(kind, { engine: d.engine, mode: d.st.mode, prefs, pixelArt: d.rec.kind === 'pixel' });
    if (!r) return;
    if (r.copy) {
      await d.flush();
      await copyWithImage({ id: d.id, data: d.rec }, ctx.ui, r.image, EFFECTS[kind].copyLabel);
      return;
    }
    if (d.engine.applyEffect(r.fn, d.st.mode)) toast(`${EFFECTS[kind].done} Undo brings it back.`);
    else toast('Nothing changed.');
    afterChange(d);
  }
  function menu(anchor) {
    const d = activeDoc();
    if (!d) return;
    const ref = d.isRef, phone = isPhone();
    const others = tabs.open.filter(x => x !== d.id);
    openPopup({
      rect: anchor.getBoundingClientRect(), title: d.rec.name,
      items: [
        phone ? { label: 'Fit on screen', icon: 'fit', onPick: () => d.fit() } : null,
        phone && !ref ? { label: d.st.grid ? 'Hide the grid' : 'Show the grid', icon: 'grid', onPick: toggleGrid } : null,
        phone && !ref ? { label: d.st.tiles ? 'Stop showing tiles' : 'Tiles (see it repeated)', icon: 'tiles', onPick: toggleTiles } : null,
        phone && !ref ? { label: 'Mirror drawing…', hint: MIRRORS[d.st.mirror], icon: 'mirror', onPick: () => mirrorMenu(anchor) } : null,
        ref ? null : { label: 'Effects…', hint: 'colours, blur, outline…', icon: 'sparkle', onPick: () => effectsMenu(anchor) },
        splitShown() ? { label: 'Swap sides', icon: 'swap', onPick: swapSides } : null,
        splitShown() ? { label: 'Close split screen', icon: 'close', onPick: closeSplit }
          : others.length ? { label: 'Split screen with…', icon: 'split', onPick: () => splitList(anchor) } : null,
        { label: 'Add a reference picture…', icon: 'image', onPick: () => addReference() },
        ref ? null : { label: 'Export PNG…', icon: 'download', onPick: () => exportDialog({ id: d.id, data: d.rec }, d.engine) },
        ref ? null : { label: 'Use as a wiki page picture…', icon: 'book', onPick: async () => { await d.flush(); drawingToWikiDialog({ id: d.id, data: d.rec }, d.engine); } },
        ref ? null : { label: 'Use this drawing as a stamp…', icon: 'stamp', onPick: () => drawingAsStamp(d) },
        { label: 'Name, section and idea…', icon: 'edit', onPick: details },
        ref ? null : { label: 'Duplicate', icon: 'copy', onPick: async () => { await d.flush(); duplicateDrawing({ id: d.id, data: d.rec }, ctx.ui); } },
        { label: 'Close this tab', icon: 'close', onPick: () => closeTab(d.id) },
        { label: ref ? 'Delete this picture' : 'Delete this drawing', icon: 'trash', onPick: remove },
      ].filter(Boolean),
    });
  }
  function drawingAsStamp(d) {
    d.engine.finishPending();
    const e = d.engine;
    const pixel = d.rec.kind === 'pixel';
    let canvas = pixel ? e.exportCanvas(1) : e.canvas;
    // Trim the see-through space around it.
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    let x0 = canvas.width, y0 = canvas.height, x1 = -1, y1 = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (data[(y * canvas.width + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) { toast('The drawing is empty: nothing to make a stamp of.'); return; }
    const t = Object.assign(document.createElement('canvas'), { width: x1 - x0 + 1, height: y1 - y0 + 1 });
    t.getContext('2d').drawImage(canvas, -x0, -y0);
    saveStampDialog({ canvas: t, kind: pixel ? 'pixel' : 'free', scale: pixel ? 1 : e.scale, name: d.rec.name }).then(() => loadStamps());
  }

  async function details() {
    const d = activeDoc();
    if (!d) return;
    const changed = await detailsDialog({ id: d.id, data: d.rec }, ctx.model);
    if (!changed) return;
    d.rec = changed;
    layout();
  }
  async function swapColors() {
    const d = workDoc();
    if (!d) return;
    d.engine.finishPending();
    const r = await swapColorsDialog(d.engine, { pixel: d.rec.kind === 'pixel' });
    if (!r) return;
    if (r.copy) {
      await d.flush();
      await copyWithPicture({ id: d.id, data: d.rec }, ctx.ui, d.engine.canvas, data => swapData(data, r.map, r.similar), 'new colours');
      return;
    }
    d.engine.swapColors(r.map, r.similar);
    toast('Colours swapped. Undo brings the old ones back.');
  }
  async function grayscale() {
    const d = workDoc();
    if (!d) return;
    const how = await choiceDialog({
      title: 'Make it grayscale?',
      body: h('p', { text: `Every colour${d.engine.hasSelection ? ' in the selection' : ''} becomes the gray of the same brightness, like Minecraft textures that the game tints (grass, leaves).` }),
      choices: [{ id: 'copy', label: 'Make a gray copy' }, { id: 'here', label: 'Change this drawing', kind: 'primary' }],
    });
    if (how === 'here') { if (d.engine.grayscale()) toast('Grayscale. Undo brings the colours back.'); else toast('It has no colours to change.'); }
    if (how === 'copy') { await d.flush(); await copyWithPicture({ id: d.id, data: d.rec }, ctx.ui, d.engine.canvas, data => grayscaleData(data), 'gray'); }
  }
  async function remove() {
    const d = activeDoc();
    if (!d) return;
    const ok = d.isRef
      ? await confirmDialog({ title: `Delete “${d.rec.name}”?`, body: h('p', { text: 'The reference picture is deleted. Your drawings keep their colours.' }), confirm: 'Delete picture', danger: true })
      : await confirmDeleteDrawing({ id: d.id, data: d.rec });
    if (!ok) return;
    const rec = d.rec;
    await closeTab(d.id, {
      discard: true,
      after: async () => {
        try { await removeDrawing(d.id, rec); toast(`${d.isRef ? 'Picture' : 'Drawing'} deleted. Push to remove it from GitHub too.`); }
        catch (err) { errorDialog(err, "It couldn't be deleted"); }
      },
    });
  }

  /* ---------- Keys (PC) ---------- */

  const textField = el => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color', 'file', 'submit'].includes(el.type)));
  const onKey = e => {
    if (document.querySelector('dialog[open]')) return;
    if (e.type === 'keyup') { if (e.code === 'Space') { spaceDown = false; root.classList.remove('is-space'); } return; }
    const el = document.activeElement;
    if (textField(el)) return;
    const d = activeDoc();
    const eng = d && !d.isRef ? d.engine : null;
    const mod = e.ctrlKey || e.metaKey;
    const key = String(e.key || '').toLowerCase();
    if (mod && (e.code === 'KeyZ' || key === 'z')) { e.preventDefault(); if (e.shiftKey) d?.redo(); else d?.undo(); drawSelBar(); return; }
    if (mod && (e.code === 'KeyY' || key === 'y')) { e.preventDefault(); d?.redo(); return; }
    if (mod && eng) {
      if (e.code === 'KeyA') { e.preventDefault(); eng.selectAll(); afterChange(d); return; }
      if (e.code === 'KeyD') { e.preventDefault(); eng.deselect(); afterChange(d); return; }
      if (e.code === 'KeyC') { e.preventDefault(); copySel(d); return; }
      if (e.code === 'KeyX') { e.preventDefault(); cutSel(d); return; }
      // Ctrl+V comes in as a "paste" event (which also brings pictures from outside).
      return;
    }
    if (e.altKey || el?.tagName === 'SELECT') return;
    if (e.code === 'Space') { spaceDown = true; root.classList.add('is-space'); e.preventDefault(); return; }
    if (e.key === 'Escape') {
      if (eng?.floating) { eng.cancelFloat(); afterChange(d); return; }
      if (eng?.polygon) { eng.polyCancel(); d.drawOverlay(); drawOptions(); return; }
      if (d?.busy) { d.cancelStroke(); return; }
      if (eng?.hasSelection) { eng.deselect(); afterChange(d); }
      return;
    }
    if (e.key === 'Enter' && eng) {
      if (eng.floating) { e.preventDefault(); commitFloat(d); return; }
      if (eng.polygon) { e.preventDefault(); finishPolygon(); return; }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && eng) {
      if (eng.polygon) { e.preventDefault(); eng.polyBack(); d.drawOverlay(); drawOptions(); return; }
      if (eng.hasSelection) { e.preventDefault(); eng.clearSelected(); afterChange(d); return; }
    }
    if (e.key.startsWith('Arrow') && eng?.hasSelection) {
      e.preventDefault();
      if (!eng.floating) eng.lift({ mode: d.st.mode });
      const n = e.shiftKey ? 10 : 1;
      eng.nudgeFloat(e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0, e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0);
      afterChange(d);
      return;
    }
    if (e.shiftKey && eng?.hasSelection && (e.code === 'KeyH' || e.code === 'KeyV')) { transform(d, f => f.flipFloat(e.code === 'KeyH')); return; }
    if (e.code === 'KeyX') { swapPair(); return; }
    const tl = TOOLS.find(x => x.code === e.code);
    if (tl) { setTool(tl.id); return; }
    if (e.code === 'KeyP') { setMode(penMode() === 'pixel' ? 'free' : 'pixel'); return; }
    if (e.code === 'KeyF') { d?.fit(); return; }
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      const up = e.code === 'BracketRight';
      if (penMode() === 'pixel') prefs.pixelSize = Math.max(1, Math.min(16, prefs.pixelSize + (up ? 1 : -1)));
      else prefs.freeSize = Math.max(1, Math.min(freeMax(), Math.round(prefs.freeSize * (up ? 1.25 : 0.8)) + (up ? 1 : 0)));
      savePrefs(); drawOptions(); redrawOverlays();
    }
  };
  /** Ctrl+V: a picture copied on the computer, or what was copied here. */
  const onPaste = e => {
    if (document.querySelector('dialog[open]') || textField(document.activeElement)) return;
    const d = workDoc();
    if (!d) return;
    const file = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
    e.preventDefault();
    if (file) pastePicture(d, file);
    else if (clip) pasteInto(d);
    else toast('Nothing to paste yet: copy part of a drawing first.');
  };
  const onResize = () => { if (mounted) { drawTools(); if (tabs.split && splitShown()) layout(); } };

  /* ---------- Showing the workspace ---------- */

  return {
    show(el, c, id) {
      ctx = c;
      for (const x of [...tabs.open]) if (!ctx.drawings.get(x)) dropTab(x);   // deleted, here or by a Pull
      if (ctx.drawings.get(id)) {
        if (!tabs.open.includes(id)) tabs.open.push(id);
        if (tabs.active !== id) { prevActive = tabs.active; tabs.active = id; }
      }
      saveTabs();
      if (!tabs.active) {
        clear(el, h('div', { class: 'notice' }, h('p', { text: "This drawing doesn't exist (anymore)." }),
          h('a', { class: 'btn btn-small', href: '#/ideas/d/all' }, 'All drawings')));
        return null;
      }
      mounted = true;
      shownKey = '';
      clear(el, root);
      document.body.classList.add('dr-open');
      document.addEventListener('keydown', onKey);
      document.addEventListener('keyup', onKey);
      document.addEventListener('paste', onPaste);
      addEventListener('resize', onResize);
      drawRecent();
      loadRowPalette();
      loadStamps();
      pal?.reload();
      layout();
      if (!ctx.drawings.get(id)) { toast("That drawing doesn't exist (anymore)."); syncHash(); }
      // Pick up changes made elsewhere since last time (a Pull, Undo in Check your changes).
      Promise.all([...docs.values()].map(async d => ({ d, ok: await d.checkFresh() }))).then(res => {
        for (const { d, ok } of res) if (!ok) closeTab(d.id, { discard: true });
        if (mounted) drawTabs();
      });

      const cleanup = async () => {
        mounted = false;
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('keyup', onKey);
        document.removeEventListener('paste', onPaste);
        removeEventListener('resize', onResize);
        document.body.classList.remove('dr-open');
        closePopup();
        spaceDown = false;
        root.remove();
        await Promise.all([...docs.values()].map(d => d.flush()));
      };
      /** #/ideas/draw/<id> while the workspace is showing: open that tab in place. */
      cleanup.reroute = path => {
        const m = /^draw\/(.+)$/.exec(path || '');
        if (!m || !mounted) return false;
        open(decodeURIComponent(m[1]));
        return true;
      };
      return cleanup;
    },
  };
}
