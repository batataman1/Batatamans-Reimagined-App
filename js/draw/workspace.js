// The drawing workspace (#/ideas/draw/<id>).
//
// Every drawing (or reference picture) you open stays open as a tab at the top, like Chrome's
// tabs, until you close it with its ×, also after going back to the gallery or to another part
// of the app (open drawings keep their Undo). Long-press a tab (or drag it with the mouse) to
// move it along the row, or drag it down into the picture area to show two tabs at once (split
// screen). Drag the border between them to change the sizes; its handle swaps the sides, turns
// the split, or closes it. Tools, options and colours are shared: pick a colour in one half and
// draw with it in the other.

import { h, clear } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { choiceDialog, confirmDialog, errorDialog, toast } from '../ui/dialogs.js';
import { openPopup, closePopup } from '../wiki/popup.js';
import { getIdeas } from '../ideas/model.js';
import { swapData, grayscaleData } from './engine.js';
import { createDoc } from './doc.js';
import { colorPicker, palettePanel, pickColorDialog, swapColorsDialog, currentPaletteColors } from './colors.js';
import { getDrawings, normHex, removeDrawing, importReference } from './model.js';
import { detailsDialog, exportDialog, duplicateDrawing, confirmDeleteDrawing, copyWithPicture, newDrawingDialog, thumbCanvas } from './gallery.js';
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
  { id: 'line', label: 'Line', key: 'L', code: 'KeyL' },
  { id: 'rect', label: 'Rectangle', key: 'R', code: 'KeyR' },
  { id: 'ellipse', label: 'Ellipse', key: 'O', code: 'KeyO' },
];
const toolIcon = (id, mode) => (id === 'pen' ? (mode === 'pixel' ? 'pencil' : 'brush') : id === 'picker' ? 'dropper' : id === 'fill' ? 'bucket' : id);
const MIRRORS = { none: 'Off', x: 'Left and right', y: 'Top and bottom', xy: 'All four corners' };
const isPhone = () => matchMedia('(max-width: 759px)').matches;

