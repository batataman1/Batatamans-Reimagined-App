// Selections and pieces (part 2e): the maths behind Select, Move, Copy, Paste, Flip and Turn.
//
// A selection is a mask: one byte per fine pixel of the picture, 1 = selected.
// A piece is part of a picture lifted off it (to move, paste, flip or turn):
//   { canvas, mask, w, h }   fine pixels; mask = which of them belong to the piece.
//
// Turning by any angle:
//   - pixel pen: RotSprite. The squares are blown up 8 times with Scale2x (which rounds off
//     stair-steps into smooth slopes instead of making bigger blocks), that picture is turned,
//     and then it's brought back to the size of the squares, taking the middle of each 8 x 8
//     block. Lines stay one square thin and clean, with no blur and no new colours.
//   - free pen: a smooth turn (with soft edges), like a photo editor.
// Flips and quarter turns are exact either way.

const canvasOf = (w, h) => Object.assign(document.createElement('canvas'), { width: Math.max(1, w), height: Math.max(1, h) });
const ctx2d = c => c.getContext('2d', { willReadFrequently: true });

/* ---------- Masks ---------- */

/** A rectangle, x1/y1 not included (fine pixels). */
export function rectMask(W, H, x0, y0, x1, y1) {
  const m = new Uint8Array(W * H);
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  for (let y = y0; y < y1; y++) m.fill(1, y * W + x0, y * W + x1);
  return m;
}

/**
 * The inside of a free shape (points in fine pixels). Pixel pen: whole squares whose middle is
 * inside; free pen: fine pixels.
 */
export function polygonMask(W, H, pts, k, pixel) {
  const f = pixel ? k : 1;
  const w = Math.round(W / f), hh = Math.round(H / f);
  const c = canvasOf(w, hh), g = ctx2d(c);
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p.x / f, p.y / f) : g.moveTo(p.x / f, p.y / f)));
  g.closePath();
  g.fillStyle = '#000';
  g.fill('evenodd');
  const d = g.getImageData(0, 0, w, hh).data;
  const small = new Uint8Array(w * hh);
  for (let i = 0; i < w * hh; i++) small[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  return pixel ? expandCells(small, w, hh, k) : small;
}

/** A mask of squares made into a mask of fine pixels. */
export function expandCells(cells, w, hh, k) {
  const W = w * k, m = new Uint8Array(W * hh * k);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    if (!cells[y * w + x]) continue;
    for (let yy = 0; yy < k; yy++) m.fill(1, (y * k + yy) * W + x * k, (y * k + yy) * W + x * k + k);
  }
  return m;
}

/** New / add / take away. */
export function combineMasks(old, m, op) {
  if (!old || op === 'new') return m;
  const out = new Uint8Array(old);
  if (op === 'add') { for (let i = 0; i < out.length; i++) if (m[i]) out[i] = 1; }
  else if (op === 'subtract') { for (let i = 0; i < out.length; i++) if (m[i]) out[i] = 0; }
  return out;
}

/** The smallest box around the selected pixels, or null if nothing is selected. */
export function maskBox(m, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let first = -1, last = -1;
    for (let x = 0; x < W; x++) if (m[row + x]) { if (first < 0) first = x; last = x; }
    if (first < 0) continue;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * The border of a mask as line segments [x0, y0, x1, y1, …] (fine pixels), for the dashed
 * outline. Runs along a row or column are joined into one segment.
 */
export function outlineOf(m, w, hh, box = { x0: 0, y0: 0, x1: w, y1: hh }) {
  const segs = [];
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < hh ? m[y * w + x] : 0);
  for (let y = box.y0; y <= box.y1; y++) {
    let start = -1;
    for (let x = box.x0; x <= box.x1; x++) {
      const edge = x < box.x1 && at(x, y - 1) !== at(x, y);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) { segs.push(start, y, x, y); start = -1; }
    }
  }
  for (let x = box.x0; x <= box.x1; x++) {
    let start = -1;
    for (let y = box.y0; y <= box.y1; y++) {
      const edge = y < box.y1 && at(x - 1, y) !== at(x, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) { segs.push(x, start, x, y); start = -1; }
    }
  }
  return new Float32Array(segs);
}

/* ---------- Pieces ---------- */

/** Lift the selected part of a picture: a piece the size of the box. */
export function cropPiece(src, mask, W, box) {
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  const c = canvasOf(w, h), g = ctx2d(c);
  g.drawImage(src, box.x0, box.y0, w, h, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h);
  const pm = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sel = mask[(y + box.y0) * W + x + box.x0];
    pm[y * w + x] = sel;
    if (!sel) img.data[(y * w + x) * 4 + 3] = 0;
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, mask: pm, w, h };
}

