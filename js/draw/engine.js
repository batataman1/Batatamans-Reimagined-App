// The drawing's picture and everything that paints on it (no buttons or screens here).
//
// One picture, kept at a fine size (width*scale x height*scale). The pixel grid splits it into
// squares of scale x scale fine pixels:
//   - pixel pen ("pixel" mode): fills whole squares with exactly the colour (no blur);
//   - free pen ("free" mode): smooth lines drawn on the fine pixels.
// Both work on the same picture, so you can switch pens at any time.
//
// A stroke: begin(options, point) → move(point)… → end() (or cancel()). Points are in fine
// pixels. While drawing, `snap` holds the picture as it was before the stroke, so each update
// starts from it (shapes can grow and shrink) and Undo keeps only the part that changed.

import { hexToRgb, rgbToHex, grayOf } from './model.js';

const UNDO_BYTES = 64 * 1024 * 1024;
const UNDO_STEPS = 80;

export function createEngine({ width, height, scale }) {
  const k = scale, W = width * k, H = height * k;
  const make = () => Object.assign(document.createElement('canvas'), { width: W, height: H });
  const canvas = make();
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const snap = make();
  const sctx = snap.getContext('2d', { willReadFrequently: true });
  const temp = make();
  const tctx = temp.getContext('2d');

  let undos = [], redos = [], bytes = 0;
  let stroke = null;

  /* ---------- Rectangles (fine pixels; x1/y1 not included) ---------- */

  const clampRect = r => {
    if (!r) return null;
    const x0 = Math.max(0, Math.floor(r.x0)), y0 = Math.max(0, Math.floor(r.y0));
    const x1 = Math.min(W, Math.ceil(r.x1)), y1 = Math.min(H, Math.ceil(r.y1));
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  };
  const union = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
  const around = (x, y, r) => ({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });

  /** Put a part of the picture back the way it was before this stroke. */
  function restore(r) {
    r = clampRect(r);
    if (!r) return;
    const w = r.x1 - r.x0, hh = r.y1 - r.y0;
    ctx.clearRect(r.x0, r.y0, w, hh);
    ctx.drawImage(snap, r.x0, r.y0, w, hh, r.x0, r.y0, w, hh);
  }

  /* ---------- Mirror drawing ---------- */

  /** The flips to draw with: [flipX, flipY] pairs, the plain one first. */
  const flips = sym => [[false, false],
    ...(sym === 'x' || sym === 'xy' ? [[true, false]] : []),
    ...(sym === 'y' || sym === 'xy' ? [[false, true]] : []),
    ...(sym === 'xy' ? [[true, true]] : [])];
  const flipPoint = (p, [fx, fy]) => ({ x: fx ? W - p.x : p.x, y: fy ? H - p.y : p.y });

  /* ---------- Pixel squares ---------- */

  const rgba = (hex, a) => { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
  const cellOf = p => ({ x: Math.floor(p.x / k), y: Math.floor(p.y / k) });

  /** Fill (or clear) a block of squares, with its mirrored copies. Returns the fine area touched. */
  function paintCells(cx, cy, cw, ch, o) {
    let touched = null;
    for (const [fx, fy] of flips(o.symmetry)) {
      let x0 = fx ? width - cx - cw : cx, y0 = fy ? height - cy - ch : cy;
      let x1 = Math.min(width, x0 + cw), y1 = Math.min(height, y0 + ch);
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      if (x1 <= x0 || y1 <= y0) continue;
      const r = { x0: x0 * k, y0: y0 * k, x1: x1 * k, y1: y1 * k };
      ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      if (!o.erase) {
        ctx.fillStyle = o.fillStyle;
        ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      }
      touched = union(touched, r);
    }
    return touched;
  }
  function restoreCells(cx, cy, cw, ch, o) {
    for (const [fx, fy] of flips(o.symmetry)) {
      const x0 = fx ? width - cx - cw : cx, y0 = fy ? height - cy - ch : cy;
      restore({ x0: x0 * k, y0: y0 * k, x1: (x0 + cw) * k, y1: (y0 + ch) * k });
    }
  }
  /** The pen's square block around a square (size n: n x n squares). */
  const block = (c, n) => [c.x - Math.floor((n - 1) / 2), c.y - Math.floor((n - 1) / 2), n, n];

  /** Squares on a straight line (Bresenham). */
  function cellLine(a, b) {
    const out = [];
    let x = a.x, y = a.y;
    const dx = Math.abs(b.x - x), dy = -Math.abs(b.y - y), sx = x < b.x ? 1 : -1, sy = y < b.y ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      out.push({ x, y });
      if (x === b.x && y === b.y) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    return out;
  }

  /** Squares of an ellipse inside a box of squares (inclusive), as row runs [y, x0, x1]. */
  function cellEllipse(x0, y0, x1, y1, filled) {
    const rx = (x1 - x0 + 1) / 2, ry = (y1 - y0 + 1) / 2, xc = x0 + rx, yc = y0 + ry;
    const inside = (x, y) => {
      if (x < x0 || x > x1 || y < y0 || y > y1) return false;
      const dx = (x + 0.5 - xc) / rx, dy = (y + 0.5 - yc) / ry;
      return dx * dx + dy * dy <= 1.0001;
    };
    const runs = [];
    for (let y = y0; y <= y1; y++) {
      let start = null;
      for (let x = x0; x <= x1 + 1; x++) {
        const on = x <= x1 && inside(x, y) && (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1));
        if (on && start === null) start = x;
        if (!on && start !== null) { runs.push([y, start, x - 1]); start = null; }
      }
    }
    return runs;
  }

  /** Keep a shape square / a line at 0, 45 or 90 degrees (Shift on a PC). */
  function constrainTo(a, b, isLine) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (isLine) {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return { x: a.x + Math.round(Math.cos(ang) * len), y: a.y + Math.round(Math.sin(ang) * len) };
    }
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: a.x + Math.sign(dx || 1) * s, y: a.y + Math.sign(dy || 1) * s };
  }

  /* ---------- Free pen ---------- */

  /**
   * A soft brush tip, drawn once per stroke: a solid middle (so a stroke covers or erases
   * fully there) fading out to the rim.
   */
  function softTip(size) {
    const d = Math.max(2, Math.ceil(size));
    const c = Object.assign(document.createElement('canvas'), { width: d, height: d });
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, d / 2);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.5, 'rgba(0,0,0,1)');
    grad.addColorStop(0.75, 'rgba(0,0,0,0.4)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, d, d);
    return c;
  }

  function freeSegment(s, a, b, c) {
    // A smooth line through the points: a curve from the middle of (a, b) to the middle of (b, c).
    const o = s.o, r = o.size / 2 + 2;
    for (const f of flips(o.symmetry)) {
      const A = flipPoint(a, f), B = flipPoint(b, f), C = flipPoint(c, f);
      const m1 = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 }, m2 = { x: (B.x + C.x) / 2, y: (B.y + C.y) / 2 };
      if (o.soft) {
        // Soft brush: dabs along the way, far enough apart that the soft rims don't pile up.
        const steps = Math.max(1, Math.ceil(Math.hypot(m2.x - m1.x, m2.y - m1.y) / Math.max(1, o.size * 0.3)));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps, u = 1 - t;
          const x = u * u * m1.x + 2 * u * t * B.x + t * t * m2.x, y = u * u * m1.y + 2 * u * t * B.y + t * t * m2.y;
          tctx.drawImage(s.tip, x - s.tip.width / 2, y - s.tip.height / 2);
        }
      } else {
        tctx.beginPath();
        tctx.moveTo(m1.x, m1.y);
        tctx.quadraticCurveTo(B.x, B.y, m2.x, m2.y);
        tctx.stroke();
      }
      s.dirty = union(s.dirty, union(around(m1.x, m1.y, r), union(around(B.x, B.y, r), around(m2.x, m2.y, r))));
    }
  }
  function freeDot(s, p) {
    const o = s.o, r = o.size / 2 + 2;
    for (const f of flips(o.symmetry)) {
      const P = flipPoint(p, f);
      if (o.soft) {
        tctx.drawImage(s.tip, P.x - s.tip.width / 2, P.y - s.tip.height / 2);
      } else {
        tctx.beginPath();
        tctx.arc(P.x, P.y, Math.max(0.5, o.size / 2), 0, Math.PI * 2);
        tctx.fill();
      }
      s.dirty = union(s.dirty, around(P.x, P.y, r));
    }
  }
  function freeShape(s, a, b) {
    const o = s.o;
    if (s.shapeArea) tctx.clearRect(s.shapeArea.x0, s.shapeArea.y0, s.shapeArea.x1 - s.shapeArea.x0, s.shapeArea.y1 - s.shapeArea.y0);
    s.shapeArea = null;
    const r = o.size / 2 + 2;
    for (const f of flips(o.symmetry)) {
      const A = flipPoint(a, f), B = flipPoint(b, f);
      tctx.beginPath();
      if (o.tool === 'line') {
        tctx.moveTo(A.x, A.y);
        tctx.lineTo(B.x, B.y);
        tctx.stroke();
      } else if (o.tool === 'rect') {
        const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y), w = Math.abs(B.x - A.x), hh = Math.abs(B.y - A.y);
        if (o.filled) tctx.fillRect(x, y, w, hh); else tctx.strokeRect(x, y, w, hh);
      } else {
        const cx = (A.x + B.x) / 2, cy = (A.y + B.y) / 2, rx = Math.abs(B.x - A.x) / 2, ry = Math.abs(B.y - A.y) / 2;
        if (rx < 0.5 && ry < 0.5) tctx.arc(cx, cy, Math.max(0.5, o.size / 2), 0, Math.PI * 2);
        else tctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
        if (o.filled) tctx.fill(); else tctx.stroke();
      }
      const box = { x0: Math.min(A.x, B.x) - r, y0: Math.min(A.y, B.y) - r, x1: Math.max(A.x, B.x) + r, y1: Math.max(A.y, B.y) + r };
      s.shapeArea = union(s.shapeArea, box);
    }
    s.dirty = union(s.dirty, s.shapeArea);
  }
  /** Show the free stroke: the picture from before, with the stroke on top (or cut out). */
  function compose(s) {
    const r = clampRect(s.dirty);
    if (!r) return;
    const w = r.x1 - r.x0, hh = r.y1 - r.y0;
    restore(r);
    ctx.save();
    ctx.globalAlpha = s.o.opacity;
    ctx.globalCompositeOperation = s.o.erase ? 'destination-out' : 'source-over';
    ctx.drawImage(temp, r.x0, r.y0, w, hh, r.x0, r.y0, w, hh);
    ctx.restore();
  }

  /* ---------- Fill bucket ---------- */

  /**
   * Pixel mode: whole squares with exactly the colour of the square tapped (its middle pixel);
   * free mode: fine pixels close to the colour tapped. Connected (4 sides) or everywhere.
   */
  function fillAt(p, o) {
    const img = ctx.getImageData(0, 0, W, H);
    const px = new Uint32Array(img.data.buffer);
    const { r: cr, g: cg, b: cb } = hexToRgb(o.color);
    const ca = Math.round(o.opacity * 255);
    let area = null;
    if (o.mode === 'pixel') {
      const c = cellOf(p);
      if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) return null;
      const at = (x, y) => px[(y * k + (k >> 1)) * W + x * k + (k >> 1)];
      const target = at(c.x, c.y);
      const hit = new Uint8Array(width * height);
      if (o.fillAll) {
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (at(x, y) === target) hit[y * width + x] = 1;
      } else {
        const stack = [c.x, c.y];
        while (stack.length) {
          const y = stack.pop(), x = stack.pop();
          if (x < 0 || y < 0 || x >= width || y >= height || hit[y * width + x] || at(x, y) !== target) continue;
          hit[y * width + x] = 1;
          stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
        }
      }
      ctx.fillStyle = rgba(o.color, o.opacity);
      for (let y = 0; y < height; y++) {
        let start = -1;
        for (let x = 0; x <= width; x++) {
          const on = x < width && hit[y * width + x];
          if (on && start < 0) start = x;
          if (!on && start >= 0) {
            const r = { x0: start * k, y0: y * k, x1: x * k, y1: (y + 1) * k };
            ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, k);
            if (ca) ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, k);
            area = union(area, r);
            start = -1;
          }
        }
      }
      return area;
    }
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
    if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return null;
    const d = img.data;
    const i0 = (y0 * W + x0) * 4;
    const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], ta = d[i0 + 3];
    const tol = o.tolerance ?? 40;
    const near = i => Math.abs(d[i + 3] - ta) <= tol && (ta === 0 && d[i + 3] <= tol
      ? true : Math.abs(d[i] - tr) <= tol && Math.abs(d[i + 1] - tg) <= tol && Math.abs(d[i + 2] - tb) <= tol);
    const hit = new Uint8Array(W * H);
    let minX = W, minY = H, maxX = -1, maxY = -1;
    const mark = j => {
      hit[j] = 1;
      const x = j % W, y = (j / W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    if (o.fillAll) {
      for (let j = 0; j < W * H; j++) if (near(j * 4)) mark(j);
    } else {
      // Scanline flood fill.
      const stack = [x0, y0];
      while (stack.length) {
        const y = stack.pop();
        let x = stack.pop();
        while (x > 0 && !hit[y * W + x - 1] && near((y * W + x - 1) * 4)) x--;
        let up = false, down = false;
        for (; x < W && !hit[y * W + x] && near((y * W + x) * 4); x++) {
          mark(y * W + x);
          if (y > 0) {
            const ok = !hit[(y - 1) * W + x] && near(((y - 1) * W + x) * 4);
            if (ok && !up) { stack.push(x, y - 1); up = true; } else if (!ok) up = false;
          }
          if (y < H - 1) {
            const ok = !hit[(y + 1) * W + x] && near(((y + 1) * W + x) * 4);
            if (ok && !down) { stack.push(x, y + 1); down = true; } else if (!ok) down = false;
          }
        }
      }
    }
    if (maxX < 0) return null;
    // RGBA bytes as one 32-bit number (little-endian: red is the lowest byte).
    const value = (ca << 24) | (cb << 16) | (cg << 8) | cr;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const j = y * W + x;
      if (hit[j]) px[j] = ca ? value >>> 0 : 0;
    }
    area = { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
    ctx.putImageData(img, 0, 0, area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0);
    return area;
  }

  /* ---------- Undo ---------- */

  function remember(entry) {
    undos.push(entry);
    bytes += entry.before.data.length * 2;
    for (const r of redos) bytes -= r.before.data.length * 2;
    redos = [];
    while (undos.length > 1 && (bytes > UNDO_BYTES || undos.length > UNDO_STEPS)) {
      const old = undos.shift();
      bytes -= old.before.data.length * 2;
    }
  }
  /** Save the changed part of the picture for Undo (call after the change). */
  function rememberArea(r) {
    r = clampRect(r);
    if (!r) return false;
    const w = r.x1 - r.x0, hh = r.y1 - r.y0;
    remember({ x: r.x0, y: r.y0, before: sctx.getImageData(r.x0, r.y0, w, hh), after: ctx.getImageData(r.x0, r.y0, w, hh) });
    return true;
  }
  const takeSnap = () => { sctx.clearRect(0, 0, W, H); sctx.drawImage(canvas, 0, 0); };

  /* ---------- The engine ---------- */

  const api = {
    canvas, width, height, scale: k, W, H,
    onChange: null,
    get drawing() { return !!stroke; },
    cellOf,

    /**
     * Start a stroke. o: { tool: pen|eraser|line|rect|ellipse|fill, mode: pixel|free, color, opacity,
     * size (squares in pixel mode, fine pixels in free mode), soft, filled, fillAll, pixelPerfect,
     * symmetry: none|x|y|xy }.
     */
    begin(o, p) {
      if (stroke) api.cancel();
      o = { ...o, erase: o.tool === 'eraser' };
      takeSnap();
      if (o.tool === 'fill') {
        let area = null;
        for (const f of flips(o.symmetry)) area = union(area, fillAt(flipPoint(p, f), o));
        if (rememberArea(area)) api.onChange?.();
        return false;
      }
      o.fillStyle = rgba(o.color, o.opacity);
      if (o.mode === 'pixel') {
        const c = cellOf(p);
        stroke = { type: 'pixel', o, start: c, last: c, path: [c], counts: new Map(), dirty: null, shape: null };
        if (o.tool === 'pen' || o.tool === 'eraser') api._paintPath(c);
        else api._pixelShape(c);
      } else {
        tctx.clearRect(0, 0, W, H);
        tctx.fillStyle = tctx.strokeStyle = '#000';
        tctx.lineCap = 'round';
        tctx.lineJoin = o.tool === 'rect' ? 'miter' : 'round';
        tctx.lineWidth = Math.max(0.5, o.size);
        stroke = { type: 'free', o, start: p, pts: [p], dirty: null, shapeArea: null, tip: o.soft ? softTip(o.size) : null };
        if (o.tool === 'pen' || o.tool === 'eraser') freeDot(stroke, p);
        else freeShape(stroke, p, p);
        compose(stroke);
      }
      return true;
    },

    _paintPath(c) {
      const s = stroke, o = s.o;
      const key = `${c.x},${c.y}`;
      s.counts.set(key, (s.counts.get(key) || 0) + 1);
      s.dirty = union(s.dirty, paintCells(...block(c, o.size), o));
    },
    _pixelShape(c, constrain) {
      const s = stroke, o = s.o;
      if (s.shape) restore(s.shape);
      s.shape = null;
      const a = s.start, b = constrain ? constrainTo(a, c, o.tool === 'line') : c;
      const add = r => { s.shape = union(s.shape, r); };
      if (o.tool === 'line') {
        for (const q of cellLine(a, b)) add(paintCells(...block(q, o.size), o));
      } else {
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        if (o.tool === 'rect') {
          if (o.filled || x1 - x0 < 2 * o.size || y1 - y0 < 2 * o.size) add(paintCells(x0, y0, x1 - x0 + 1, y1 - y0 + 1, o));
          else {
            const n = o.size;
            add(paintCells(x0, y0, x1 - x0 + 1, n, o));
            add(paintCells(x0, y1 - n + 1, x1 - x0 + 1, n, o));
            add(paintCells(x0, y0 + n, n, y1 - y0 + 1 - 2 * n, o));
            add(paintCells(x1 - n + 1, y0 + n, n, y1 - y0 + 1 - 2 * n, o));
          }
        } else {
          for (const [y, xa, xb] of cellEllipse(x0, y0, x1, y1, o.filled)) {
            if (o.size > 1 && !o.filled) for (let x = xa; x <= xb; x++) add(paintCells(...block({ x, y }, o.size), o));
            else add(paintCells(xa, y, xb - xa + 1, 1, o));
          }
        }
      }
      s.dirty = union(s.dirty, s.shape);
    },

    move(p, { constrain = false } = {}) {
      const s = stroke;
      if (!s) return;
      const o = s.o;
      if (s.type === 'pixel') {
        const c = cellOf(p);
        if (o.tool !== 'pen' && o.tool !== 'eraser') {
          if (c.x !== s.last.x || c.y !== s.last.y || constrain !== s.constrained) { s.last = c; s.constrained = constrain; api._pixelShape(c, constrain); }
          return;
        }
        if (c.x === s.last.x && c.y === s.last.y) return;
        const line = cellLine(s.last, c).slice(1);
        for (const q of line) {
          s.path.push(q);
          api._paintPath(q);
          // Pixel-perfect: take out the corner square of an "L" so lines stay one square thin.
          if (o.pixelPerfect && o.size === 1 && s.path.length >= 3) {
            const a = s.path[s.path.length - 3], b = s.path[s.path.length - 2];
            const diag = Math.abs(a.x - q.x) === 1 && Math.abs(a.y - q.y) === 1;
            const elbow = (b.x === a.x && b.y === q.y) || (b.y === a.y && b.x === q.x);
            if (diag && elbow) {
              const key = `${b.x},${b.y}`;
              const n = (s.counts.get(key) || 1) - 1;
              s.counts.set(key, n);
              if (n <= 0) restoreCells(b.x, b.y, 1, 1, o);
              s.path.splice(s.path.length - 2, 1);
            }
          }
        }
        s.last = c;
        return;
      }
      if (o.tool === 'pen' || o.tool === 'eraser') {
        const last = s.pts[s.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < 0.75) return;
        s.pts.push(p);
        const n = s.pts.length;
        freeSegment(s, s.pts[Math.max(0, n - 3)], s.pts[n - 2], p);
      } else {
        freeShape(s, s.start, constrain ? constrainTo(s.start, p, o.tool === 'line') : p);
      }
      s.needsCompose = true;
    },

    /** Free strokes are shown once per screen frame (the editor calls this). */
    show() {
      if (stroke?.type === 'free' && stroke.needsCompose) { stroke.needsCompose = false; compose(stroke); }
    },

    end() {
      const s = stroke;
      if (!s) return false;
      if (s.type === 'free') {
        if ((s.o.tool === 'pen' || s.o.tool === 'eraser') && s.pts.length > 1) {
          const n = s.pts.length;
          freeSegment(s, s.pts[n - 2], s.pts[n - 1], s.pts[n - 1]);   // the last bit, to the end point
        }
        compose(s);
      }
      stroke = null;
      const changed = rememberArea(s.dirty);
      if (changed) api.onChange?.();
      return changed;
    },

    cancel() {
      const s = stroke;
      if (!s) return;
      restore(s.dirty);
      stroke = null;
    },

    /** The colour at a point ({ r, g, b, a }), the middle of the square in pixel mode. */
    pick(p, mode) {
      let x = Math.floor(p.x), y = Math.floor(p.y);
      if (mode === 'pixel') { const c = cellOf(p); x = c.x * k + (k >> 1); y = c.y * k + (k >> 1); }
      if (x < 0 || y < 0 || x >= W || y >= H) return null;
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    },

    /* Whole-picture changes */

    /** Change every pixel with fn(data); one Undo step. Returns whether anything changed. */
    applyPixels(fn) {
      if (stroke) api.cancel();
      const img = ctx.getImageData(0, 0, W, H);
      const before = new ImageData(new Uint8ClampedArray(img.data), W, H);
      if (fn(img.data) === false) return false;
      ctx.putImageData(img, 0, 0);
      remember({ x: 0, y: 0, before, after: img });
      api.onChange?.();
      return true;
    },

    /**
     * The colours in the picture: [{ hex, count }], most used first. Fully see-through pixels
     * are left out; partly see-through ones (soft edges, whose colour drifts a little when
     * stored) count for the solid colour closest to them.
     */
    colorsUsed() {
      const d = ctx.getImageData(0, 0, W, H).data;
      const solid = new Map(), soft = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        if (!a) continue;
        const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        const m = a >= 200 ? solid : soft;
        m.set(key, (m.get(key) || 0) + 1);
      }
      const dist = (p, q) => Math.max(Math.abs((p >> 16) - (q >> 16)), Math.abs(((p >> 8) & 255) - ((q >> 8) & 255)), Math.abs((p & 255) - (q & 255)));
      for (const [key, n] of soft) {
        let best = solid.has(key) ? key : null, bd = 9;
        if (best === null) for (const q of solid.keys()) { const dd = dist(key, q); if (dd < bd) { bd = dd; best = q; } }
        if (best === null) best = key;
        solid.set(best, (solid.get(best) || 0) + n);
      }
      return [...solid].sort((a, b) => b[1] - a[1])
        .map(([key, count]) => ({ hex: rgbToHex({ r: key >> 16, g: (key >> 8) & 255, b: key & 255 }), count }));
    },
    /** The drawing's own colours for a palette: ones covering at least half a square. */
    paletteColors(max = 64) {
      return api.colorsUsed().filter(c => c.count >= (k * k) / 2).slice(0, max).map(c => c.hex);
    },

    /** Grayscale: every colour becomes the gray of the same brightness (see-through stays). */
    grayscale: () => api.applyPixels(grayscaleData),

    /** Swap colours: map { "#old": "#new" }; `similar` also moves shades close to an old colour along. */
    swapColors: (map, similar = 0) => api.applyPixels(d => swapData(d, map, similar)),

    undo() {
      if (stroke) api.cancel();
      const e = undos.pop();
      if (!e) return false;
      ctx.putImageData(e.before, e.x, e.y);
      redos.push(e);
      api.onChange?.();
      return true;
    },
    redo() {
      const e = redos.pop();
      if (!e) return false;
      ctx.putImageData(e.after, e.x, e.y);
      undos.push(e);
      api.onChange?.();
      return true;
    },
    canUndo: () => undos.length > 0,
    canRedo: () => redos.length > 0,

    async load(blob) {
      if (!blob) return;
      const bmp = await createImageBitmap(blob);
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, 0, 0, W, H);
      bmp.close?.();
    },
    toBlob: () => new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("The picture couldn't be saved"))), 'image/png')),

    /** The picture at m pixels per square (exact for pixel art). */
    exportCanvas: m => exportCanvas(canvas, width, height, k, m),
  };
  return api;
}

