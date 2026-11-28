// One open drawing (or reference picture) in the drawing workspace: its picture, how it's shown
// (zoom, position, grid, tiles, mirror lines), touch and mouse on it, and saving.
// The workspace (workspace.js) holds the shared tools and colours and passes itself in as `ws`.
//
// On a picture: one finger or the mouse draws; two fingers move and zoom; the mouse wheel zooms;
// the middle or right mouse button (or Space) moves it. With "Pick a colour", and always on a
// reference picture, a tap picks the colour and dragging moves the picture.

import { h } from '../core/util.js';
import { store } from '../core/store.js';
import { errorDialog } from '../ui/dialogs.js';
import { createEngine } from './engine.js';
import { fileOf, storableDrawing, normalizeDrawing, rgbToHex } from './model.js';

const SAVE_AFTER = 900;
const ZOOM_MAX = 16;

export function createDoc(d, ws) {
  const id = d.id;
  let rec = d.data;
  const isRef = rec.kind === 'reference';
  const engine = isRef ? null : createEngine({ width: rec.width, height: rec.height, scale: rec.scale });
  const W = isRef ? rec.width : engine.W, H = isRef ? rec.height : engine.H;
  const pic = isRef ? h('canvas', { width: W, height: H }) : engine.canvas;
  const refCtx = isRef ? pic.getContext('2d', { willReadFrequently: true }) : null;
  const st = { mode: rec.kind === 'free' ? 'free' : 'pixel', grid: rec.kind === 'pixel', tiles: false, mirror: 'none' };

  /* ---------- Saving (drawings) ---------- */

  let saveTimer = null, saving = null, unsaved = false, closed = false, status = '', loaded = false;
  let fileStamp = d.file?.updatedAt || null;
  const setStatus = t => { status = t; ws.statusChanged(doc); };
  async function save() {
    clearTimeout(saveTimer);
    if (!unsaved || isRef) return;
    if (engine.drawing) { saveTimer = setTimeout(save, 300); return; }
    unsaved = false;
    setStatus('Saving…');
    saving = (async () => {
      const blob = await engine.toBlob();
      const row = await store.putFile(fileOf({ id, data: rec }), blob, { source: 'draw' });
      fileStamp = row.updatedAt;
      await store.put('drawings', id, storableDrawing(rec), { source: 'draw' });
    })();
    try { await saving; if (!closed) setStatus('Saved on this device'); }
    catch (err) { unsaved = true; setStatus('Not saved'); errorDialog(err, "The drawing couldn't be saved"); }
    finally { saving = null; }
  }
  // Before saving: lay down a floating piece and finish a polygon, so the picture is complete.
  const flush = async () => { engine?.finishPending(); await saving; await save(); };
  if (engine) {
    engine.onSelection = () => { drawOverlay(); ws.selectionChanged?.(doc); };
    engine.onChange = () => {
      unsaved = true;
      setStatus('Saving soon…');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, SAVE_AFTER);
      tilesSoon();
      ws.changed(doc);
    };
  }

  /* ---------- The stage: picture, tiles, overlay ---------- */

  pic.className = `dr-pic${isRef ? ' dr-ref' : ''}`;
  pic.style.width = `${W}px`;
  pic.style.height = `${H}px`;
  pic.style.setProperty('--checker', `${rec.kind === 'pixel' && rec.scale >= 8 ? rec.scale : 16}px`);
  // Tiles: the picture repeated around itself, at a lower detail (just to see the edges meet).
  const t = isRef ? 1 : Math.max(1, Math.floor(256 / Math.max(rec.width, rec.height)));
  const tiles = isRef ? null : h('canvas', { class: `dr-tiles${rec.kind === 'pixel' ? ' pixelated' : ''}`, width: rec.width * t * 3, height: rec.height * t * 3, hidden: true });
  if (tiles) {
    Object.assign(tiles.style, { left: `${-W}px`, top: `${-H}px`, width: `${W * 3}px`, height: `${H * 3}px` });
    tiles.style.setProperty('--checker', pic.style.getPropertyValue('--checker'));
  }
  const world = h('div', { class: 'dr-world' }, tiles, pic);
  const overlay = h('canvas', { class: 'dr-overlay', 'aria-hidden': 'true' });
  const stage = h('div', {
    class: `dr-stage${isRef ? ' is-ref' : ''}`, role: 'application',
    'aria-label': `${isRef ? 'Reference picture' : 'Drawing'}: ${rec.name}`, dataset: { id },
  }, world, overlay);

  let tilesTimer = null;
  function drawTiles() {
    tilesTimer = null;
    if (!tiles || !st.tiles) return;
    const g = tiles.getContext('2d');
    g.imageSmoothingEnabled = rec.kind !== 'pixel';
    g.clearRect(0, 0, tiles.width, tiles.height);
    const tw = tiles.width / 3, th = tiles.height / 3;
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (x !== 1 || y !== 1) g.drawImage(pic, x * tw, y * th, tw, th);
  }
  function tilesSoon() { if (st.tiles && !tilesTimer) tilesTimer = setTimeout(drawTiles, 120); }

  /* View: zoom (screen pixels per picture pixel) and position */
  let view = { k: 1, tx: 0, ty: 0 };
  let fitK = 1, fitted = false, lastSize = null;
  const applyView = () => {
    world.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`;
    pic.classList.toggle('pixelated', view.k >= 1 || rec.kind === 'pixel');
    drawOverlay();
    ws.viewChanged(doc);
  };
  function fit() {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const n = st.tiles ? 3 : 1;
    // Room for the selection bar that floats over the pictures (top on a PC, bottom on a phone).
    const inset = isRef ? { top: 0, bottom: 0 } : ws.fitInset?.() || { top: 0, bottom: 0 };
    const hh = r.height - inset.top - inset.bottom;
    fitK = Math.min(zoomMax, (r.width - 24) / (W * n), (hh - 24) / (H * n));
    view = { k: fitK, tx: (r.width - W * fitK) / 2, ty: inset.top + (hh - H * fitK) / 2 };
    fitted = true;
    lastSize = { w: r.width, h: r.height, left: r.left, top: r.top };
    applyView();
  }
  const zoomMin = () => Math.min(fitK, 1) * 0.25;
  // A reference can be small (a 16 x 16 texture), so it may be blown up a lot more.
  const zoomMax = isRef ? 64 : ZOOM_MAX;
  function zoomAt(f, cx, cy) {
    const k = Math.max(zoomMin(), Math.min(zoomMax, view.k * f));
    view = { k, tx: cx - ((cx - view.tx) * k) / view.k, ty: cy - ((cy - view.ty) * k) / view.k };
    applyView();
  }
  const zoomMiddle = f => { const r = stage.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); };
  const local = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const toFine = q => ({ x: (q.x - view.tx) / view.k, y: (q.y - view.ty) / view.k });

  // When the pane changes size: if only a bar above or below it changed (same width), the picture
  // stays exactly where it is on the screen; otherwise (split screen, the divider, the window)
  // the middle stays in the middle.
  const ro = new ResizeObserver(() => {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (!fitted || !loaded) { if (loaded) fit(); else drawOverlay(); return; }
    if (lastSize && Math.abs(r.width - lastSize.w) < 0.5 && lastSize.top !== undefined) view = { ...view, tx: view.tx + lastSize.left - r.left, ty: view.ty + lastSize.top - r.top };
    else if (lastSize) view = { ...view, tx: view.tx + (r.width - lastSize.w) / 2, ty: view.ty + (r.height - lastSize.h) / 2 };
    lastSize = { w: r.width, h: r.height, left: r.left, top: r.top };
    applyView();
  });
  ro.observe(stage);

  /* Overlay: grid, edges, mirror lines and the brush outline (screen pixels, sharp at any zoom) */
  let hover = null;
  function drawOverlay() {
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), hh = Math.round(r.height * dpr);
    if (overlay.width !== w || overlay.height !== hh) { overlay.width = w; overlay.height = hh; }
    const g = overlay.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const x0 = view.tx, y0 = view.ty, x1 = view.tx + W * view.k, y1 = view.ty + H * view.k;
    const cell = (isRef ? 1 : rec.scale) * view.k;
    if (!isRef && st.grid && cell >= 5) {
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
    if (!isRef && st.mirror !== 'none') {
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
    if (!isRef) drawMarks(g, x0, y0, cell);
    const brush = !isRef && ws.brushOutline();
    if (hover && !gesture && brush?.stamp) {
      const sw = brush.stamp.w * view.k, sh = brush.stamp.h * view.k;
      let sx = hover.x - sw / 2, sy = hover.y - sh / 2;
      if (st.mode === 'pixel') { const f = toFine({ x: sx, y: sy }); sx = x0 + Math.round(f.x / rec.scale) * cell; sy = y0 + Math.round(f.y / rec.scale) * cell; }
      g.save();
      g.setLineDash([4, 3]);
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.shadowColor = 'rgba(0,0,0,0.9)';
      g.shadowBlur = 2;
      g.strokeRect(Math.round(sx) + 0.5, Math.round(sy) + 0.5, Math.round(sw) - 1, Math.round(sh) - 1);
      g.restore();
    } else if (hover && !gesture && brush) {
      g.save();
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.shadowColor = 'rgba(0,0,0,0.9)';
      g.shadowBlur = 2;
      if (st.mode === 'pixel') {
        const c = engine.cellOf(toFine(hover));
        const n = brush.pixelSize, a = Math.floor((n - 1) / 2);
        g.strokeRect(Math.round(x0 + (c.x - a) * cell) + 0.5, Math.round(y0 + (c.y - a) * cell) + 0.5, Math.round(n * cell) - 1, Math.round(n * cell) - 1);
      } else {
        g.beginPath();
        g.arc(hover.x, hover.y, Math.max(1.5, (brush.freeSize / 2) * view.k), 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
    }
  }

  /** Marching ants: the selection's outline, dashed black and white, moving. */
  let ants = 0;
  const antsTimer = isRef ? null : setInterval(() => {
    if (!engine.hasSelection || !stage.isConnected || document.hidden) return;
    ants = (ants + 1) % 8;
    drawOverlay();
  }, 160);
  const scr = p => ({ x: view.tx + p.x * view.k, y: view.ty + p.y * view.k });
  /** Selection outline, the selection being drawn, polygon corners, the gradient's line. */
  function drawMarks(g) {
    const sel = engine.selection;
    if (sel) {
      g.save();
      g.beginPath();
      const d = sel.segs;
      for (let i = 0; i < d.length; i += 4) {
        const a = scr({ x: d[i] + sel.x, y: d[i + 1] + sel.y }), b = scr({ x: d[i + 2] + sel.x, y: d[i + 3] + sel.y });
        g.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
        g.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
      }
      g.lineWidth = 1;
      g.strokeStyle = '#fff';
      g.stroke();
      g.setLineDash([4, 4]);
      g.lineDashOffset = -ants;
      g.strokeStyle = '#000';
      g.stroke();
      if (sel.floating) {
        // A floating piece: a faint box around it (drag it to move).
        const a = scr({ x: sel.box.x0, y: sel.box.y0 }), b = scr({ x: sel.box.x1, y: sel.box.y1 });
        g.setLineDash([]);
        g.strokeStyle = accentColor();
        g.globalAlpha = 0.7;
        g.strokeRect(Math.round(a.x) - 2.5, Math.round(a.y) - 2.5, Math.round(b.x - a.x) + 5, Math.round(b.y - a.y) + 5);
      }
      g.restore();
    }
    if (gesture?.kind === 'select' && gesture.moved) {
      g.save();
      g.setLineDash([5, 4]);
      g.lineWidth = 1.5;
      g.strokeStyle = accentColor();
      g.beginPath();
      if (gesture.shape === 'rect') {
        let a = gesture.pts[0], b = gesture.pts[gesture.pts.length - 1];
        if (st.mode === 'pixel') {
          const k = rec.scale, ca = engine.cellOf(a), cb = engine.cellOf(b);
          a = { x: Math.min(ca.x, cb.x) * k, y: Math.min(ca.y, cb.y) * k };
          b = { x: (Math.max(ca.x, cb.x) + 1) * k, y: (Math.max(ca.y, cb.y) + 1) * k };
        }
        const A = scr(a), B = scr(b);
        g.rect(Math.min(A.x, B.x), Math.min(A.y, B.y), Math.abs(B.x - A.x), Math.abs(B.y - A.y));
      } else {
        gesture.pts.forEach((p, i) => { const P = scr(p); if (i) g.lineTo(P.x, P.y); else g.moveTo(P.x, P.y); });
        g.closePath();
      }
      g.stroke();
      g.restore();
    }
    const poly = engine.polygon;
    if (poly) {
      g.save();
      poly.pts.forEach((p, i) => {
        const P = scr(p), r = i === 0 && poly.pts.length >= 3 ? 7 : 4;
        g.fillStyle = i === 0 && poly.pts.length >= 3 ? accentColor() : '#fff';
        g.strokeStyle = '#000';
        g.lineWidth = 1.5;
        g.beginPath();
        g.rect(P.x - r, P.y - r, r * 2, r * 2);
        g.fill();
        g.stroke();
      });
      g.restore();
    }
    const gl = engine.gradientLine;
    if (gl) {
      const A = scr(gl.a), B = scr(gl.b);
      g.save();
      g.lineWidth = 2;
      g.strokeStyle = '#fff';
      g.shadowColor = 'rgba(0,0,0,0.9)';
      g.shadowBlur = 3;
      g.beginPath();
      g.moveTo(A.x, A.y); g.lineTo(B.x, B.y);
      g.stroke();
      for (const P of [A, B]) { g.beginPath(); g.arc(P.x, P.y, 5, 0, Math.PI * 2); g.stroke(); }
      g.restore();
    }
  }
  let accent = null;
  const accentColor = () => (accent ||= getComputedStyle(stage).getPropertyValue('--accent').trim() || '#2bb3c0');

  /* ---------- Touch and mouse ---------- */

  const pointers = new Map();
  let gesture = null, raf = 0;

  function run() {
    raf = 0;
    if (gesture?.kind !== 'draw') return;
    for (const p of gesture.queue.splice(0)) engine.move(p, { constrain: gesture.constrain });
    engine.show();
    if (engine.gradientLine) drawOverlay();
    tilesSoon();
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };

  function pickAt(p) {
    let c = null;
    if (isRef) {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      if (x >= 0 && y >= 0 && x < W && y < H) { const v = refCtx.getImageData(x, y, 1, 1).data; c = { r: v[0], g: v[1], b: v[2], a: v[3] }; }
    } else c = engine.pick(p, st.mode);
    ws.picked(c && c.a ? rgbToHex(c) : null);
  }

  function startPinch() {
    const [a, b] = [...pointers.values()];
    gesture = { kind: 'pinch', d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: { ...view } };
  }
  function movePinch() {
    const [a, b] = [...pointers.values()];
    const g = gesture;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const k = Math.max(zoomMin(), Math.min(zoomMax, g.view.k * (Math.hypot(b.x - a.x, b.y - a.y) / g.d0)));
    const wx = (g.m0.x - g.view.tx) / g.view.k, wy = (g.m0.y - g.view.ty) / g.view.k;
    view = { k, tx: m.x - wx * k, ty: m.y - wy * k };
    applyView();
  }

  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    if (!loaded) return;
    e.preventDefault();
    stage.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, local(e));
    ws.closeMenus();
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
    const q = local(e);
    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || ws.spaceDown)) {
      gesture = { kind: 'pan', id: e.pointerId, start: q, view: { ...view } };
      stage.classList.add('is-panning');
      return;
    }
    if (isRef || ws.prefs.tool === 'picker' || (e.altKey && e.pointerType === 'mouse' && ws.prefs.tool !== 'select')) {
      // A tap picks the colour; dragging moves the picture.
      gesture = { kind: 'tap', id: e.pointerId, start: q, view: { ...view }, moved: false };
      return;
    }
    ws.activate(doc);
    const p = toFine(q);
    const tool = ws.prefs.tool;
    // A floating piece (moved, pasted or text) can be dragged with any tool.
    if (engine.floating && engine.hitFloat(p, 3 / view.k)) {
      gesture = { kind: 'float', id: e.pointerId, start: q, c0: engine.floatCenter };
      stage.classList.add('is-moving');
      return;
    }
    if (tool === 'select') { startSelect(e, q, p); return; }
    if (tool === 'polygon') { polygonDown(e, q, p); return; }
    if (tool === 'text') { gesture = { kind: 'text', id: e.pointerId, start: q, moved: false }; return; }
    const o = ws.strokeOptions(doc);
    if (!['eraser', 'effect', 'stamp'].includes(o.tool) && o.opacity > 0) ws.remember(o.color);
    const started = engine.begin(o, p);
    gesture = started ? { kind: 'draw', id: e.pointerId, t0: performance.now(), queue: [], constrain: e.shiftKey } : { kind: 'done', id: e.pointerId };
    drawOverlay();
  });

  function startSelect(e, q, p) {
    const op = e.shiftKey ? 'add' : e.altKey ? 'subtract' : ws.prefs.selOp;
    if (engine.floating) engine.commitFloat();
    if (op === 'new' && ws.prefs.selShape !== 'wand' && engine.inSelection(p)) {
      // Dragging inside the selection moves what's selected (Ctrl: a copy of it).
      gesture = { kind: 'maybeLift', id: e.pointerId, start: q, copy: e.ctrlKey || e.metaKey };
      return;
    }
    gesture = { kind: 'select', id: e.pointerId, start: q, shape: ws.prefs.selShape, op, pts: [p], moved: false };
  }
  function polygonDown(e, q, p) {
    const poly = engine.polygon;
    if (poly && poly.pts.length >= 3) {
      const f = scr(poly.pts[0]);
      if (Math.hypot(q.x - f.x, q.y - f.y) < (e.pointerType === 'mouse' ? 10 : 18)) {
        engine.polyClose();
        gesture = { kind: 'done', id: e.pointerId };
        ws.changed(doc);
        drawOverlay();
        return;
      }
    }
    const o = ws.strokeOptions(doc);
    if (!poly && o.opacity > 0) ws.remember(o.color);
    engine.polyAdd(o, p);
    gesture = { kind: 'poly', id: e.pointerId };
    ws.changed(doc);
    drawOverlay();
  }
  stage.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') {
      hover = local(e);
      if (!gesture && engine) {
        const p = toFine(hover);
        stage.classList.toggle('over-float', engine.floating && engine.hitFloat(p, 3 / view.k));
        if (ws.prefs.tool === 'polygon' && engine.polygon) engine.polyHover(p, e.shiftKey);
      }
      if (!gesture) drawOverlay();
    }
    if (!pointers.has(e.pointerId)) return;
    if (gesture?.id === e.pointerId && gesture.kind === 'maybeLift') {
      const q = local(e);
      if (Math.hypot(q.x - gesture.start.x, q.y - gesture.start.y) < 4) return;
      engine.lift({ mode: st.mode, copy: gesture.copy });
      gesture = { kind: 'float', id: e.pointerId, start: gesture.start, c0: engine.floatCenter };
      stage.classList.add('is-moving');
    }
    if (gesture?.id === e.pointerId && gesture.kind === 'float') {
      const q = local(e);
      engine.moveFloatTo(gesture.c0.x + (q.x - gesture.start.x) / view.k, gesture.c0.y + (q.y - gesture.start.y) / view.k);
      return;
    }
    if (gesture?.id === e.pointerId && gesture.kind === 'select') {
      const q = local(e);
      if (!gesture.moved && Math.hypot(q.x - gesture.start.x, q.y - gesture.start.y) < 4) return;
      gesture.moved = true;
      const p = toFine(q);
      if (gesture.shape === 'rect') gesture.pts = [gesture.pts[0], p];
      else if (gesture.shape === 'lasso') {
        const last = gesture.pts[gesture.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * view.k >= 2) gesture.pts.push(p);
      }
      drawOverlay();
      return;
    }
    if (gesture?.id === e.pointerId && gesture.kind === 'poly') { engine.polyMoveLast(toFine(local(e)), e.shiftKey); drawOverlay(); return; }
    if (gesture?.id === e.pointerId && gesture.kind === 'text') {
      const q = local(e);
      if (Math.hypot(q.x - gesture.start.x, q.y - gesture.start.y) > 6) gesture.moved = true;
      return;
    }
    pointers.set(e.pointerId, local(e));
    if (gesture?.kind === 'pinch' && pointers.size >= 2) { movePinch(); return; }
    if ((gesture?.kind === 'pan' || gesture?.kind === 'tap') && e.pointerId === gesture.id) {
      const q = local(e);
      if (gesture.kind === 'tap' && !gesture.moved) {
        if (Math.hypot(q.x - gesture.start.x, q.y - gesture.start.y) < 6) return;
        gesture.moved = true;
        stage.classList.add('is-panning');
      }
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
      engine.show();
      if (e.type === 'pointercancel') engine.cancel(); else engine.end();
      gesture = null;
      tilesSoon();
    } else if (gesture?.kind === 'tap' && e.pointerId === gesture.id) {
      if (!gesture.moved && e.type === 'pointerup') pickAt(toFine(gesture.start));
      gesture = null;
    } else if (gesture?.kind === 'select' && e.pointerId === gesture.id) {
      const g = gesture;
      gesture = null;
      if (e.type === 'pointerup') {
        const opts = { op: g.op, mode: st.mode, all: ws.prefs.wandAll, tolerance: ws.prefs.wandTol };
        if (g.shape === 'wand') { if (!g.moved) engine.select('wand', { p: g.pts[0] }, opts); }
        else if (!g.moved) { if (g.op === 'new') engine.deselect(); }
        else if (g.shape === 'rect') engine.select('rect', { a: g.pts[0], b: g.pts[g.pts.length - 1] }, opts);
        else engine.select('poly', { pts: g.pts }, opts);
      }
    } else if (gesture?.kind === 'text' && e.pointerId === gesture.id) {
      const g = gesture;
      gesture = null;
      if (!g.moved && e.type === 'pointerup') { engine.commitFloat(); ws.textAt(doc, toFine(g.start)); }
    } else if ((gesture?.kind === 'float' || gesture?.kind === 'maybeLift' || gesture?.kind === 'poly') && e.pointerId === gesture.id) {
      gesture = null;
      ws.changed(doc);
    } else if (gesture?.kind === 'pinch') {
      if (pointers.size < 2) gesture = pointers.size ? { kind: 'done' } : null;
    }
    if (!pointers.size) { gesture = null; stage.classList.remove('is-panning', 'is-moving'); }
    drawOverlay();
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { hover = null; drawOverlay(); } });
  stage.addEventListener('contextmenu', e => e.preventDefault());
  // A double-click finishes a polygon (its second click added a corner on the same spot).
  stage.addEventListener('dblclick', () => {
    if (ws.prefs.tool !== 'polygon' || !engine?.polygon) return;
    if (engine.polygon.pts.length > 3) engine.polyBack();
    engine.polyClose();
    ws.changed(doc);
    drawOverlay();
  });
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const q = local(e);
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), q.x, q.y);
  }, { passive: false });

  /* ---------- Loading ---------- */

  async function load(blob) {
    if (isRef) {
      refCtx.clearRect(0, 0, W, H);
      if (blob) { const bmp = await createImageBitmap(blob); refCtx.drawImage(bmp, 0, 0, W, H); bmp.close?.(); }
    } else {
      await engine.load(blob);
    }
  }
  const ready = load(d.file?.blob)
    .catch(err => errorDialog(err, "The picture couldn't be opened"))
    .then(() => { loaded = true; fitted = false; fit(); if (st.tiles) drawTiles(); ws.changed(doc); });

  /* ---------- The document ---------- */

  const doc = {
    id, isRef, engine, stage, pic, st, ready,
    get rec() { return rec; },
    set rec(v) { rec = v; stage.setAttribute('aria-label', `${isRef ? 'Reference picture' : 'Drawing'}: ${rec.name}`); },
    get status() { return status; },
    get zoomText() { return `${Math.round(view.k * 100)}%`; },
    get busy() { return !!gesture; },
    fit,
    /** Fit again once the pane has its new size (after split screen changes). */
    refit() { fitted = false; requestAnimationFrame(() => { if (loaded) fit(); }); },
    zoomMiddle,
    drawOverlay,
    undo: () => { const r = engine?.undo(); drawOverlay(); ws.changed(doc); return r; },
    redo: () => { const r = engine?.redo(); drawOverlay(); ws.changed(doc); return r; },
    /** The middle of what's on screen, in fine pixels (where pasted things go). */
    viewCenter() {
      const r = stage.getBoundingClientRect();
      return toFine({ x: r.width / 2, y: r.height / 2 });
    },
    canUndo: () => !!engine?.canUndo(),
    canRedo: () => !!engine?.canRedo(),
    cancelStroke() { if (gesture?.kind === 'draw') { engine.cancel(); gesture = null; } },
    setMode(m) { st.mode = m; drawOverlay(); },
    toggleGrid() { st.grid = !st.grid; drawOverlay(); },
    toggleTiles() { st.tiles = !st.tiles; tiles.hidden = !st.tiles; if (st.tiles) drawTiles(); fit(); },
    setMirror(m) { st.mirror = m; drawOverlay(); },
    /** A small copy of the picture into a canvas (tab icons). */
    drawInto(c) {
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      g.imageSmoothingEnabled = rec.kind === 'free' || (isRef && Math.max(W, H) > 128);
      const f = Math.min(c.width / W, c.height / H);
      g.drawImage(pic, (c.width - W * f) / 2, (c.height - H * f) / 2, W * f, H * f);
    },
    flush,
    /**
     * After coming back to the workspace: pick up changes from elsewhere (a Pull, Check your
     * changes' Undo). Returns false if the drawing is gone.
     */
    async checkFresh() {
      const row = await store.get('drawings', id);
      if (!row) return false;
      doc.rec = normalizeDrawing(row.data);
      if (saving || unsaved || gesture) return true;
      const f = await store.getFile(fileOf({ id, data: rec }));
      if ((f?.updatedAt || null) !== fileStamp) {
        fileStamp = f?.updatedAt || null;
        await load(f?.blob);
        engine?.resetHistory();
        tilesSoon();
        ws.changed(doc);
      }
      return true;
    },
    /** Close: save first (unless `discard`, for a deleted drawing). */
    async destroy({ discard = false } = {}) {
      closed = true;
      if (discard) { unsaved = false; clearTimeout(saveTimer); await saving; }
      else { if (gesture?.kind === 'draw') engine.end(); await flush(); }
      ro.disconnect();
      clearInterval(antsTimer);
      cancelAnimationFrame(raf);
      clearTimeout(tilesTimer);
      stage.remove();
    },
  };
  return doc;
}
