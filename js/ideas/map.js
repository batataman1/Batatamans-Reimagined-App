// The mind map (#/ideas/m/<all | none | section id>), part 2c Ideas step 2.
//
// How it's touched (the user's design, 2026-11-27):
// - Drag empty space to move around; pinch, the mouse wheel or the − / + buttons to zoom; Fit
//   shows the whole map.
// - Tap/click a bubble to select it; dragging a bubble moves only that bubble.
// - Long-press a bubble: select mode. Tap bubbles to add or remove them; dragging one of the
//   selected bubbles moves them all. "Select everything in this branch" adds the last tapped
//   bubble and everything below it. (On PC, Shift/Ctrl-click also adds to the selection.)
// - Every bubble has a ⋯ button with its menu (open the idea page, add below, size, fold,
//   connections, change main bubble, make a task, delete).
// - Bubbles with ideas below have a small fold button ("+N" when folded). Folding is shared
//   with the list and remembered on this device.
// - Solid lines go to the main bubble; dashed lines are connections you draw.
// - Undo takes back the last map changes (moves, Tidy up, sizes, connections, main bubbles).
// Places, sizes and connections are saved on the ideas (and sections) and sync; zoom, the
// view and folding stay on this device.

import { h, clear, plural } from '../core/util.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { confirmDialog, errorDialog, toast } from '../ui/dialogs.js';
import { openPopup, closePopup } from '../wiki/popup.js';
import { nameDialog } from '../tasks/views.js';
import { createIdea, storableIdea, SIZE_NAMES } from './model.js';
import { worldTree, centerOf, placeAll, tidyLayout, freeSpot, branchNodes, foldId, nextSize, radiusOf, SIZE_STYLE } from './layout.js';
import { confirmDeleteIdea, removeIdea, makeTaskDialog, moveIdeaTo } from './actions.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const ZOOM_MIN = 0.2, ZOOM_MAX = 3;
const LONG_PRESS = 500;

/** Map state kept while the Ideas tab is open (not saved). */
export function mapState() {
  return { key: null, selected: new Set(), selectMode: false, pending: null, last: null, undo: [] };
}

/**
 * Builds the map for `key` ("all", "none" or a section id). Returns { el, mounted, cleanup }:
 * call mounted() once el is on the page (it sizes the map and fits it the first time).
 */
