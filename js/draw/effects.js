// Colour and look effects on the drawing's picture (part 2e): pure pixel maths, no screens.
//
// They work on "pixel context" objects: { d, W, H, k, mode, sel }
//   d     the picture's RGBA bytes at the fine size (changed in place)
//   W, H  the fine size; k = fine pixels per square
//   mode  "pixel": effects that look at neighbours (blur, outline, pixelate, noise) work in whole
//         squares, so pixel art stays pixel art; "free": they work on the fine pixels
//   sel   the selection (1 byte per fine pixel, 1 = selected) or null; the engine puts back
//         everything outside it afterwards
// Effects that only change a colour (hue, saturation, lightness) always work on the fine
// pixels: in pixel art every square is one colour anyway, and details drawn with the free pen
// inside a square are kept.

/* ---------- Colour maths ---------- */

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue;
  if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return [hue * 60, s, l];
}
export function hslToRgb(hue, s, l) {
  hue = ((hue % 360) + 360) % 360 / 360;
  if (!s) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(hue + 1 / 3) * 255), Math.round(f(hue) * 255), Math.round(f(hue - 1 / 3) * 255)];
}
export const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** A small, repeatable random number maker (the same seed gives the same noise). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A random number in 0..1 for a spot (the same spot and seed always give the same number). */
export function hashNoise(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ---------- Dither patterns (ordered, "Bayer") ---------- */

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const BAYER2 = [0, 2, 3, 1];
/** The pattern's threshold (0..1) at a square: "checker" (2 x 2) or "ordered" (4 x 4). */
export function ditherThreshold(kind, x, y) {
  x = ((x % 4) + 4) % 4; y = ((y % 4) + 4) % 4;
  if (kind === 'checker') return (BAYER2[(y % 2) * 2 + (x % 2)] + 0.5) / 4;
  return (BAYER4[y * 4 + x] + 0.5) / 16;
}

/* ---------- One colour at a time (also used by the effect brush) ---------- */

/** Hue (degrees), saturation and lightness (-1..1 each) changes for one colour. */
export function adjustColor(r, g, b, { hue = 0, sat = 0, light = 0 }) {
  let [hh, s, l] = rgbToHsl(r, g, b);
  hh += hue;
  if (sat > 0) s += (1 - s) * sat; else if (sat < 0) s *= 1 + sat;
  if (light > 0) l += (1 - l) * light; else if (light < 0) l *= 1 + light;
  return hslToRgb(hh, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
}

/** Hue, saturation and lightness for every coloured pixel. */
export function adjustData(pc, opts) {
  const { d } = pc;
  if (!opts.hue && !opts.sat && !opts.light) return false;
  const cache = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let v = cache.get(key);
    if (!v) { v = adjustColor(d[i], d[i + 1], d[i + 2], opts); cache.set(key, v); }
    d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2];
  }
  return true;
}

/**
 * "Along the palette": the palette colour that is lighter (up) or darker (down) than this one
 * and closest to it in colour, or null when there's none.
 */
export function paletteStep(r, g, b, palette, up) {
  const l0 = luma(r, g, b);
  let best = null, bd = Infinity;
  for (const p of palette) {
    const l = luma(p[0], p[1], p[2]);
    if (up ? l <= l0 + 2 : l >= l0 - 2) continue;
    // Close in colour, and not a big jump in brightness.
    const dist = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2 + 2 * (l - l0) ** 2;
    if (dist < bd) { bd = dist; best = p; }
  }
  return best;
}

/* ---------- Squares <-> fine pixels ---------- */

/** The colour of every square (its middle fine pixel), as RGBA bytes width x height. */
export function cellsOf(pc) {
  const { d, W, k } = pc, w = W / k, hh = pc.H / k;
  const out = new Uint8ClampedArray(w * hh * 4);
  const m = k >> 1;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const i = ((y * k + m) * W + x * k + m) * 4, j = (y * w + x) * 4;
    out[j] = d[i]; out[j + 1] = d[i + 1]; out[j + 2] = d[i + 2]; out[j + 3] = d[i + 3];
  }
  return out;
}
/** Write squares back: only squares whose colour changed are filled (other details are kept). */
export function writeCells(pc, before, after) {
  const { d, W, k } = pc, w = W / k, hh = pc.H / k;
  let changed = false;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const j = (y * w + x) * 4;
    if (before[j] === after[j] && before[j + 1] === after[j + 1] && before[j + 2] === after[j + 2] && before[j + 3] === after[j + 3]) continue;
    changed = true;
    for (let yy = 0; yy < k; yy++) {
      let i = ((y * k + yy) * W + x * k) * 4;
      for (let xx = 0; xx < k; xx++, i += 4) { d[i] = after[j]; d[i + 1] = after[j + 1]; d[i + 2] = after[j + 2]; d[i + 3] = after[j + 3]; }
    }
  }
  return changed;
}