/** Grayscale (see grayOf). */
export function grayscaleData(d) {
  let changed = false;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const g = grayOf(d[i], d[i + 1], d[i + 2]);
    if (d[i] !== g || d[i + 1] !== g || d[i + 2] !== g) { d[i] = d[i + 1] = d[i + 2] = g; changed = true; }
  }
  return changed;
}

/**
 * Swap colours in pixel data. map: { "#old": "#new" }. A pixel of exactly an old colour gets
 * the new one; with `similar` (0-255), a pixel close to an old colour moves by the same amount
 * (so shading and smooth edges keep their look). See-through amounts stay as they are.
 */
export function swapData(d, map, similar = 0) {
  const pairs = Object.entries(map).filter(([a, b]) => a !== b).map(([a, b]) => [hexToRgb(a), hexToRgb(b)]);
  if (!pairs.length) return false;
  const cache = new Map();
  const target = (r, g, b, tol) => {
    const key = (((r << 16) | (g << 8) | b) * 64) + Math.min(tol, 63);
    if (cache.has(key)) return cache.get(key);
    let best = null, bestDist = Infinity;
    for (const [from, to] of pairs) {
      const dist = Math.max(Math.abs(from.r - r), Math.abs(from.g - g), Math.abs(from.b - b));
      if (dist === 0) { best = [to.r, to.g, to.b]; bestDist = 0; break; }
      if (tol && dist <= tol && dist < bestDist) { bestDist = dist; best = [r + to.r - from.r, g + to.g - from.g, b + to.b - from.b]; }
    }
    cache.set(key, best);
    return best;
  };
  let changed = false;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (!a) continue;
    // A partly see-through pixel's colour drifts a little when stored: allow for that.
    const tol = a === 255 ? similar : Math.max(similar, Math.min(8, Math.ceil(255 / a)));
    const t = target(d[i], d[i + 1], d[i + 2], tol);
    if (!t) continue;
    d[i] = t[0]; d[i + 1] = t[1]; d[i + 2] = t[2];
    changed = true;
  }
  return changed;
}