/** A piece from a whole picture (pasted from outside, a stamp, text). */
export function pieceFromCanvas(c, { maskAll = true } = {}) {
  const w = c.width, h = c.height;
  const copy = canvasOf(w, h);
  ctx2d(copy).drawImage(c, 0, 0);
  const pm = new Uint8Array(w * h);
  if (maskAll) pm.fill(1);
  else { const d = ctx2d(copy).getImageData(0, 0, w, h).data; for (let i = 0; i < w * h; i++) pm[i] = d[i * 4 + 3] ? 1 : 0; }
  return { canvas: copy, mask: pm, w, h };
}

export function clonePiece(p) {
  const c = canvasOf(p.w, p.h);
  ctx2d(c).drawImage(p.canvas, 0, 0);
  return { canvas: c, mask: new Uint8Array(p.mask), w: p.w, h: p.h };
}

/** Mirror a piece left-right (horizontal) or top-bottom. */
export function flipPiece(p, horizontal) {
  const c = canvasOf(p.w, p.h), g = ctx2d(c);
  g.setTransform(horizontal ? -1 : 1, 0, 0, horizontal ? 1 : -1, horizontal ? p.w : 0, horizontal ? 0 : p.h);
  g.drawImage(p.canvas, 0, 0);
  const m = new Uint8Array(p.w * p.h);
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    m[y * p.w + x] = horizontal ? p.mask[y * p.w + (p.w - 1 - x)] : p.mask[(p.h - 1 - y) * p.w + x];
  }
  return { canvas: c, mask: m, w: p.w, h: p.h };
}

/** Turn a piece by quarter turns (1 = a quarter clockwise, -1 = anticlockwise). Exact. */
export function turnPiece(p, q) {
  q = ((q % 4) + 4) % 4;
  if (!q) return clonePiece(p);
  const w = q % 2 ? p.h : p.w, h = q % 2 ? p.w : p.h;
  const c = canvasOf(w, h), g = ctx2d(c);
  g.translate(w / 2, h / 2);
  g.rotate((q * Math.PI) / 2);
  g.drawImage(p.canvas, -p.w / 2, -p.h / 2);
  const m = new Uint8Array(w * h);
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    if (!p.mask[y * p.w + x]) continue;
    const [nx, ny] = q === 1 ? [p.h - 1 - y, x] : q === 2 ? [p.w - 1 - x, p.h - 1 - y] : [y, p.w - 1 - x];
    m[ny * w + nx] = 1;
  }
  return { canvas: c, mask: m, w, h };
}

/** The size of a w x h box turned by `rad`. */
function turnedSize(w, h, rad) {
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  return [Math.max(1, Math.ceil(w * c + h * s - 1e-6)), Math.max(1, Math.ceil(w * s + h * c - 1e-6))];
}

/** Smooth turn by any angle (free pen). */
export function smoothTurn(p, deg) {
  const rad = (deg * Math.PI) / 180;
  const [w, h] = turnedSize(p.w, p.h, rad);
  const c = canvasOf(w, h), g = ctx2d(c);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.translate(w / 2, h / 2);
  g.rotate(rad);
  g.drawImage(p.canvas, -p.w / 2, -p.h / 2);
  // The mask turns the same way.
  const mc = canvasOf(p.w, p.h), mg = ctx2d(mc);
  const mi = mg.createImageData(p.w, p.h);
  for (let i = 0; i < p.w * p.h; i++) if (p.mask[i]) mi.data[i * 4 + 3] = 255;
  mg.putImageData(mi, 0, 0);
  const tc = canvasOf(w, h), tg = ctx2d(tc);
  tg.translate(w / 2, h / 2);
  tg.rotate(rad);
  tg.drawImage(mc, -p.w / 2, -p.h / 2);
  const md = tg.getImageData(0, 0, w, h).data;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = md[i * 4 + 3] >= 128 ? 1 : 0;
  return { canvas: c, mask: m, w, h };
}

/* ---------- RotSprite ---------- */

/**
 * Scale2x (also called EPX): doubles a picture, rounding off stair-steps. Each pixel P becomes
 * four; a corner takes a neighbour's colour when the two neighbours by that corner match and
 * the other two don't.
 */
export function scale2x(src, w, h) {
  const W = w * 2, out = new Uint32Array(W * h * 2);
  const at = (x, y) => src[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const P = src[y * w + x], A = at(x, y - 1), B = at(x + 1, y), C = at(x - 1, y), D = at(x, y + 1);
    let e0 = P, e1 = P, e2 = P, e3 = P;
    if (C === A && C !== D && A !== B) e0 = A;
    if (A === B && A !== C && B !== D) e1 = B;
    if (D === C && D !== B && C !== A) e2 = C;
    if (B === D && B !== A && D !== C) e3 = D;
    const i = y * 2 * W + x * 2;
    out[i] = e0; out[i + 1] = e1; out[i + W] = e2; out[i + W + 1] = e3;
  }
  return out;
}

/**
 * Turn squares (colours as 32-bit numbers, w x h, plus their mask) by any angle with RotSprite.
 * Returns { colors, mask, w, h } in squares.
 */