/* ---------- Blur ---------- */

/** Box blur (3 passes ≈ smooth), with see-through handled properly. In place on RGBA bytes. */
export function blurRGBA(src, w, hh, radius) {
  const r = Math.max(1, Math.round(radius));
  const n = w * hh;
  // Premultiplied floats.
  let a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const al = src[i * 4 + 3] / 255;
    a[i * 4] = src[i * 4] * al; a[i * 4 + 1] = src[i * 4 + 1] * al; a[i * 4 + 2] = src[i * 4 + 2] * al; a[i * 4 + 3] = src[i * 4 + 3];
  }
  let b = new Float32Array(n * 4);
  const pass = (from, to, horizontal) => {
    const len = horizontal ? w : hh, lines = horizontal ? hh : w;
    const step = horizontal ? 4 : w * 4;
    for (let line = 0; line < lines; line++) {
      const base = horizontal ? line * w * 4 : line * 4;
      for (let c = 0; c < 4; c++) {
        let sum = 0, cnt = 0;
        for (let i = 0; i <= r && i < len; i++) { sum += from[base + i * step + c]; cnt++; }
        for (let i = 0; i < len; i++) {
          to[base + i * step + c] = sum / cnt;
          const add = i + r + 1, rem = i - r;
          if (add < len) { sum += from[base + add * step + c]; cnt++; }
          if (rem >= 0) { sum -= from[base + rem * step + c]; cnt--; }
        }
      }
    }
  };
  for (let p = 0; p < 3; p++) { pass(a, b, true); pass(b, a, false); }
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const al = a[i * 4 + 3];
    if (al > 0.5) {
      const f = 255 / al;
      out[i * 4] = a[i * 4] * f; out[i * 4 + 1] = a[i * 4 + 1] * f; out[i * 4 + 2] = a[i * 4 + 2] * f; out[i * 4 + 3] = al;
    }
  }
  return out;
}

/** Blur: whole squares (pixel pen, radius in squares) or fine pixels (free pen). */
export function blurData(pc, { radius }) {
  if (pc.mode === 'pixel') {
    const before = cellsOf(pc);
    return writeCells(pc, before, blurRGBA(before, pc.W / pc.k, pc.H / pc.k, radius));
  }
  const out = blurRGBA(pc.d, pc.W, pc.H, radius);
  pc.d.set(out);
  return true;
}

/* ---------- Noise ---------- */

/** Brightness noise: every square (pixel pen) or fine pixel (free pen) gets lighter or darker. */
export function noiseData(pc, { amount, seed = 1 }) {
  const { d, W, k } = pc;
  if (!amount) return false;
  const spread = amount * 90;
  const perCell = pc.mode === 'pixel';
  for (let y = 0; y < pc.H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (!d[i + 3]) continue;
    const n = (perCell ? hashNoise(Math.floor(x / k), Math.floor(y / k), seed) : hashNoise(x, y, seed)) * 2 - 1;
    const v = n * spread;
    d[i] = clamp255(d[i] + v); d[i + 1] = clamp255(d[i + 1] + v); d[i + 2] = clamp255(d[i + 2] + v);
  }
  return true;
}

/* ---------- Pixelate ---------- */