/**
 * The picture at m pixels per square. Smaller than the fine size: each output pixel is the
 * average of the fine pixels it covers (exact colours for pixel art); bigger: blown up with
 * sharp pixels.
 */
export function exportCanvas(src, width, height, k, m) {
  const out = Object.assign(document.createElement('canvas'), { width: width * m, height: height * m });
  const o = out.getContext('2d');
  if (m >= k) {
    o.imageSmoothingEnabled = false;
    o.drawImage(src, 0, 0, out.width, out.height);
    return out;
  }
  const f = k / m, W = width * k;
  const s = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, height * k).data;
  const img = o.createImageData(out.width, out.height);
  const d = img.data;
  const n = f * f;
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let yy = 0; yy < f; yy++) {
      let i = ((y * f + yy) * W + x * f) * 4;
      for (let xx = 0; xx < f; xx++, i += 4) {
        const al = s[i + 3];
        r += s[i] * al; g += s[i + 1] * al; b += s[i + 2] * al; a += al;
      }
    }
    const j = (y * out.width + x) * 4;
    if (a) { d[j] = Math.round(r / a); d[j + 1] = Math.round(g / a); d[j + 2] = Math.round(b / a); d[j + 3] = Math.round(a / n); }
  }
  o.putImageData(img, 0, 0);
  return out;
}