export function rotSprite(colors, mask, w, h, deg) {
  const rad = (deg * Math.PI) / 180;
  // Blown up 4 times here; the last doubling (to 8 times) is worked out only where it's needed.
  let big = colors, bw = w, bh = h;
  for (let i = 0; i < 2; i++) { big = scale2x(big, bw, bh); bw *= 2; bh *= 2; }
  const at4 = (x, y) => big[Math.min(bh - 1, Math.max(0, y)) * bw + Math.min(bw - 1, Math.max(0, x))];
  const at8 = (X, Y) => {
    const x = X >> 1, y = Y >> 1;
    const P = at4(x, y), A = at4(x, y - 1), B = at4(x + 1, y), C = at4(x - 1, y), D = at4(x, y + 1);
    const right = X & 1, down = Y & 1;
    if (!right && !down) return C === A && C !== D && A !== B ? A : P;
    if (right && !down) return A === B && A !== C && B !== D ? B : P;
    if (!right && down) return D === C && D !== B && C !== A ? C : P;
    return B === D && B !== A && D !== C ? D : P;
  };
  const [ow, oh] = turnedSize(w, h, rad);
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const out = new Uint32Array(ow * oh), om = new Uint8Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
    // The middle of this square, turned back to where it came from.
    const u = ox + 0.5 - ow / 2, v = oy + 0.5 - oh / 2;
    const sx = u * cos + v * sin + w / 2, sy = -u * sin + v * cos + h / 2;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    const mx = Math.floor(sx), my = Math.floor(sy);
    if (!mask[my * w + mx]) continue;
    om[oy * ow + ox] = 1;
    out[oy * ow + ox] = at8(Math.floor(sx * 8), Math.floor(sy * 8));
  }
  return { colors: out, mask: om, w: ow, h: oh };
}

/** A piece (fine pixels) as squares: the colour in the middle of each square. */
export function pieceCells(p, k) {
  const w = Math.max(1, Math.round(p.w / k)), h = Math.max(1, Math.round(p.h / k));
  const d = ctx2d(p.canvas).getImageData(0, 0, p.w, p.h).data;
  const colors = new Uint32Array(w * h), mask = new Uint8Array(w * h);
  const view = new Uint32Array(d.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = Math.min(p.w - 1, Math.floor(x * k + k / 2)), fy = Math.min(p.h - 1, Math.floor(y * k + k / 2));
    const j = fy * p.w + fx;
    mask[y * w + x] = p.mask[j];
    colors[y * w + x] = view[j] && d[j * 4 + 3] ? view[j] : 0;
  }
  return { colors, mask, w, h };
}

/** Squares made back into a piece of fine pixels (k x k per square). */
export function cellsToPiece({ colors, mask, w, h }, k) {
  const c = canvasOf(w * k, h * k), g = ctx2d(c);
  const img = g.createImageData(w * k, h * k);
  const view = new Uint32Array(img.data.buffer);
  const W = w * k;
  const pm = new Uint8Array(W * h * k);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = colors[y * w + x], sel = mask[y * w + x];
    for (let yy = 0; yy < k; yy++) {
      const row = (y * k + yy) * W + x * k;
      if (v) view.fill(v, row, row + k);
      if (sel) pm.fill(1, row, row + k);
    }
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, mask: pm, w: W, h: h * k };
}

/** Turn a piece by any angle: RotSprite on squares (pixel pen) or smooth (free pen). */
export function turnPieceBy(p, deg, { pixel, k }) {
  const q = deg / 90;
  if (Number.isInteger(q)) return turnPiece(p, q);
  if (!pixel) return smoothTurn(p, deg);
  const c = pieceCells(p, k);
  return cellsToPiece(rotSprite(c.colors, c.mask, c.w, c.h, deg), k);
}

/** Scale a piece by f (sharp for pixel art, smooth otherwise). */
export function scalePiece(p, f, smooth) {
  if (f === 1) return clonePiece(p);
  const w = Math.max(1, Math.round(p.w * f)), h = Math.max(1, Math.round(p.h * f));
  const c = canvasOf(w, h), g = ctx2d(c);
  g.imageSmoothingEnabled = smooth;
  g.imageSmoothingQuality = 'high';
  g.drawImage(p.canvas, 0, 0, w, h);
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    m[y * w + x] = p.mask[Math.min(p.h - 1, Math.floor(y / f)) * p.w + Math.min(p.w - 1, Math.floor(x / f))];
  }
  return { canvas: c, mask: m, w, h };
}

/** One colour for a whole piece (keeps how see-through each pixel is). */
export function tintPiece(p, [r, g, b]) {
  const c = canvasOf(p.w, p.h), cg = ctx2d(c);
  cg.drawImage(p.canvas, 0, 0);
  cg.globalCompositeOperation = 'source-in';
  cg.fillStyle = `rgb(${r},${g},${b})`;
  cg.fillRect(0, 0, p.w, p.h);
  return { canvas: c, mask: new Uint8Array(p.mask), w: p.w, h: p.h };
}
