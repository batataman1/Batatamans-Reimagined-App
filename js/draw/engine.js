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
//
// Part 2e adds, all on the same one picture:
//   - a selection (a mask of fine pixels): while there is one, every tool only changes the inside;
//   - a floating piece: a selection lifted off to move, flip or turn (or something pasted, text);
//     it's laid down with commitFloat() (one Undo step), or cancelFloat() puts everything back;
//   - the polygon (corners added one tap at a time), the gradient, the effect brush and stamps;
//   - "wrap" (Tiles shown): drawing past an edge comes back in on the other side.

import { hexToRgb, rgbToHex, grayOf } from './model.js';
import { cellsOf, blurRGBA, brushColor, ditherThreshold, gradientData } from './effects.js';
import {
  rectMask, polygonMask, expandCells, combineMasks, maskBox, outlineOf,
  cropPiece, clonePiece, flipPiece, turnPiece, turnPieceBy,
} from './select.js';

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
  const tctx = temp.getContext('2d', { willReadFrequently: true });

  let undos = [], redos = [], bytes = 0;
  let stroke = null;
  let sel = null;       // { mask, box, segs, maskCanvas }
  let float = null;     // the floating piece (see "Floating piece")
  let poly = null;      // the polygon being drawn

  /* ---------- Rectangles (fine pixels; x1/y1 not included) ---------- */

  const clampRect = r => {
    if (!r) return null;
    const x0 = Math.max(0, Math.floor(r.x0)), y0 = Math.max(0, Math.floor(r.y0));
    const x1 = Math.min(W, Math.ceil(r.x1)), y1 = Math.min(H, Math.ceil(r.y1));
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  };
  const union = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
  const around = (x, y, r) => ({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
  const FULL = { x0: 0, y0: 0, x1: W, y1: H };

  /** Put a part of the picture back the way it was before this stroke. */
  function restore(r) {
    r = clampRect(r);
    if (!r) return;
    const w = r.x1 - r.x0, hh = r.y1 - r.y0;
    ctx.clearRect(r.x0, r.y0, w, hh);
    ctx.drawImage(snap, r.x0, r.y0, w, hh, r.x0, r.y0, w, hh);
  }

  /* ---------- Selection ---------- */

  const selCell = (x, y) => !sel || !!sel.mask[(y * k + (k >> 1)) * W + x * k + (k >> 1)];
  function selMaskCanvas() {
    if (!sel.maskCanvas) {
      const c = make(), g = c.getContext('2d');
      const img = g.createImageData(W, H);
      const v = new Uint32Array(img.data.buffer);
      for (let i = 0; i < W * H; i++) if (sel.mask[i]) v[i] = 0xff000000;
      g.putImageData(img, 0, 0);
      sel.maskCanvas = c;
    }
    return sel.maskCanvas;
  }
  /** Outside the selection everything stays as it was before the stroke. */
  function clipToSelection(r) {
    if (!sel) return;
    r = clampRect(r);
    if (!r) return;
    const w = r.x1 - r.x0, hh = r.y1 - r.y0;
    const now = ctx.getImageData(r.x0, r.y0, w, hh), was = sctx.getImageData(r.x0, r.y0, w, hh);
    let any = false;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      if (sel.mask[(y + r.y0) * W + x + r.x0]) continue;
      const i = (y * w + x) * 4;
      if (now.data[i] !== was.data[i] || now.data[i + 1] !== was.data[i + 1] || now.data[i + 2] !== was.data[i + 2] || now.data[i + 3] !== was.data[i + 3]) {
        now.data[i] = was.data[i]; now.data[i + 1] = was.data[i + 1]; now.data[i + 2] = was.data[i + 2]; now.data[i + 3] = was.data[i + 3];
        any = true;
      }
    }
    if (any) ctx.putImageData(now, r.x0, r.y0);
  }
  function setSelection(mask) {
    const box = mask ? maskBox(mask, W, H) : null;
    sel = box ? { mask, box, segs: null, maskCanvas: null } : null;
    api.onSelection?.();
  }

  /* ---------- Mirror drawing and Tiles ---------- */

  /** The flips to draw with: [flipX, flipY] pairs, the plain one first. */
  const flips = sym => [[false, false],
    ...(sym === 'x' || sym === 'xy' ? [[true, false]] : []),
    ...(sym === 'y' || sym === 'xy' ? [[false, true]] : []),
    ...(sym === 'xy' ? [[true, true]] : [])];
  const flipPoint = (p, [fx, fy]) => ({ x: fx ? W - p.x : p.x, y: fy ? H - p.y : p.y });
  /** With Tiles showing, every mark is also made one picture away in each direction (it wraps). */
  const OFFS9 = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  const offsets = o => (o.wrap ? OFFS9 : [[0, 0]]);
  /** Every copy of a point: mirrored, then wrapped. */
  const copiesOf = (p, o) => flips(o.symmetry).flatMap(f => offsets(o).map(([dx, dy]) => {
    const q = flipPoint(p, f);
    return { x: q.x + dx * W, y: q.y + dy * H, f };
  }));

  /* ---------- Pixel squares ---------- */

  const rgba = (hex, a) => { const { r, g, b } = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
  const cellOf = p => ({ x: Math.floor(p.x / k), y: Math.floor(p.y / k) });

  /** Fill or clear squares x0..x1, y0..y1 (not included), only selected ones. */
  function fillCellRect(x0, y0, x1, y1, o) {
    const paint = (a, b, y) => {
      const r = { x0: a * k, y0: y * k, x1: b * k, y1: (y + 1) * k };
      ctx.clearRect(r.x0, r.y0, r.x1 - r.x0, k);
      if (!o.erase) { ctx.fillStyle = o.fillStyle; ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, k); }
    };
    if (!sel) {
      ctx.clearRect(x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k);
      if (!o.erase) { ctx.fillStyle = o.fillStyle; ctx.fillRect(x0 * k, y0 * k, (x1 - x0) * k, (y1 - y0) * k); }
      return;
    }
    for (let y = y0; y < y1; y++) {
      let start = -1;
      for (let x = x0; x <= x1; x++) {
        const on = x < x1 && selCell(x, y);
        if (on && start < 0) start = x;
        if (!on && start >= 0) { paint(start, x, y); start = -1; }
      }
    }
  }

  /** Fill (or clear) a block of squares, with its mirrored (and wrapped) copies. Returns the fine area touched. */
  function paintCells(cx, cy, cw, ch, o) {
    let touched = null;
    for (const [fx, fy] of flips(o.symmetry)) {
      for (const [dx, dy] of offsets(o)) {
        let x0 = (fx ? width - cx - cw : cx) + dx * width, y0 = (fy ? height - cy - ch : cy) + dy * height;
        let x1 = Math.min(width, x0 + cw), y1 = Math.min(height, y0 + ch);
        x0 = Math.max(0, x0); y0 = Math.max(0, y0);
        if (x1 <= x0 || y1 <= y0) continue;
        fillCellRect(x0, y0, x1, y1, o);
        touched = union(touched, { x0: x0 * k, y0: y0 * k, x1: x1 * k, y1: y1 * k });
      }
    }
    return touched;
  }
  function restoreCells(cx, cy, cw, ch, o) {
    for (const [fx, fy] of flips(o.symmetry)) {
      for (const [dx, dy] of offsets(o)) {
        const x0 = (fx ? width - cx - cw : cx) + dx * width, y0 = (fy ? height - cy - ch : cy) + dy * height;
        restore({ x0: x0 * k, y0: y0 * k, x1: (x0 + cw) * k, y1: (y0 + ch) * k });
      }
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

  /** Squares inside a polygon (points in squares): row runs [y, x0, x1], by their middles. */
  function cellPolygon(pts) {
    const runs = [];
    const ys = pts.map(p => p.y);
    const minY = Math.max(0, Math.floor(Math.min(...ys))), maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));
    for (let y = minY; y <= maxY; y++) {
      const cy = y + 0.5, xs = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a.y <= cy && b.y > cy) || (b.y <= cy && a.y > cy)) xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.ceil(xs[i] - 0.5)), xb = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5));
        if (xb >= xa) runs.push([y, xa, xb]);
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
  const mark = (s, r) => { s.dirty = union(s.dirty, r); s.fd = union(s.fd, r); };

  function freeSegment(s, a, b, c) {
    // A smooth line through the points: a curve from the middle of (a, b) to the middle of (b, c).
    const o = s.o, r = o.size / 2 + 2;
    for (const f of flips(o.symmetry)) {
      for (const [ox, oy] of offsets(o)) {
        const sh = q => { const p = flipPoint(q, f); return { x: p.x + ox * W, y: p.y + oy * H }; };
        const A = sh(a), B = sh(b), C = sh(c);
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
        mark(s, union(around(m1.x, m1.y, r), union(around(B.x, B.y, r), around(m2.x, m2.y, r))));
      }
    }
  }
  function freeDot(s, p) {
    const o = s.o, r = o.size / 2 + 2;
    for (const P of copiesOf(p, o)) {
      if (o.soft) {
        tctx.drawImage(s.tip, P.x - s.tip.width / 2, P.y - s.tip.height / 2);
      } else {
        tctx.beginPath();
        tctx.arc(P.x, P.y, Math.max(0.5, o.size / 2), 0, Math.PI * 2);
        tctx.fill();
      }
      mark(s, around(P.x, P.y, r));
    }
  }
  function freeShape(s, a, b) {
    const o = s.o;
    if (s.shapeArea) tctx.clearRect(s.shapeArea.x0, s.shapeArea.y0, s.shapeArea.x1 - s.shapeArea.x0, s.shapeArea.y1 - s.shapeArea.y0);
    s.shapeArea = null;
    const r = o.size / 2 + 2;
    for (const f of flips(o.symmetry)) {
      for (const [ox, oy] of offsets(o)) {
        const sh = q => { const p = flipPoint(q, f); return { x: p.x + ox * W, y: p.y + oy * H }; };
        const A = sh(a), B = sh(b);
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
    }
    s.dirty = union(s.dirty, s.shapeArea);
  }
  /** A polygon on the free pen's sheet (temp): open while you add corners, closed at the end. */
  function freePolygon(s, pts, closed) {
    const o = s.o;
    if (s.shapeArea) tctx.clearRect(s.shapeArea.x0, s.shapeArea.y0, s.shapeArea.x1 - s.shapeArea.x0, s.shapeArea.y1 - s.shapeArea.y0);
    s.shapeArea = null;
    const r = o.size / 2 + 2;
    for (const f of flips(o.symmetry)) {
      for (const [ox, oy] of offsets(o)) {
        const P = pts.map(q => { const p = flipPoint(q, f); return { x: p.x + ox * W, y: p.y + oy * H }; });
        tctx.beginPath();
        P.forEach((p, i) => (i ? tctx.lineTo(p.x, p.y) : tctx.moveTo(p.x, p.y)));
        if (closed) tctx.closePath();
        if (closed && o.filled) tctx.fill('evenodd'); else tctx.stroke();
        for (const p of P) s.shapeArea = union(s.shapeArea, around(p.x, p.y, r));
      }
    }
    s.dirty = union(s.dirty, s.shapeArea);
  }
  /** Show the free stroke: the picture from before, with the stroke on top (or cut out). */
  function compose(s) {
    const r = clampRect(s.dirty);
    if (!r) return;
    const w = r.x1 - r.x0, hh = r.y1 - r.y0;
    restore(r);
    if (sel) {
      // Only inside the selection.
      tctx.save();
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(selMaskCanvas(), r.x0, r.y0, w, hh, r.x0, r.y0, w, hh);
      tctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = s.o.opacity;
    ctx.globalCompositeOperation = s.o.erase ? 'destination-out' : 'source-over';
    ctx.drawImage(temp, r.x0, r.y0, w, hh, r.x0, r.y0, w, hh);
    ctx.restore();
  }
  function startSheet(o) {
    tctx.clearRect(0, 0, W, H);
    tctx.fillStyle = tctx.strokeStyle = '#000';
    tctx.lineCap = 'round';
    tctx.lineJoin = o.tool === 'rect' ? 'miter' : 'round';
    tctx.lineWidth = Math.max(0.5, o.size);
  }

  /* ---------- Areas of one colour (fill bucket, magic wand, gradient) ---------- */

  const pictureWords = () => new Uint32Array(ctx.getImageData(0, 0, W, H).data.buffer);

  /**
   * Squares with exactly the colour of square c: connected (4 sides) or everywhere.
   * limit: stop at the edge of the selection. wrap: connected across the picture's edges.
   */
  function regionCells(c, { all = false, limit = true, wrap = false, px = pictureWords() } = {}) {
    if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) return null;
    const at = (x, y) => px[(y * k + (k >> 1)) * W + x * k + (k >> 1)];
    const ok = (x, y) => !limit || selCell(x, y);
    const target = at(c.x, c.y);
    const hit = new Uint8Array(width * height);
    if (all) {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (at(x, y) === target && ok(x, y)) hit[y * width + x] = 1;
    } else {
      if (!ok(c.x, c.y)) return hit;
      const stack = [c.x, c.y];
      while (stack.length) {
        let y = stack.pop(), x = stack.pop();
        if (wrap) { x = (x + width) % width; y = (y + height) % height; }
        if (x < 0 || y < 0 || x >= width || y >= height || hit[y * width + x] || at(x, y) !== target || !ok(x, y)) continue;
        hit[y * width + x] = 1;
        stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
      }
    }
    return hit;
  }

  /** Fine pixels close to the colour at p (within `tolerance`): connected or everywhere. */
  function regionFine(p, { all = false, tolerance = 40, limit = true } = {}) {
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
    if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return null;
    const d = ctx.getImageData(0, 0, W, H).data;
    const i0 = (y0 * W + x0) * 4;
    const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], ta = d[i0 + 3];
    const tol = tolerance;
    const lim = limit && sel ? sel.mask : null;
    const near = j => (!lim || lim[j]) && Math.abs(d[j * 4 + 3] - ta) <= tol && (ta === 0 && d[j * 4 + 3] <= tol
      ? true : Math.abs(d[j * 4] - tr) <= tol && Math.abs(d[j * 4 + 1] - tg) <= tol && Math.abs(d[j * 4 + 2] - tb) <= tol);
    const hit = new Uint8Array(W * H);
    let minX = W, minY = H, maxX = -1, maxY = -1;
    const markHit = j => {
      hit[j] = 1;
      const x = j % W, y = (j / W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    if (all) {
      for (let j = 0; j < W * H; j++) if (near(j)) markHit(j);
    } else {
      // Scanline flood fill.
      const stack = [x0, y0];
      while (stack.length) {
        const y = stack.pop();
        let x = stack.pop();
        while (x > 0 && !hit[y * W + x - 1] && near(y * W + x - 1)) x--;
        let up = false, down = false;
        for (; x < W && !hit[y * W + x] && near(y * W + x); x++) {
          markHit(y * W + x);
          if (y > 0) {
            const okUp = !hit[(y - 1) * W + x] && near((y - 1) * W + x);
            if (okUp && !up) { stack.push(x, y - 1); up = true; } else if (!okUp) up = false;
          }
          if (y < H - 1) {
            const okDown = !hit[(y + 1) * W + x] && near((y + 1) * W + x);
            if (okDown && !down) { stack.push(x, y + 1); down = true; } else if (!okDown) down = false;
          }
        }
      }
    }
    return { hit, box: maxX < 0 ? null : { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 } };
  }

  /** The area of one colour at p as a mask of fine pixels (pixel pen: whole squares). */
  function regionMask(p, o, limit = true) {
    if (o.mode === 'pixel') {
      const cells = regionCells(cellOf(p), { all: o.fillAll, limit, wrap: !!o.wrap });
      return cells ? expandCells(cells, width, height, k) : null;
    }
    return regionFine(p, { all: o.fillAll, tolerance: o.tolerance ?? 40, limit })?.hit || null;
  }

  /* ---------- Fill bucket ---------- */

  /**
   * Pixel mode: whole squares with exactly the colour of the square tapped (its middle pixel);
   * free mode: fine pixels close to the colour tapped. Connected (4 sides) or everywhere.
   */
  function fillAt(p, o) {
    const { r: cr, g: cg, b: cb } = hexToRgb(o.color);
    const ca = Math.round(o.opacity * 255);
    if (o.wrap) p = { x: ((p.x % W) + W) % W, y: ((p.y % H) + H) % H };
    let area = null;
    if (o.mode === 'pixel') {
      const hit = regionCells(cellOf(p), { all: o.fillAll, wrap: !!o.wrap });
      if (!hit) return null;
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
    const reg = regionFine(p, { all: o.fillAll, tolerance: o.tolerance ?? 40 });
    if (!reg?.box) return null;
    const img = ctx.getImageData(0, 0, W, H);
    const px = new Uint32Array(img.data.buffer);
    // RGBA bytes as one 32-bit number (little-endian: red is the lowest byte).
    const value = (ca << 24) | (cb << 16) | (cg << 8) | cr;
    const b = reg.box;
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) {
      const j = y * W + x;
      if (reg.hit[j]) px[j] = ca ? value >>> 0 : 0;
    }
    ctx.putImageData(img, 0, 0, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    return b;
  }

  /* ---------- Gradient ---------- */

  const colorOf = (hex, a = 255) => { const { r, g, b } = hexToRgb(hex); return [r, g, b, a]; };
  function gradientCompose(s) {
    const bx = s.box, bw = bx.x1 - bx.x0, bh = bx.y1 - bx.y0;
    const data = new Uint8ClampedArray(s.base.data);
    const o = s.o;
    gradientData({ d: data, W: bw, H: bh, k, mode: o.mode, ox: bx.x0, oy: bx.y0, FW: W }, {
      a: s.a, b: s.b, shape: o.gradShape, c1: colorOf(o.color), c2: o.gradTo === 'clear' ? colorOf(o.color, 0) : colorOf(o.color2 || '#ffffff'),
      opacity: o.opacity, steps: o.gradSteps, dither: o.gradDither, area: s.area,
    });
    ctx.putImageData(new ImageData(data, bw, bh), bx.x0, bx.y0);
  }

  /* ---------- Effect brush ---------- */

  const fxStrength = o => Math.max(0.01, Math.min(1, o.strength ?? 0.3));
  /** Pixel pen: change each square once per stroke. */
  function fxCells(s, c) {
    const o = s.o, str = fxStrength(o);
    const [bx, by, bw, bh] = block(c, o.size);
    for (const [fx, fy] of flips(o.symmetry)) {
      for (const [dx, dy] of offsets(o)) {
        const x0 = (fx ? width - bx - bw : bx) + dx * width, y0 = (fy ? height - by - bh : by) + dy * height;
        for (let y = Math.max(0, y0); y < Math.min(height, y0 + bh); y++) for (let x = Math.max(0, x0); x < Math.min(width, x0 + bw); x++) {
          const ci = y * width + x;
          if (s.visited[ci] || !selCell(x, y)) continue;
          s.visited[ci] = 1;
          const j = ci * 4, a = s.cells[j + 3];
          let out;
          if (o.fx === 'dither') {
            out = ditherThreshold(o.fxDither || 'checker', x, y) < str ? s.c1 : s.c2;
          } else if (!a) continue;
          else if (o.fx === 'smooth') {
            let r = 0, g = 0, b = 0, al = 0, n = 0;
            for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) {
              const nx = x + xx, ny = y + yy;
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              const q = (ny * width + nx) * 4, qa = s.cells[q + 3];
              r += s.cells[q] * qa; g += s.cells[q + 1] * qa; b += s.cells[q + 2] * qa; al += qa; n++;
            }
            const avg = al ? [r / al, g / al, b / al, al / n] : [0, 0, 0, 0];
            out = [0, 1, 2, 3].map(t => s.cells[j + t] + (avg[t] - s.cells[j + t]) * str);
          } else {
            const v = brushColor(o.fx, s.cells[j], s.cells[j + 1], s.cells[j + 2], str, { palette: o.fxPalette, x, y, seed: s.seed });
            out = [v[0], v[1], v[2], a];
          }
          ctx.clearRect(x * k, y * k, k, k);
          if (out[3] > 0) { ctx.fillStyle = `rgba(${Math.round(out[0])},${Math.round(out[1])},${Math.round(out[2])},${out[3] / 255})`; ctx.fillRect(x * k, y * k, k, k); }
          s.dirty = union(s.dirty, { x0: x * k, y0: y * k, x1: x * k + k, y1: y * k + k });
        }
      }
    }
  }
  /** Free pen: the brush's footprint (temp) says how much of the effect each fine pixel gets. */
  function fxCompose(s) {
    const r = clampRect(s.fd);
    s.fd = null;
    if (!r) return;
    const o = s.o, str = fxStrength(o);
    const w = r.x1 - r.x0, hh = r.y1 - r.y0;
    const cov = tctx.getImageData(r.x0, r.y0, w, hh).data;
    const out = ctx.createImageData(w, hh), d = out.data, base = s.base;
    if (o.fx === 'smooth' && !s.blurred) s.blurred = blurRGBA(base, W, H, Math.max(1, Math.round(o.size / 6)));
    const cache = new Map();
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const gx = x + r.x0, gy = y + r.y0, j = gy * W + gx, i = (y * w + x) * 4, bi = j * 4;
      let t = cov[i + 3] / 255;
      if (sel && !sel.mask[j]) t = 0;
      const R = base[bi], G = base[bi + 1], B = base[bi + 2], A = base[bi + 3];
      if (t <= 0 || (!A && o.fx !== 'dither' && o.fx !== 'smooth')) { d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = A; continue; }
      if (o.fx === 'dither') {
        const c = t >= 0.5 ? (ditherThreshold(o.fxDither || 'checker', Math.floor(gx / k), Math.floor(gy / k)) < str ? s.c1 : s.c2) : [R, G, B, A];
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
        continue;
      }
      let f;
      if (o.fx === 'smooth') f = [s.blurred[bi], s.blurred[bi + 1], s.blurred[bi + 2], s.blurred[bi + 3]];
      else if (o.fx === 'noise') { const v = brushColor('noise', R, G, B, str, { x: gx, y: gy, seed: s.seed }); f = [v[0], v[1], v[2], A]; }
      else {
        const key = (R << 16) | (G << 8) | B;
        let v = cache.get(key);
        if (!v) { v = brushColor(o.fx, R, G, B, str, { palette: o.fxPalette }); cache.set(key, v); }
        f = [v[0], v[1], v[2], A];
      }
      // How strong: the noise and lighten/darken go all the way where the brush fully covers.
      d[i] = R + (f[0] - R) * t; d[i + 1] = G + (f[1] - G) * t; d[i + 2] = B + (f[2] - B) * t; d[i + 3] = A + (f[3] - A) * t;
    }
    ctx.putImageData(out, r.x0, r.y0);
  }

  /* ---------- Stamps ---------- */

  /** One stamp (and its mirrored, wrapped copies) with its middle at p. */
  function stampAt(s, p) {
    const o = s.o, pc = o.stampPiece;
    for (const P of copiesOf(p, o)) {
      const [fx, fy] = P.f;
      let x = P.x - pc.w / 2, y = P.y - pc.h / 2;
      if (o.mode === 'pixel') { x = Math.round(x / k) * k; y = Math.round(y / k) * k; } else { x = Math.round(x); y = Math.round(y); }
      ctx.save();
      ctx.globalAlpha = o.opacity;
      ctx.setTransform(fx ? -1 : 1, 0, 0, fy ? -1 : 1, fx ? x + pc.w : x, fy ? y + pc.h : y);
      ctx.drawImage(pc.canvas, 0, 0);
      ctx.restore();
      const r = { x0: x, y0: y, x1: x + pc.w, y1: y + pc.h };
      clipToSelection(r);
      s.dirty = union(s.dirty, r);
    }
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

  /* ---------- Floating piece ---------- */
  // float: { base (the piece, flipped and quarter-turned), angle (any angle on top), cx, cy (its
  // middle, fine pixels), pixel (moves in whole squares, turns with RotSprite), render (the
  // piece as shown), x, y, under (the picture without it), drawn (where it was last drawn),
  // lifted (the box it came from), was (the selection before) }

  function renderFloat() {
    const f = float;
    f.render = f.angle ? turnPieceBy(f.base, f.angle, { pixel: f.pixel, k }) : f.base;
    f.segs = null;
    placeFloat();
  }
  function placeFloat() {
    const f = float, r = f.render;
    let x = f.cx - r.w / 2, y = f.cy - r.h / 2;
    if (f.pixel) { x = Math.round(x / k) * k; y = Math.round(y / k) * k; } else { x = Math.round(x); y = Math.round(y); }
    f.x = x; f.y = y;
    drawFloat();
  }
  function drawFloat() {
    const f = float;
    const was = clampRect(f.drawn);
    if (was) {
      ctx.clearRect(was.x0, was.y0, was.x1 - was.x0, was.y1 - was.y0);
      ctx.drawImage(f.under, was.x0, was.y0, was.x1 - was.x0, was.y1 - was.y0, was.x0, was.y0, was.x1 - was.x0, was.y1 - was.y0);
    }
    ctx.drawImage(f.render.canvas, f.x, f.y);
    f.drawn = { x0: f.x, y0: f.y, x1: f.x + f.render.w, y1: f.y + f.render.h };
    api.onSelection?.();
  }
  function startFloat(piece, { cx, cy, pixel, lifted = null, was = sel }) {
    const under = make();
    under.getContext('2d').drawImage(canvas, 0, 0);
    float = { base: piece, angle: 0, cx, cy, pixel, render: piece, x: 0, y: 0, under, drawn: lifted, lifted, was };
    sel = null;
    renderFloat();
  }

  /* ---------- Polygon ---------- */

  function drawPoly() {
    const P = poly, o = P.o;
    const pts = P.hover && !P.closed ? [...P.pts, P.hover] : P.pts;
    if (o.mode === 'pixel') {
      if (P.area) restore(P.area);
      P.area = null;
      const cells = pts.map(cellOf);
      const add = r => { P.area = union(P.area, r); };
      if (P.closed && o.filled && cells.length >= 3) {
        for (const f of flips(o.symmetry)) {
          const fc = cells.map(c => ({ x: (f[0] ? width - 1 - c.x : c.x) + 0.5, y: (f[1] ? height - 1 - c.y : c.y) + 0.5 }));
          for (const [y, xa, xb] of cellPolygon(fc)) add(paintCells(xa, y, xb - xa + 1, 1, { ...o, symmetry: 'none' }));
        }
      }
      const n = cells.length, edges = P.closed ? n : n - 1;
      for (let i = 0; i < Math.max(edges, 1); i++) {
        const a = cells[i], b = cells[(i + 1) % n] || a;
        for (const q of cellLine(a, b)) add(paintCells(...block(q, o.size), o));
      }
    } else {
      freePolygon(P.s, pts, P.closed);
      compose(P.s);
    }
  }

  /* ---------- The engine ---------- */

  const api = {
    canvas, width, height, scale: k, W, H,
    onChange: null,
    onSelection: null,
    get drawing() { return !!stroke; },
    cellOf,

    /**
     * Start a stroke. o: { tool: pen|eraser|line|rect|ellipse|fill|gradient|effect|stamp,
     * mode: pixel|free, color, color2, opacity, size (squares in pixel mode, fine pixels in free
     * mode), soft, filled, fillAll, pixelPerfect, symmetry: none|x|y|xy, wrap (Tiles), and the
     * gradient (gradShape, gradTo, gradArea, gradSteps, gradDither), effect brush (fx, strength,
     * fxPalette, fxDither) and stamp (stampPiece, stampGap) options }.
     */
    begin(o, p) {
      if (stroke) api.cancel();
      api.finishPending();
      o = { ...o, erase: o.tool === 'eraser' };
      takeSnap();
      if (o.tool === 'fill') {
        let area = null;
        for (const q of flips(o.symmetry).map(f => flipPoint(p, f))) area = union(area, fillAt(q, o));
        if (rememberArea(area)) api.onChange?.();
        return false;
      }
      if (o.tool === 'gradient') {
        const area = sel ? sel.mask : o.gradArea === 'area' ? regionMask(p, { ...o, fillAll: false, wrap: false }) : null;
        let box = area ? maskBox(area, W, H) : FULL;
        if (!box) return false;
        if (o.mode === 'pixel') box = { x0: Math.floor(box.x0 / k) * k, y0: Math.floor(box.y0 / k) * k, x1: Math.ceil(box.x1 / k) * k, y1: Math.ceil(box.y1 / k) * k };
        stroke = { type: 'gradient', o, a: p, b: p, area, box, base: sctx.getImageData(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0), dirty: box };
        return true;
      }
      if (o.tool === 'effect') {
        const seed = (Math.random() * 1e9) | 0;
        const c1 = colorOf(o.color), c2 = colorOf(o.color2 || '#ffffff');
        if (o.mode === 'pixel') {
          const c = cellOf(p);
          const base = { d: sctx.getImageData(0, 0, W, H).data, W, H, k };
          stroke = { type: 'fxcell', o, last: c, visited: new Uint8Array(width * height), cells: cellsOf(base), seed, c1, c2, dirty: null };
          fxCells(stroke, c);
        } else {
          startSheet(o);
          stroke = { type: 'fxfree', o, pts: [p], dirty: null, fd: null, tip: o.soft ? softTip(o.size) : null, base: sctx.getImageData(0, 0, W, H).data, seed, c1, c2 };
          freeDot(stroke, p);
          fxCompose(stroke);
        }
        return true;
      }
      if (o.tool === 'stamp') {
        if (!o.stampPiece) return false;
        const gap = o.stampGap > 0 ? o.stampGap * k : Math.max(o.stampPiece.w, o.stampPiece.h);
        stroke = { type: 'stamp', o, last: p, gap, dirty: null };
        stampAt(stroke, p);
        return true;
      }
      o.fillStyle = rgba(o.color, o.opacity);
      if (o.mode === 'pixel') {
        const c = cellOf(p);
        stroke = { type: 'pixel', o, start: c, last: c, path: [c], counts: new Map(), dirty: null, shape: null };
        if (o.tool === 'pen' || o.tool === 'eraser') api._paintPath(c);
        else api._pixelShape(c);
      } else {
        startSheet(o);
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
      if (s.type === 'gradient') {
        s.b = constrain ? constrainTo(s.a, p, true) : p;
        s.needsCompose = true;
        return;
      }
      if (s.type === 'stamp') {
        let dist = Math.hypot(p.x - s.last.x, p.y - s.last.y);
        while (dist >= s.gap) {
          const t = s.gap / dist;
          s.last = { x: s.last.x + (p.x - s.last.x) * t, y: s.last.y + (p.y - s.last.y) * t };
          stampAt(s, s.last);
          dist = Math.hypot(p.x - s.last.x, p.y - s.last.y);
        }
        return;
      }
      if (s.type === 'fxcell') {
        const c = cellOf(p);
        if (c.x === s.last.x && c.y === s.last.y) return;
        for (const q of cellLine(s.last, c).slice(1)) fxCells(s, q);
        s.last = c;
        return;
      }
      if (s.type === 'fxfree') {
        const last = s.pts[s.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < 0.75) return;
        s.pts.push(p);
        const n = s.pts.length;
        freeSegment(s, s.pts[Math.max(0, n - 3)], s.pts[n - 2], p);
        s.needsCompose = true;
        return;
      }
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

    /** Strokes that need more work are shown once per screen frame (the editor calls this). */
    show() {
      const s = stroke;
      if (!s?.needsCompose) return;
      s.needsCompose = false;
      if (s.type === 'free') compose(s);
      else if (s.type === 'fxfree') fxCompose(s);
      else if (s.type === 'gradient') gradientCompose(s);
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
      } else if (s.type === 'fxfree') {
        if (s.pts.length > 1) { const n = s.pts.length; freeSegment(s, s.pts[n - 2], s.pts[n - 1], s.pts[n - 1]); }
        fxCompose(s);
      } else if (s.type === 'gradient') {
        if (s.a.x === s.b.x && s.a.y === s.b.y) { restore(s.box); stroke = null; return false; }   // a tap, no gradient
        gradientCompose(s);
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

    /** While dragging a gradient: its start and end (for the line on screen). */
    get gradientLine() { return stroke?.type === 'gradient' ? { a: stroke.a, b: stroke.b } : null; },

    /** The colour at a point ({ r, g, b, a }), the middle of the square in pixel mode. */
    pick(p, mode) {
      let x = Math.floor(p.x), y = Math.floor(p.y);
      if (mode === 'pixel') { const c = cellOf(p); x = c.x * k + (k >> 1); y = c.y * k + (k >> 1); }
      if (x < 0 || y < 0 || x >= W || y >= H) return null;
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] };
    },

    /* ---------- Selection ---------- */

    get selection() {
      if (float) {
        float.segs ||= outlineOf(float.render.mask, float.render.w, float.render.h);
        return { segs: float.segs, x: float.x, y: float.y, box: { x0: float.x, y0: float.y, x1: float.x + float.render.w, y1: float.y + float.render.h }, floating: true };
      }
      if (!sel) return null;
      sel.segs ||= outlineOf(sel.mask, W, H, sel.box);
      return { segs: sel.segs, x: 0, y: 0, box: sel.box, floating: false };
    },
    get hasSelection() { return !!sel || !!float; },
    get floating() { return !!float; },
    get floatAngle() { return float ? float.angle : 0; },
    inSelection(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      return !!sel && x >= 0 && y >= 0 && x < W && y < H && !!sel.mask[y * W + x];
    },
    hitFloat(p, pad = 0) {
      if (!float) return false;
      return p.x >= float.x - pad && p.y >= float.y - pad && p.x < float.x + float.render.w + pad && p.y < float.y + float.render.h + pad;
    },

    /**
     * Select: kind "rect" ({ a, b }), "poly" ({ pts }) or "wand" ({ p }); op new | add | subtract.
     * mode pixel = whole squares. The wand looks at the whole picture (all = everywhere).
     */
    select(kind, data, { op = 'new', mode = 'pixel', all = false, tolerance = 32 } = {}) {
      api.commitFloat();
      const pixel = mode === 'pixel';
      let m = null;
      if (kind === 'rect') {
        const { a, b } = data;
        if (pixel) {
          const ca = cellOf(a), cb = cellOf(b);
          m = rectMask(W, H, Math.min(ca.x, cb.x) * k, Math.min(ca.y, cb.y) * k, (Math.max(ca.x, cb.x) + 1) * k, (Math.max(ca.y, cb.y) + 1) * k);
        } else m = rectMask(W, H, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
      } else if (kind === 'poly') {
        if (data.pts.length < 3) return false;
        m = polygonMask(W, H, data.pts, k, pixel);
      } else if (kind === 'wand') {
        m = regionMask(data.p, { mode, fillAll: all, tolerance }, false);
      }
      if (!m) return false;
      setSelection(combineMasks(sel?.mask || null, m, op));
      return true;
    },
    selectAll() { api.commitFloat(); setSelection(new Uint8Array(W * H).fill(1)); },
    deselect() { api.commitFloat(); if (sel) setSelection(null); },
    invertSelection() {
      api.commitFloat();
      if (!sel) return;
      const m = new Uint8Array(W * H);
      for (let i = 0; i < m.length; i++) m[i] = sel.mask[i] ? 0 : 1;
      setSelection(m);
    },
    /** Clear what's selected (Delete). A floating piece is dropped where it came from (its hole stays). */
    clearSelected() {
      if (float) {
        const f = float;
        float = null;
        restoreFloatUnder(f);
        const changed = rememberArea(union(f.lifted, f.drawn));
        setSelection(null);
        if (changed) api.onChange?.();
        return true;
      }
      if (!sel) return false;
      takeSnap();
      const b = sel.box, w = b.x1 - b.x0, hh = b.y1 - b.y0;
      const img = ctx.getImageData(b.x0, b.y0, w, hh);
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (sel.mask[(y + b.y0) * W + x + b.x0]) img.data[(y * w + x) * 4 + 3] = 0;
      ctx.putImageData(img, b.x0, b.y0);
      if (rememberArea(b)) api.onChange?.();
      return true;
    },

    /** The selected part (or the floating piece) as it looks now: { piece, at: { x, y } }. Everything if nothing is selected. */
    copyPiece() {
      if (float) return { piece: clonePiece(float.render), at: { x: float.x, y: float.y } };
      const mask = sel ? sel.mask : new Uint8Array(W * H).fill(1);
      const box = sel ? sel.box : FULL;
      return { piece: cropPiece(canvas, mask, W, box), at: { x: box.x0, y: box.y0 } };
    },

    /* ---------- Floating piece ---------- */

    /** Lift the selection off the picture to move or turn it (copy: leave the original where it is). */
    lift({ mode = 'pixel', copy = false } = {}) {
      if (float) return true;
      api.finishPending();
      const was = sel;
      if (!sel) setSelection(new Uint8Array(W * H).fill(1));
      takeSnap();
      const b = sel.box;
      const piece = cropPiece(canvas, sel.mask, W, b);
      if (!copy) {
        const w = b.x1 - b.x0, hh = b.y1 - b.y0;
        const img = ctx.getImageData(b.x0, b.y0, w, hh);
        for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (sel.mask[(y + b.y0) * W + x + b.x0]) img.data[(y * w + x) * 4 + 3] = 0;
        ctx.putImageData(img, b.x0, b.y0);
      }
      startFloat(piece, { cx: b.x0 + piece.w / 2, cy: b.y0 + piece.h / 2, pixel: mode === 'pixel', lifted: { ...b }, was });
      return true;
    },
    /** Put a piece on the picture as a floating piece, its top-left at x, y. */
    pasteFloat(piece, { x, y, pixel }) {
      api.finishPending();
      takeSnap();
      startFloat(clonePiece(piece), { cx: x + piece.w / 2, cy: y + piece.h / 2, pixel });
    },
    /** Move the floating piece so its middle is at cx, cy (whole squares for pixel art). */
    moveFloatTo(cx, cy) {
      if (!float) return;
      float.cx = cx; float.cy = cy;
      placeFloat();
    },
    get floatCenter() { return float ? { x: float.cx, y: float.cy } : null; },
    /** Nudge by whole squares (pixel art) or fine pixels. */
    nudgeFloat(dx, dy) {
      if (!float) return;
      const u = float.pixel ? k : 1;
      api.moveFloatTo(float.cx + dx * u, float.cy + dy * u);
    },
    flipFloat(horizontal) {
      if (!float) return;
      float.base = flipPiece(float.base, horizontal);
      float.angle = -float.angle;
      renderFloat();
    },
    turnFloat(q) {
      if (!float) return;
      float.base = turnPiece(float.base, q);
      renderFloat();
    },
    setFloatAngle(deg) {
      if (!float) return;
      float.angle = ((((deg + 180) % 360) + 360) % 360) - 180;
      renderFloat();
    },
    /** Lay the floating piece down (one Undo step). The selection becomes its shape. */
    commitFloat() {
      const f = float;
      if (!f) return false;
      float = null;
      const changed = rememberArea(union(f.lifted, f.drawn));
      const m = new Uint8Array(W * H);
      const r = f.render;
      for (let y = 0; y < r.h; y++) {
        const yy = y + f.y;
        if (yy < 0 || yy >= H) continue;
        for (let x = 0; x < r.w; x++) {
          const xx = x + f.x;
          if (xx >= 0 && xx < W && r.mask[y * r.w + x]) m[yy * W + xx] = 1;
        }
      }
      setSelection(m);
      if (changed) api.onChange?.();
      return true;
    },
    /** Put everything back the way it was before the piece was lifted or pasted. */
    cancelFloat() {
      const f = float;
      if (!f) return false;
      float = null;
      restore(union(f.lifted, f.drawn));
      sel = f.was;
      api.onSelection?.();
      return true;
    },

    /* ---------- Polygon ---------- */

    get polygon() { return poly ? { pts: poly.pts, closed: poly.closed } : null; },
    polyAdd(o, p) {
      if (!poly) {
        api.finishPending();
        if (stroke) api.cancel();
        takeSnap();
        o = { ...o, fillStyle: rgba(o.color, o.opacity), erase: false };
        if (o.mode !== 'pixel') startSheet(o);
        poly = { o, pts: [p], hover: null, area: null, closed: false, s: { type: 'free', o, dirty: null, shapeArea: null } };
      } else poly.pts.push(p);
      drawPoly();
    },
    polyMoveLast(p, constrain = false) {
      if (!poly) return;
      const n = poly.pts.length;
      poly.pts[n - 1] = constrain && n > 1 ? constrainTo(poly.pts[n - 2], p, true) : p;
      drawPoly();
    },
    polyHover(p, constrain = false) {
      if (!poly) return;
      poly.hover = p && constrain ? constrainTo(poly.pts[poly.pts.length - 1], p, true) : p;
      drawPoly();
    },
    /** Take back the last corner (the polygon goes when none are left). */
    polyBack() {
      if (!poly) return false;
      poly.pts.pop();
      if (!poly.pts.length) { api.polyCancel(); return true; }
      drawPoly();
      return true;
    },
    /** Close the polygon and lay it down (one Undo step). */
    polyClose() {
      const P = poly;
      if (!P) return false;
      if (P.pts.length < 2) { api.polyCancel(); return false; }
      P.hover = null;
      P.closed = P.pts.length >= 3;
      drawPoly();
      poly = null;
      const changed = rememberArea(P.o.mode === 'pixel' ? P.area : P.s.dirty);
      if (changed) api.onChange?.();
      return changed;
    },
    polyCancel() {
      const P = poly;
      if (!P) return;
      restore(P.o.mode === 'pixel' ? P.area : P.s.dirty);
      poly = null;
    },

    /** Lay down a floating piece and finish a polygon (before saving, other tools, Undo…). */
    finishPending() {
      api.commitFloat();
      if (poly) api.polyClose();
    },

    /* ---------- Whole-picture changes ---------- */

    /**
     * Change the picture with fn(pixel context) (see effects.js); one Undo step. Only inside the
     * selection when there is one. Returns whether anything changed.
     */
    applyEffect(fn, mode = 'pixel') {
      if (stroke) api.cancel();
      api.finishPending();
      const img = api.previewEffect(fn, mode);
      if (!img) return false;
      const before = ctx.getImageData(0, 0, W, H);
      ctx.putImageData(img, 0, 0);
      remember({ x: 0, y: 0, before, after: img });
      api.onChange?.();
      return true;
    },
    /** What applyEffect would make, without changing anything (for previews). Null if nothing changes. */
    previewEffect(fn, mode = 'pixel') {
      const img = ctx.getImageData(0, 0, W, H);
      const before = sel ? new Uint8ClampedArray(img.data) : null;
      if (fn({ d: img.data, W, H, k, mode, sel: sel?.mask || null }) === false) return null;
      if (sel) {
        const d = img.data, m = sel.mask;
        for (let j = 0; j < m.length; j++) if (!m[j]) { const i = j * 4; d[i] = before[i]; d[i + 1] = before[i + 1]; d[i + 2] = before[i + 2]; d[i + 3] = before[i + 3]; }
      }
      return img;
    },

    /** Change every pixel with fn(data); one Undo step (inside the selection only). Returns whether anything changed. */
    applyPixels(fn) {
      return api.applyEffect(pc => fn(pc.d));
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
      if (float) { api.cancelFloat(); return true; }
      if (poly) { api.polyBack(); return true; }
      const e = undos.pop();
      if (!e) return false;
      ctx.putImageData(e.before, e.x, e.y);
      redos.push(e);
      api.onChange?.();
      return true;
    },
    redo() {
      if (float || poly) return false;
      const e = redos.pop();
      if (!e) return false;
      ctx.putImageData(e.after, e.x, e.y);
      undos.push(e);
      api.onChange?.();
      return true;
    },
    canUndo: () => undos.length > 0 || !!float || !!poly,
    canRedo: () => redos.length > 0 && !float && !poly,
    /** Forget Undo/Redo (the picture was replaced, e.g. by a newer one from another device). */
    resetHistory() {
      undos = []; redos = []; bytes = 0;
      float = null; poly = null;
      if (sel) setSelection(null);
    },

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

  /** Drop a floating piece without laying it down: the picture shows what's under it. */
  function restoreFloatUnder(f) {
    const was = clampRect(f.drawn);
    if (!was) return;
    ctx.clearRect(was.x0, was.y0, was.x1 - was.x0, was.y1 - was.y0);
    ctx.drawImage(f.under, was.x0, was.y0, was.x1 - was.x0, was.y1 - was.y0, was.x0, was.y0, was.x1 - was.x0, was.y1 - was.y0);
  }

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