function loadPrefs() {
  const p = {
    tool: 'pen', pixelSize: 1, freeSize: 11, opacity: 1, soft: false, filled: false, fillAll: false,
    pixelPerfect: true, eraseTap: false, eraseAll: false, color: '#000000', recent: [],
  };
  try { Object.assign(p, JSON.parse(localStorage.getItem(PREFS) || '{}')); } catch { /* ignore */ }
  if (!TOOLS.some(t => t.id === p.tool)) p.tool = 'pen';
  if (!normHex(p.color)) p.color = '#000000';
  if (!Array.isArray(p.recent)) p.recent = [];
  if (!(p.freeSize > 0)) p.freeSize = 11;
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

  /* ---------- What's open ---------- */

  const activeDoc = () => docs.get(tabs.active) || null;
  const recOf = id => docs.get(id)?.rec || ctx.drawings.get(id)?.data || null;
  const splitShown = () => !!tabs.split && (tabs.split.a === tabs.active || tabs.split.b === tabs.active);
  const shownIds = () => (splitShown() ? [tabs.split.a, tabs.split.b] : tabs.active ? [tabs.active] : []);
  /** The drawing the colour tools work on: the active one, or the drawing next to a reference. */
  const drawingDoc = () => shownIds().map(id => docs.get(id)).find(d => d && !d.isRef && d.id === tabs.active)
    || shownIds().map(id => docs.get(id)).find(d => d && !d.isRef) || null;
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
  const panes = h('div', { class: 'dr-panes' });
  const side = h('aside', { class: 'dr-side' });
  const colorsRow = h('div', { class: 'dr-colors' });
  const dropZones = [h('div', { class: 'dr-drop-zone' }), h('div', { class: 'dr-drop-zone' })];
  const dropEl = h('div', { class: 'dr-drop', hidden: true }, dropZones);
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, class: 'dr-file' });
  const root = h('div', { class: 'dr' }, tabbar, topEl, toolsEl, optsEl, panes, side, colorsRow, dropEl, fileInput);

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

  /* ---------- What documents tell the workspace ---------- */

  const api = {
    prefs,
    get spaceDown() { return spaceDown; },
    statusChanged(doc) { if (doc.id === tabs.active) statusEl.textContent = doc.status; },
    changed(doc) { if (doc.id === tabs.active) drawUndo(); thumbSoon(doc.id); },
    viewChanged(doc) { if (doc.id === tabs.active) zoomText.textContent = doc.zoomText; },
    activate(doc) { if (doc.id !== tabs.active) activate(doc.id); },
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
      if (prefs.tool === 'eraser' && prefs.eraseTap) {
        // The tap eraser: a fill with nothing (see-through).
        return { tool: 'fill', mode: doc.st.mode, color: '#000000', opacity: 0, fillAll: prefs.eraseAll, symmetry: doc.st.mirror };
      }
      return {
        tool: prefs.tool, mode: doc.st.mode, color: prefs.color, opacity: prefs.opacity,
        size: doc.st.mode === 'pixel' ? prefs.pixelSize : prefs.freeSize,
        soft: prefs.soft, filled: prefs.filled, fillAll: prefs.fillAll,
        pixelPerfect: prefs.tool === 'pen' && prefs.pixelPerfect, symmetry: doc.st.mirror,
      };
    },
    brushOutline() {
      const t = prefs.tool;
      return t === 'pen' || (t === 'eraser' && !prefs.eraseTap) || ['line', 'rect', 'ellipse'].includes(t)
        ? { pixelSize: prefs.pixelSize, freeSize: prefs.freeSize } : null;
    },
    closeMenus: () => closePopup(),
  };

  /* ---------- Tools and options ---------- */

  function setTool(id) {
    if (id === 'picker' && prefs.tool !== 'picker') prevTool = prefs.tool;
    prefs.tool = id;
    savePrefs();
    drawTools();
    drawOptions();
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

  function drawTools() {
    const mode = penMode();
    clear(toolsEl, TOOLS.map(tl => {
      const label = tl.id === 'pen' ? (mode === 'pixel' ? 'Pixel pen' : 'Free pen') : tl.label;
      return h('button', {
        type: 'button', class: 'dr-tool', 'aria-pressed': String(prefs.tool === tl.id), dataset: { tool: tl.id },
        'aria-label': label, title: `${label} (${tl.key})`, onclick: () => setTool(tl.id),
      }, icon(toolIcon(tl.id, mode), { size: 22 }));
    }));
  }

  const seg = (name, options, value, onPick) => h('div', { class: 'seg dr-seg', role: 'group', 'aria-label': name },
    options.map(([v, label, ic]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': String(value === v), dataset: { value: v },
      onclick: () => onPick(v),
    }, ic ? icon(ic, { size: 14 }) : null, label)));
  const freeMax = () => { const d = drawingDoc(); return Math.max(8, Math.round(Math.max(d?.engine.W || 1024, d?.engine.H || 1024) / 4)); };
  const sizeToSlider = s => Math.round((Math.log(Math.max(1, s)) / Math.log(freeMax())) * 100);
  const sliderToSize = v => Math.max(1, Math.round(Math.exp((v / 100) * Math.log(freeMax()))));
  function slider(label, { min, max, value, show, onInput, name }) {
    const out = h('span', { class: 'dr-slider-value', text: show(value) });
    const input = h('input', { type: 'range', min, max, step: 1, value, name, 'aria-label': label });
    input.addEventListener('input', () => { out.textContent = show(+input.value); onInput(+input.value); });
    return h('label', { class: 'dr-slider' }, h('span', { class: 'dr-slider-label', text: label }), input, out);
  }
  const redrawOverlays = () => { for (const id of shownIds()) docs.get(id)?.drawOverlay(); };

  function drawOptions() {
    const tl = prefs.tool;
    const a = activeDoc();
    if (a?.isRef) {
      clear(optsEl, h('span', { class: 'muted small dr-hint', text: 'Reference picture: tap it to pick a colour. Drag to move it, pinch or scroll to zoom.' }));
      return;
    }
    const mode = penMode();
    const parts = [seg('Pen', [['pixel', 'Pixel', 'pencil'], ['free', 'Free', 'brush']], mode, setMode)];
    const tapErase = tl === 'eraser' && prefs.eraseTap;
    if (tl === 'picker') {
      parts.push(h('span', { class: 'muted small dr-hint', text: 'Tap a picture to pick up a colour (the other half of a split screen works too).' }));
    } else {
      if (tl === 'eraser') parts.push(seg('Eraser', [[false, 'Brush'], [true, 'Tap a colour']], prefs.eraseTap, v => { prefs.eraseTap = v; savePrefs(); drawOptions(); redrawOverlays(); }));
      if (tapErase) {
        parts.push(seg('Erase', [[false, 'Connected'], [true, 'Everywhere']], prefs.eraseAll, v => { prefs.eraseAll = v; savePrefs(); drawOptions(); }));
        parts.push(h('span', { class: 'muted small dr-hint', text: prefs.eraseAll ? 'Tap a colour: it goes everywhere.' : 'Tap a colour: the area of that colour it touches goes.' }));
      } else if (tl !== 'fill') {
        parts.push(mode === 'pixel'
          ? slider('Size', { name: 'size', min: 1, max: 16, value: prefs.pixelSize, show: v => `${v}`, onInput: v => { prefs.pixelSize = v; savePrefs(); } })
          : slider('Size', { name: 'size', min: 0, max: 100, value: sizeToSlider(prefs.freeSize), show: v => `${sliderToSize(v)}`, onInput: v => { prefs.freeSize = sliderToSize(v); savePrefs(); } }));
      }
      if (tl !== 'eraser') {
        parts.push(slider('Opacity', { name: 'opacity', min: 5, max: 100, value: Math.round(prefs.opacity * 100), show: v => `${v}%`, onInput: v => { prefs.opacity = v / 100; savePrefs(); } }));
      }
      if ((tl === 'pen' || (tl === 'eraser' && !tapErase)) && mode === 'free') parts.push(seg('Brush', [[false, 'Hard'], [true, 'Soft']], prefs.soft, v => { prefs.soft = v; savePrefs(); drawOptions(); }));
      if (tl === 'pen' && mode === 'pixel') {
        parts.push(h('label', { class: 'dr-check', title: 'Keeps lines one square thin: no extra squares in the corners' },
          h('input', { type: 'checkbox', name: 'pixelPerfect', checked: prefs.pixelPerfect, onchange: e => { prefs.pixelPerfect = e.target.checked; savePrefs(); } }), 'Pixel-perfect'));
      }
      if (tl === 'rect' || tl === 'ellipse') parts.push(seg('Shape', [[false, 'Outline'], [true, 'Filled']], prefs.filled, v => { prefs.filled = v; savePrefs(); drawOptions(); }));
      if (tl === 'fill') parts.push(seg('Fill', [[false, 'Connected'], [true, 'Everywhere']], prefs.fillAll, v => { prefs.fillAll = v; savePrefs(); drawOptions(); }));
    }
    clear(optsEl, parts);
  }

  /* ---------- Colours: a side panel on a PC, a row with a colour button on a phone ---------- */

  const drawingColors = () => drawingDoc()?.engine.paletteColors() || [];
  let picker = null, pal = null;
  const recentPC = h('div', { class: 'dr-recent', 'aria-label': 'Recent colours' });
  const swatch = (c, label) => h('button', { type: 'button', class: 'pal-sw', style: { '--c': c }, title: c, 'aria-label': `${label} ${c}`, dataset: { color: c }, onclick: () => setColor(c) });
  function setColor(hex) {
    hex = normHex(hex);
    if (!hex) return;
    prefs.color = hex;
    savePrefs();
    picker?.set(hex);
    drawColors();
  }
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
  buildSide();
  store.on(e => { if (mounted && (e?.type === 'sync' || e?.collection === 'palettes')) loadRowPalette(); });

  /* ---------- Top bar ---------- */

  const zoomText = h('span', { class: 'dr-zoom muted small' });
  const statusEl = h('span', { class: 'dr-status muted small', role: 'status' });
  const nameBtn = h('button', { type: 'button', class: 'dr-name', title: 'Name, section and idea', onclick: () => details() });
  const undoBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Undo', title: 'Undo (Ctrl+Z)', onclick: () => activeDoc()?.undo() }, icon('undo', { size: 20 }));
  const redoBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Redo', title: 'Redo (Ctrl+Y)', onclick: () => activeDoc()?.redo() }, icon('redo', { size: 20 }));
  function drawUndo() { const d = activeDoc(); undoBtn.disabled = !d?.canUndo(); redoBtn.disabled = !d?.canRedo(); }
  const toggle = (label, ic, on, fn, cls = '') => h('button', { type: 'button', class: `icon-btn dr-toggle ${cls}`, 'aria-label': label, title: label, 'aria-pressed': String(!!on), onclick: fn }, icon(ic, { size: 20 }));
  function drawTop() {
    const d = activeDoc();
    if (!d) { clear(topEl); return; }
    nameBtn.textContent = d.rec.name;
    statusEl.textContent = d.status;
    zoomText.textContent = d.zoomText;
    const more = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'More', title: 'Split screen, swap colours, grayscale, export…', onclick: () => menu(more) }, '⋯');
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
          toggle('Tiles: see it repeated, for blocks', 'tiles', d.st.tiles, toggleTiles, 'dr-pc'),
          mirrorBtn,
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
      items: Object.entries(MIRRORS).map(([k, label]) => ({ label, hint: d.st.mirror === k ? '✓' : '', icon: k === 'none' ? 'close' : 'mirror', onPick: () => { d.setMirror(k); drawTop(); } })),
    });
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
        splitShown() ? { label: 'Swap sides', icon: 'swap', onPick: swapSides } : null,
        splitShown() ? { label: 'Close split screen', icon: 'close', onPick: closeSplit }
          : others.length ? { label: 'Split screen with…', icon: 'split', onPick: () => splitList(anchor) } : null,
        { label: 'Add a reference picture…', icon: 'image', onPick: () => addReference() },
        ref ? null : { label: 'Swap colours…', icon: 'swap', onPick: swapColors },
        ref ? null : { label: 'Make it grayscale…', icon: 'gray', onPick: grayscale },
        ref ? null : { label: 'Export PNG…', icon: 'download', onPick: () => exportDialog({ id: d.id, data: d.rec }, d.engine) },
        { label: 'Name, section and idea…', icon: 'edit', onPick: details },
        ref ? null : { label: 'Duplicate', icon: 'copy', onPick: async () => { await d.flush(); duplicateDrawing({ id: d.id, data: d.rec }, ctx.ui); } },
        { label: 'Close this tab', icon: 'close', onPick: () => closeTab(d.id) },
        { label: ref ? 'Delete this picture' : 'Delete this drawing', icon: 'trash', onPick: remove },
      ].filter(Boolean),
    });
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
    const d = activeDoc();
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
    const d = activeDoc();
    const how = await choiceDialog({
      title: 'Make it grayscale?',
      body: h('p', { text: 'Every colour becomes the gray of the same brightness, like Minecraft textures that the game tints (grass, leaves).' }),
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
    const mod = e.ctrlKey || e.metaKey;
    const key = String(e.key || '').toLowerCase();
    if (mod && (e.code === 'KeyZ' || key === 'z')) { e.preventDefault(); if (e.shiftKey) d?.redo(); else d?.undo(); return; }
    if (mod && (e.code === 'KeyY' || key === 'y')) { e.preventDefault(); d?.redo(); return; }
    if (mod || e.altKey || el?.tagName === 'SELECT') return;
    if (e.code === 'Space') { spaceDown = true; root.classList.add('is-space'); e.preventDefault(); return; }
    if (e.key === 'Escape') { d?.cancelStroke(); return; }
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
  const onResize = () => { if (mounted && tabs.split && splitShown()) layout(); };

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
      addEventListener('resize', onResize);
      drawRecent();
      loadRowPalette();
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