/** Big blocks of one colour (block size in squares). On a free drawing, 1 square = crisp pixel art. */
export function pixelateData(pc, { block }) {
  const { d, W, H, sel } = pc;
  const b = Math.max(1, Math.round(block * pc.k));
  if (b <= 1) return false;
  for (let by = 0; by < H; by += b) for (let bx = 0; bx < W; bx += b) {
    let r = 0, g = 0, bl = 0, a = 0, n = 0;
    const x1 = Math.min(W, bx + b), y1 = Math.min(H, by + b);
    for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) {
      const j = y * W + x;
      if (sel && !sel[j]) continue;
      const i = j * 4, al = d[i + 3];
      r += d[i] * al; g += d[i + 1] * al; bl += d[i + 2] * al; a += al; n++;
    }
    if (!n) continue;
    const R = a ? r / a : 0, G = a ? g / a : 0, B = a ? bl / a : 0, A = a / n;
    for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) {
      const j = y * W + x;
      if (sel && !sel[j]) continue;
      const i = j * 4;
      d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = A;
    }
  }
  return true;
}

/* ---------- Outline ---------- */

/**
 * Grow (dilate) a shape: square corners = 8 neighbours each step; round = 4 and 8 neighbours
 * taking turns (an octagon, close to a circle). Returns how far each spot is (0 = in the shape,
 * 255 = further than `steps`).
 */
function distances(filled, w, hh, steps, round) {
  const dist = new Uint8Array(w * hh).fill(255);
  let front = [];
  for (let i = 0; i < w * hh; i++) if (filled[i]) { dist[i] = 0; front.push(i); }
  for (let s = 1; s <= steps && front.length; s++) {
    const diag = !round || s % 2 === 0;
    const next = [];
    for (const i of front) {
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (dx && dy && !diag) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= hh) continue;
        const j = ny * w + nx;
        if (dist[j] === 255) { dist[j] = s; next.push(j); }
      }
    }
    front = next;
  }
  return dist;
}

/**
 * Outline: colour [r, g, b, a] around the drawn shapes (outside) or along their inner edge
 * (inside); thickness in squares (pixel pen) or fine pixels (free pen).
 */
export function outlineData(pc, { color, where = 'outside', thickness = 1, corners = 'square' }) {
  const pixel = pc.mode === 'pixel';
  const w = pixel ? pc.W / pc.k : pc.W, hh = pixel ? pc.H / pc.k : pc.H;
  const img = pixel ? cellsOf(pc) : pc.d;
  const t = Math.max(1, Math.round(thickness));
  const round = corners === 'round';
  const filled = new Uint8Array(w * hh);
  for (let i = 0; i < w * hh; i++) filled[i] = img[i * 4 + 3] >= 128 ? 1 : 0;
  let paint;
  if (where === 'inside') {
    // Inside: the shape's own spots near an empty spot (or the edge of the picture).
    const empty = new Uint8Array((w + 2) * (hh + 2)).fill(1);
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) empty[(y + 1) * (w + 2) + x + 1] = filled[y * w + x] ? 0 : 1;
    const dist = distances(empty, w + 2, hh + 2, t, round);
    paint = new Uint8Array(w * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const dd = dist[(y + 1) * (w + 2) + x + 1]; if (dd >= 1 && dd <= t) paint[y * w + x] = 1; }
  } else {
    const dist = distances(filled, w, hh, t, round);
    paint = new Uint8Array(w * hh);
    for (let i = 0; i < w * hh; i++) if (dist[i] >= 1 && dist[i] <= t) paint[i] = 1;
  }
  const [cr, cg, cb, ca] = color;
  let changed = false;
  const put = i => {
    // Lay the colour over what's there (an outline colour that is partly see-through blends).
    const da = pc.d[i + 3] / 255, sa = ca / 255, oa = sa + da * (1 - sa);
    if (!oa) return;
    pc.d[i] = (cr * sa + pc.d[i] * da * (1 - sa)) / oa;
    pc.d[i + 1] = (cg * sa + pc.d[i + 1] * da * (1 - sa)) / oa;
    pc.d[i + 2] = (cb * sa + pc.d[i + 2] * da * (1 - sa)) / oa;
    pc.d[i + 3] = oa * 255;
  };
  if (pixel) {
    const { W, k } = pc;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      if (!paint[y * w + x]) continue;
      changed = true;
      for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) put(((y * k + yy) * W + x * k + xx) * 4);
    }
  } else {
    for (let i = 0; i < w * hh; i++) if (paint[i]) { changed = true; put(i * 4); }
  }
  return changed;
}

/* ---------- Gradient ---------- */