export function mapScreen(ctx, key) {
  const { model, tasks, ui } = ctx;
  const st = ui.mm;
  if (st.key !== key) Object.assign(st, { key, selected: new Set(), selectMode: false, pending: null, last: null });

  const world = worldTree(model);
  const center = centerOf(world, key);
  if (!center) return null;
  const pos = placeAll(world, ui.prefs.nonePos);
  for (const k of [...st.selected]) if (!world.get(k) || k === 'root') st.selected.delete(k);

  /* Which bubbles show: the centre and everything below it, except under folded bubbles */
  const visible = [];
  const walk = (n, isCenter) => {
    visible.push(n);
    if (!isCenter && ui.isFolded(foldId(n))) return;
    n.children.forEach(k => walk(k, false));
  };
  walk(center, true);
  const shown = new Set(visible.map(n => n.key));

  /* The view (zoom and position), remembered per map on this device */
  ui.prefs.mapViews ||= {};
  let view = ui.prefs.mapViews[key] ? { ...ui.prefs.mapViews[key] } : null;
  let saveTimer = null, forgetView = false;
  const keepView = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { ui.prefs.mapViews[key] = { ...view }; ui.savePrefs(); }, 300);
  };

  /* ---------- Drawing ---------- */

  const lines = svg('svg', { class: 'mm-lines', width: 1, height: 1, 'aria-hidden': 'true' });
  const worldEl = h('div', { class: 'mm-world' }, lines);
  const bubbles = new Map();
  const viewport = h('div', { class: 'mm-view', role: 'application', 'aria-label': 'Mind map' }, worldEl);
  const barHost = h('div', { class: 'mm-bar-host' });
  const tools = h('div', { class: 'mm-tools' });
  const el = h('div', { class: 'mm' }, tools, viewport, barHost);

  const tasksOf = n => (n.kind === 'idea' ? tasks.linkedTo('ideas', n.id) : []);

  for (const n of visible) {
    const p = pos.get(n.key);
    const folded = n !== center && n.children.length > 0 && ui.isFolded(foldId(n));
    const made = tasksOf(n);
    const done = made.length > 0 && made.every(t => t.data.status === 'done');
    const more = h('button', {
      type: 'button', class: 'mm-more', 'aria-label': `More for ${n.label}`, title: 'Menu',
      onclick: e => { e.stopPropagation(); bubbleMenu(n, more); },
    }, '⋯');
    const fold = n !== center && n.children.length ? h('button', {
      type: 'button', class: 'mm-fold', 'aria-expanded': String(!folded),
      'aria-label': `${folded ? 'Show' : 'Hide'} what's below ${n.label}`, title: folded ? 'Show what is below' : 'Fold away what is below',
      onclick: e => { e.stopPropagation(); ui.toggleFold(foldId(n)); },
    }, folded ? `+${branchNodes(n).length - 1}` : '−') : null;
    const b = h('div', {
      class: `mm-b mm-${n.kind} size-${n.size || 'm'}${n === center ? ' mm-center' : ''}`,
      dataset: { key: n.key },
    },
      h('span', { class: 'mm-text', text: n.label }),
      made.length ? h('span', { class: `mm-task${done ? ' done' : ''}`, title: done ? 'Made into a task (done)' : 'Made into a task' }, icon('tasks', { size: 12 })) : null,
      n.kind === 'root' ? null : more,
      fold);
    b.style.left = `${p.x}px`;
    b.style.top = `${p.y}px`;
    bubbles.set(n.key, b);
    worldEl.append(b);
  }

  function drawLines() {
    clear(lines);
    for (const n of visible) {
      if (n === center || !n.parent || !shown.has(n.parent.key)) continue;
      const a = pos.get(n.parent.key), b = pos.get(n.key);
      lines.append(svg('line', { class: 'mm-line', x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
    }
    for (const n of visible) {
      if (n.kind !== 'idea') continue;
      for (const c of n.idea.data.connections) {
        const other = world.get(`i:${c}`);
        if (!other || !shown.has(other.key)) continue;
        const a = pos.get(n.key), b = pos.get(other.key);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const bend = 0.18;
        const cx = mx - (b.y - a.y) * bend, cy = my + (b.x - a.x) * bend;
        lines.append(svg('path', { class: 'mm-link', d: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}` }));
      }
    }
  }
  drawLines();

  const applyView = () => { worldEl.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`; };
  function fit() {
    const r = viewport.getBoundingClientRect();
    if (!r.width || !r.height) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of visible) {
      const p = pos.get(n.key);
      const w = (SIZE_STYLE[n.size] || SIZE_STYLE.m).width / 2 + 10, hh = radiusOf(n) * 0.6;
      x0 = Math.min(x0, p.x - w); x1 = Math.max(x1, p.x + w); y0 = Math.min(y0, p.y - hh); y1 = Math.max(y1, p.y + hh);
    }
    const k = Math.max(ZOOM_MIN, Math.min(1.1, (r.width - 32) / (x1 - x0), (r.height - 32) / (y1 - y0)));
    view = { k, tx: r.width / 2 - ((x0 + x1) / 2) * k, ty: r.height / 2 - ((y0 + y1) / 2) * k };
    forgetView = false;
    applyView();
    keepView();
  }
  function zoomAt(f, cx, cy) {
    const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.k * f));
    view = { k, tx: cx - ((cx - view.tx) * k) / view.k, ty: cy - ((cy - view.ty) * k) / view.k };
    applyView();
    keepView();
  }
  const zoomMiddle = f => { const r = viewport.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); };

  /* ---------- The bars: tools on top, select mode / "tap a bubble" at the bottom ---------- */

  const tool = (label, ic, onclick, opts = {}) => h('button', {
    type: 'button', class: `btn btn-small mm-tool${opts.text ? '' : ' mm-tool-icon'}`, 'aria-label': label, title: label, onclick, disabled: opts.disabled || null,
  }, ic ? icon(ic, { size: 16 }) : null, opts.text ? h('span', { text: opts.text }) : null);

  function drawBars() {
    for (const [k, b] of bubbles) {
      b.classList.toggle('is-sel', st.selected.has(k));
      b.classList.toggle('is-src', st.pending?.key === k);
    }
    viewport.classList.toggle('is-picking', !!st.pending);
    clear(tools,
      tool('Undo', 'undo', undo, { text: 'Undo', disabled: !st.undo.length }),
      tool('Tidy up this map', 'sparkle', tidy, { text: 'Tidy up' }),
      h('span', { class: 'mm-tools-gap' }),
      tool('Zoom out', null, () => zoomMiddle(1 / 1.25), { text: '−' }),
      tool('Zoom in', null, () => zoomMiddle(1.25), { text: '+' }),
      tool('Fit the whole map', 'fit', fit, { text: 'Fit' }));
    if (st.pending) {
      const from = world.get(st.pending.key);
      clear(barHost, h('div', { class: 'mm-bar', role: 'status' },
        h('span', { class: 'mm-bar-text', text: st.pending.kind === 'connect' ? `Tap the bubble to connect “${from?.label}” to` : `Tap the new main bubble for “${from?.label}”` }),
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => { st.pending = null; drawBars(); } }, 'Cancel')));
    } else if (st.selectMode) {
      const last = st.last && world.get(st.last);
      clear(barHost, h('div', { class: 'mm-bar', role: 'status' },
        h('span', { class: 'mm-bar-text', text: st.selected.size ? `${plural(st.selected.size, 'bubble')} selected. Drag one to move them all.` : 'Tap bubbles to select them.' }),
        h('span', { class: 'mm-bar-actions' },
          last && last.children.length ? h('button', {
            type: 'button', class: 'btn btn-small',
            onclick: () => { for (const x of branchNodes(last)) if (x.kind !== 'root') st.selected.add(x.key); drawBars(); },
          }, `Select everything in this branch`) : null,
          st.selected.size ? h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => { st.selected.clear(); drawBars(); } }, 'Clear') : null,
          h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => { st.selectMode = false; st.selected.clear(); drawBars(); } }, 'Done'))));
    } else {
      clear(barHost);
    }
  }
  drawBars();

  /* ---------- Saving (with Undo) ---------- */

  async function snapshot(nodes) {
    const items = [];
    for (const n of nodes) {
      if (n.kind === 'idea') items.push({ collection: 'ideas', id: n.id, data: (await store.get('ideas', n.id))?.data });
      else if (n.kind === 'section') items.push({ collection: 'sections', id: n.id, data: (await store.get('sections', n.id))?.data });
      else if (n.kind === 'none') items.push({ none: true, data: ui.prefs.nonePos || null });
    }
    return items;
  }
  function remember(label, items) {
    st.undo.push({ label, items });
    if (st.undo.length > 30) st.undo.shift();
  }
  async function undo() {
    const op = st.undo.pop();
    if (!op) return;
    try {
      for (const it of op.items) {
        if (it.none) { ui.prefs.nonePos = it.data; ui.savePrefs(); }
        else if (it.data) await store.put(it.collection, it.id, it.data);
      }
      toast(`Undone: ${op.label}.`);
      if (op.items.every(it => it.none)) ui.redraw();
    } catch (err) { errorDialog(err, "That couldn't be undone"); }
    drawBars();
  }
  async function writeIdea(id, change) {
    const row = await store.get('ideas', id);
    if (row) await store.put('ideas', id, storableIdea({ ...row.data, ...change }));
  }
  async function writeSection(id, change) {
    const row = await store.get('sections', id);
    if (!row) return;
    const data = { ...row.data, ...change };
    if (data.size === 'l') delete data.size;
    await store.put('sections', id, data);
  }
  async function writePlace(n, p) {
    const at = { x: Math.round(p.x), y: Math.round(p.y) };
    if (n.kind === 'idea') await writeIdea(n.id, { map: at });
    else if (n.kind === 'section') await writeSection(n.id, { map: at });
    else if (n.kind === 'none') { ui.prefs.nonePos = at; ui.savePrefs(); }
  }
  /** Save the places of moved bubbles. Bubbles right below them that were placed automatically
   *  are pinned where they are, so they don't follow (only the moved bubbles move). */
  async function savePlaces(nodes, label) {
    const all = new Set(nodes);
    for (const n of nodes) for (const c of n.children) if (!c.saved && c.kind !== 'none') all.add(c);
    const list = [...all].filter(n => n.kind !== 'root');
    try {
      remember(label, await snapshot(list));
      for (const n of list) await writePlace(n, pos.get(n.key));
      if (list.every(n => n.kind === 'none')) ui.redraw();
    } catch (err) { errorDialog(err, "The new places couldn't be saved"); }
  }

  async function tidy() {
    const ok = await confirmDialog({
      title: 'Tidy up this map?',
      body: h('p', { text: 'Every bubble on it gets a new, neat place around the middle. Undo puts them back.' }),
      confirm: 'Tidy up',
    });
    if (!ok) return;
    const places = tidyLayout(center, pos.get(center.key));
    const list = [...places.keys()].map(k => world.get(k)).filter(n => n.kind !== 'root');
    try {
      remember('Tidy up', await snapshot(list));
      // Fit the tidied map when it's drawn again.
      forgetView = true;
      clearTimeout(saveTimer);
      delete ui.prefs.mapViews[key];
      ui.savePrefs();
      for (const n of list) await writePlace(n, places.get(n.key));
      ui.redraw();
    } catch (err) { errorDialog(err, "The map couldn't be tidied"); }
  }

  /* ---------- Bubble menus ---------- */

  function addBelow(n) {
    return nameDialog({
      title: n.kind === 'idea' ? `New idea below “${n.label}”` : `New idea in ${n.kind === 'root' ? 'Not sorted' : n.label}`,
      label: 'Idea', confirm: 'Add idea', placeholder: 'For example: Termites eat wooden doors', maxLength: 200,
      onSave: async title => {
        const spot = freeSpot(n, pos);
        if (n.kind === 'idea') await createIdea({ title, section: model.sectionOf(n.idea), parent: n.id, map: spot });
        else await createIdea({ title, section: n.kind === 'section' ? n.id : null, map: spot });
        ui.unfold(foldId(n));
      },
    });
  }
  async function setSize(n, size) {
    try {
      remember('Bubble size', await snapshot([n]));
      if (n.kind === 'idea') await writeIdea(n.id, { size });
      else await writeSection(n.id, { size });
    } catch (err) { errorDialog(err, "The size couldn't be saved"); }
  }
  function connectionsOf(n) {
    const out = n.idea.data.connections.filter(c => model.get(c)).map(c => ({ from: n.id, to: c, other: c }));
    for (const i of model.ideas.values()) {
      if (i.id !== n.id && i.data.connections.includes(n.id)) out.push({ from: i.id, to: n.id, other: i.id });
    }
    return out;
  }
  async function removeConnection(c) {
    const from = world.get(`i:${c.from}`);
    try {
      remember('Remove a connection', await snapshot([from]));
      await writeIdea(c.from, { connections: from.idea.data.connections.filter(x => x !== c.to) });
      toast('Connection removed.');
    } catch (err) { errorDialog(err, "The connection couldn't be removed"); }
  }

  function bubbleMenu(n, anchor) {
    const rect = anchor.getBoundingClientRect();
    const canFold = n !== center && n.children.length > 0;
    const folded = canFold && ui.isFolded(foldId(n));
    const sizeItems = [
      n.size !== 'xl' ? { label: 'Bigger', icon: 'plus', hint: SIZE_NAMES[nextSize(n.size, 1)], onPick: () => setSize(n, nextSize(n.size, 1)) } : null,
      n.size !== 's' ? { label: 'Smaller', hint: SIZE_NAMES[nextSize(n.size, -1)], onPick: () => setSize(n, nextSize(n.size, -1)) } : null,
    ];
    const foldItem = canFold ? { label: folded ? 'Unfold' : 'Fold', hint: folded ? `${plural(branchNodes(n).length - 1, 'bubble')}` : null, onPick: () => ui.toggleFold(foldId(n)) } : null;
    let items;
    if (n.kind === 'idea') {
      const conns = connectionsOf(n);
      items = [
        { label: 'Open the idea page', icon: 'edit', onPick: () => ui.go(`i/${n.id}`) },
        { label: 'Add an idea below', icon: 'plus', onPick: () => addBelow(n) },
        ...sizeItems, foldItem,
        { label: 'Draw a connection', icon: 'idea', onPick: () => { st.pending = { kind: 'connect', key: n.key }; st.selectMode = false; drawBars(); } },
        conns.length ? {
          label: 'Remove a connection', icon: 'close',
          onPick: () => {
            if (conns.length === 1) { removeConnection(conns[0]); return; }
            openPopup({
              rect, title: 'Remove the connection with',
              items: conns.map(c => ({ label: model.get(c.other)?.data.title || '(no title)', onPick: () => removeConnection(c) })),
            });
          },
        } : null,
        { label: 'Change main bubble', icon: 'back', onPick: () => { st.pending = { kind: 'parent', key: n.key }; st.selectMode = false; drawBars(); } },
        { label: 'Make a task', icon: 'tasks', onPick: () => makeTaskDialog(n.idea) },
        {
          label: 'Delete', icon: 'trash',
          onPick: async () => {
            if (!(await confirmDeleteIdea(model, n.idea))) return;
            try { await removeIdea(model, n.id, n.idea.data); } catch (err) { errorDialog(err, "The idea couldn't be deleted"); return; }
            toast('Deleted. Push to remove it from GitHub too.');
          },
        },
      ];
    } else {
      const k = n.kind === 'section' ? n.id : 'none';
      items = [
        n.kind === 'root' ? null : { label: 'Show as a list', icon: 'tasks', onPick: () => ui.go(`s/${k}`) },
        n !== center && n.kind !== 'root' ? { label: 'Open its own map', icon: 'mindmap', onPick: () => ui.go(`m/${k}`) } : null,
        { label: 'Add an idea here', icon: 'plus', onPick: () => addBelow(n) },
        ...(n.kind === 'section' ? sizeItems : []), foldItem,
      ];
    }
    openPopup({ rect, title: n.label, items: items.filter(Boolean) });
  }

  /* ---------- "Tap a bubble" modes ---------- */

  async function finishPending(n) {
    const p = st.pending;
    const from = world.get(p.key);
    if (!from) { st.pending = null; drawBars(); return; }
    if (p.kind === 'connect') {
      if (n.kind !== 'idea' || n === from) { toast('Tap another idea.'); return; }
      const joined = from.parent === n || n.parent === from
        || from.idea.data.connections.includes(n.id) || n.idea.data.connections.includes(from.id);
      st.pending = null;
      drawBars();
      if (joined) { toast('They are already joined by a line.'); return; }
      try {
        remember('Draw a connection', await snapshot([from]));
        await writeIdea(from.id, { connections: [...from.idea.data.connections, n.id] });
      } catch (err) { errorDialog(err, "The connection couldn't be saved"); }
      return;
    }
    // A new main bubble
    if (n.kind === 'root') { toast('Tap an idea or a section.'); return; }
    if (n === from || branchNodes(from).includes(n)) { toast("It can't go under itself or the ideas below it."); return; }
    st.pending = null;
    drawBars();
    if (from.parent === n) return;
    try {
      remember('Change main bubble', await snapshot([from]));
      const to = n.kind === 'idea' ? { kind: 'into', id: n.id } : { kind: 'section', key: n.kind === 'none' ? null : n.id };
      await moveIdeaTo(model, from.idea, to);
      ui.unfold(foldId(n));
    } catch (err) { errorDialog(err, "The main bubble couldn't be changed"); }
  }

  /* ---------- Touch, mouse and pen ---------- */

  const pts = new Map();
  let g = null;              // the gesture going on: pan, pinch or bubble
  const local = e => { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  function tap(n, add) {
    if (st.pending) { finishPending(n); return; }
    if (n.kind === 'root') { if (!st.selectMode) { st.selected.clear(); drawBars(); } return; }
    if (st.selectMode || add) {
      if (st.selected.has(n.key)) st.selected.delete(n.key); else st.selected.add(n.key);
    } else {
      st.selected = new Set([n.key]);
    }
    st.last = n.key;
    drawBars();
  }
  function longPress(gesture) {
    if (g !== gesture || gesture.moved) return;
    gesture.long = true;
    const n = world.get(gesture.key);
    if (!n || n.kind === 'root' || st.pending) return;
    if (!st.selectMode) { st.selectMode = true; st.selected = new Set(); }
    st.selected.add(n.key);
    st.last = n.key;
    navigator.vibrate?.(15);
    drawBars();
  }
  function moveBubbles(dx, dy) {
    for (const [k, start] of g.start) {
      const p = { x: start.x + dx / view.k, y: start.y + dy / view.k };
      pos.set(k, p);
      const b = bubbles.get(k);
      if (b) { b.style.left = `${p.x}px`; b.style.top = `${p.y}px`; }
    }
    drawLines();
  }
  function cancelBubble() {
    if (g?.kind !== 'bubble') return;
    clearTimeout(g.timer);
    if (g.moved) { moveBubbles(0, 0); viewport.classList.remove('is-moving'); }
    g = null;
  }

  viewport.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    viewport.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, local(e));
    ui.mmBusy = true;          // the tab waits with redrawing until the finger is lifted
    if (pts.size === 2) {
      cancelBubble();
      const [a, b] = [...pts.values()];
      g = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, v0: { ...view } };
      return;
    }
    if (pts.size > 2) return;
    const p = local(e);
    const b = e.target.closest('.mm-b');
    const n = b && world.get(b.dataset.key);
    if (n && n.kind !== 'root') {
      g = { kind: 'bubble', key: n.key, x0: p.x, y0: p.y, moved: false, long: false, add: e.shiftKey || e.ctrlKey || e.metaKey };
      const mine = g;
      g.timer = setTimeout(() => longPress(mine), LONG_PRESS);
    } else {
      g = { kind: 'pan', x0: p.x, y0: p.y, v0: { ...view }, moved: false, root: n?.kind === 'root' ? n : null };
    }
  });
  viewport.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pts.size < 2) return;
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, g.v0.k * (d / g.d0)));
      const wx = (g.mx - g.v0.tx) / g.v0.k, wy = (g.my - g.v0.ty) / g.v0.k;
      view = { k, tx: mx - wx * k, ty: my - wy * k };
      applyView();
      return;
    }
    const dx = p.x - g.x0, dy = p.y - g.y0;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < 6) return;
      g.moved = true;
      clearTimeout(g.timer);
      if (g.kind === 'bubble') {
        const many = st.selected.has(g.key) && st.selected.size > 1;
        if (!many && !st.selectMode) { st.selected = new Set([g.key]); st.last = g.key; drawBars(); }
        const keys = many ? [...st.selected] : [g.key];
        g.start = new Map(keys.filter(k => pos.has(k)).map(k => [k, { ...pos.get(k) }]));
        viewport.classList.add('is-moving');
      }
    }
    if (g.kind === 'pan') {
      view = { ...g.v0, tx: g.v0.tx + dx, ty: g.v0.ty + dy };
      applyView();
    } else if (g.kind === 'bubble') {
      moveBubbles(dx, dy);
    }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!pts.size) ui.mmBusy = false;
    const gesture = g;
    if (!gesture) return;
    if (gesture.kind === 'pinch') {
      if (pts.size < 2) { g = null; keepView(); }
      return;
    }
    g = null;
    if (gesture.kind === 'pan') {
      if (gesture.moved) keepView();
      else if (e.type !== 'pointercancel') {
        if (gesture.root) tap(gesture.root, false);
        else if (!st.selectMode && !st.pending && st.selected.size) { st.selected.clear(); drawBars(); }
      }
      return;
    }
    clearTimeout(gesture.timer);
    viewport.classList.remove('is-moving');
    if (e.type === 'pointercancel') { if (gesture.moved) { g = gesture; cancelBubble(); } return; }
    if (gesture.moved) {
      const nodes = [...gesture.start.keys()].map(k => world.get(k)).filter(Boolean);
      savePlaces(nodes, nodes.length > 1 ? `Move ${plural(nodes.length, 'bubble')}` : 'Move');
    } else if (!gesture.long) {
      tap(world.get(gesture.key), gesture.add);
    }
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);
  viewport.addEventListener('contextmenu', e => e.preventDefault());
  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const p = local(e);
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
  }, { passive: false });

  const onKey = e => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open], .popup')) return;
    if (st.pending) { st.pending = null; drawBars(); }
    else if (st.selectMode || st.selected.size) { st.selectMode = false; st.selected.clear(); drawBars(); }
  };
  document.addEventListener('keydown', onKey);

  /* The map fills the screen down to the bottom (above the phone's tab bar). */
  function size() {
    const r = viewport.getBoundingClientRect();
    const tabs = document.querySelector('.tabs');
    const below = tabs && getComputedStyle(tabs).position === 'fixed' ? tabs.getBoundingClientRect().height : 0;
    viewport.style.height = `${Math.max(320, Math.round(innerHeight - (r.top + scrollY) - below - 14))}px`;
  }
  const onResize = () => { size(); };
  addEventListener('resize', onResize);

  return {
    el,
    mounted() {
      size();
      if (view) applyView(); else fit();
    },
    cleanup() {
      clearTimeout(saveTimer);
      if (view && !forgetView) { ui.prefs.mapViews[key] = { ...view }; ui.savePrefs(); }
      removeEventListener('resize', onResize);
      ui.mmBusy = false;
      document.removeEventListener('keydown', onKey);
      closePopup();
    },
  };
}