/**
 * Lay a gradient over part of the picture: from `a` to `b` (fine pixels of the whole picture),
 * straight or round, colour c1 to c2 ([r, g, b, a] each).
 * pc: { d, W, H, k, mode, ox, oy, FW } where d is a box of the picture (W x H, its top-left at
 * ox, oy; cell-aligned for the pixel pen) and FW the whole picture's width.
 * area: 1 byte per fine pixel of the whole picture (where it goes) or null (everywhere).
 * Pixel pen: whole squares, `steps` colours (0 = as many as needed) mixed with a dither pattern
 * ("off", "checker", "ordered"). Free pen: smooth.
 */
export function gradientData(pc, { a, b, shape = 'straight', c1, c2, opacity = 1, steps = 4, dither = 'ordered', area = null }) {
  const { d, W, H, k } = pc;
  const ox = pc.ox || 0, oy = pc.oy || 0, FW = pc.FW || W;
  const pixel = pc.mode === 'pixel';
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1, len = Math.sqrt(len2);
  const tAt = (x, y) => {
    const t = shape === 'round' ? Math.hypot(x - a.x, y - a.y) / len : ((x - a.x) * dx + (y - a.y) * dy) / len2;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };
  const mix = t => [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t, (c1[3] + (c2[3] - c1[3]) * t) * opacity];
  const over = (i, col) => {
    const sa = col[3] / 255;
    if (sa <= 0) return;
    const da = d[i + 3] / 255, oa = sa + da * (1 - sa);
    d[i] = (col[0] * sa + d[i] * da * (1 - sa)) / oa;
    d[i + 1] = (col[1] * sa + d[i + 1] * da * (1 - sa)) / oa;
    d[i + 2] = (col[2] * sa + d[i + 2] * da * (1 - sa)) / oa;
    d[i + 3] = oa * 255;
  };
  if (pixel) {
    const w = W / k, hh = H / k, m = k >> 1, cx0 = ox / k, cy0 = oy / k;
    for (let cy = 0; cy < hh; cy++) for (let cx = 0; cx < w; cx++) {
      if (area && !area[(oy + cy * k + m) * FW + ox + cx * k + m]) continue;
      let t = tAt(ox + cx * k + k / 2, oy + cy * k + k / 2);
      if (steps >= 2) {
        const level = t * (steps - 1);
        let lo = Math.floor(level);
        const frac = level - lo;
        if (dither === 'off') lo = Math.round(level);
        else if (frac > ditherThreshold(dither, cx0 + cx, cy0 + cy)) lo += 1;
        t = Math.min(steps - 1, lo) / (steps - 1);
      }
      const col = mix(t);
      for (let yy = 0; yy < k; yy++) {
        let i = ((cy * k + yy) * W + cx * k) * 4;
        for (let xx = 0; xx < k; xx++, i += 4) over(i, col);
      }
    }
  } else {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (area && !area[(y + oy) * FW + x + ox]) continue;
      over((y * W + x) * 4, mix(tAt(x + ox + 0.5, y + oy + 0.5)));
    }
  }
}

/* ---------- The effect brush ---------- */

export const BRUSH_EFFECTS = {
  lighten: 'Lighten',
  darken: 'Darken',
  hue: 'Hue shift',
  saturate: 'More colour',
  desaturate: 'Less colour',
  smooth: 'Smooth',
  noise: 'Noise',
  dither: 'Dither',
};

/**
 * What the effect brush makes of one colour, at full strength `s` (0..1). `palette` (a list of
 * [r, g, b]) makes Lighten/Darken step to the next palette colour instead.
 */
export function brushColor(kind, r, g, b, s, { palette = null, x = 0, y = 0, seed = 1 } = {}) {
  switch (kind) {
    case 'lighten':
    case 'darken': {
      if (palette?.length) {
        const p = paletteStep(r, g, b, palette, kind === 'lighten');
        return p ? [p[0], p[1], p[2]] : [r, g, b];
      }
      return adjustColor(r, g, b, { light: kind === 'lighten' ? s * 0.5 : -s * 0.5 });
    }
    case 'hue': return adjustColor(r, g, b, { hue: s * 180 });
    case 'saturate': return adjustColor(r, g, b, { sat: s });
    case 'desaturate': return adjustColor(r, g, b, { sat: -s });
    case 'noise': { const v = (hashNoise(x, y, seed) * 2 - 1) * s * 90; return [clamp255(r + v), clamp255(g + v), clamp255(b + v)]; }
    default: return [r, g, b];
  }
}
