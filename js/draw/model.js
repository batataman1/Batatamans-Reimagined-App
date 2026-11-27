// Drawings and colour palettes (part 2d, the drawing studio).
//
// Collection "drawings", id "d-<random>":
// {
//   name,
//   section: section id | null,     where it shows in the Drawings gallery (like an idea)
//   idea: idea id | null,           the idea it belongs to (shown on that idea's page)
//   width, height,                  the pixel grid, in squares (16 x 16, 32 x 32, ...)
//   scale,                          fine pixels per square (the picture is width*scale x height*scale)
//   kind: "pixel" | "free",         how it was started (which pen and grid it opens with)
//   created: ISO time
// }
// The picture itself is one PNG file: files/drawings/<id>.png (fine size). There's one layer:
// the pixel pen fills whole squares, the free pen draws smooth lines on the same picture.
//
// Collection "palettes", id "p-<random>": { name, colors: ["#rrggbb", ...], order }
// Built-in palettes (below) can't be changed; "Make a copy" turns one into your own.

import { store } from '../core/store.js';
import { uid } from '../core/util.js';

export const newDrawingId = () => uid('d');
export const newPaletteId = () => uid('p');
export const drawingFile = id => `drawings/${id}.png`;
export const isDrawingFile = (path, id) => path === drawingFile(id);

/** Largest side of the fine picture: big enough for smooth lines, small enough for phones. */
const FINE = 1024;
export const MAX_SIDE = 512;

/** Fine pixels per square: a power of two, so exports at 1x, 2x, 4x... come out exact. */
export function scaleFor(width, height) {
  const side = Math.max(width, height);
  let k = 1;
  while (side * k * 2 <= FINE) k *= 2;
  return k;
}

export const PIXEL_SIZES = [16, 32, 64];
export const FREE_SHAPES = {
  square: { name: 'Square', width: 64, height: 64 },
  wide: { name: 'Wide', width: 64, height: 48 },
  tall: { name: 'Tall', width: 48, height: 64 },
};

const clampSide = v => Math.max(1, Math.min(MAX_SIDE, Math.round(Number(v) || 0)));

/** A drawing record with every key present and sane. */
export function normalizeDrawing(d) {
  const width = clampSide(d?.width || 16), height = clampSide(d?.height || 16);
  const scale = Number.isInteger(d?.scale) && d.scale >= 1 && d.scale <= 64 ? d.scale : scaleFor(width, height);
  return {
    ...d,
    name: String(d?.name || '').trim() || 'Drawing',
    section: d?.section || null,
    idea: d?.idea || null,
    width, height, scale,
    kind: d?.kind === 'free' ? 'free' : 'pixel',
  };
}

/** Everything about drawings on this device. */
export async function getDrawings() {
  const rows = await store.list('drawings');
  const files = new Map((await store.files()).filter(f => f.path.startsWith('drawings/')).map(f => [f.path, f]));
  const drawings = rows.map(r => {
    const file = files.get(drawingFile(r.id)) || null;
    return { id: r.id, data: normalizeDrawing(r.data), dirty: r.dirty || !!file?.dirty, file, updatedAt: r.updatedAt };
  }).sort((a, b) => String(a.data.created || a.updatedAt).localeCompare(String(b.data.created || b.updatedAt)));
  const byId = new Map(drawings.map(d => [d.id, d]));
  return {
    drawings,
    get: id => byId.get(id) || null,
    /** "all", "none" (no section, or a deleted one) or a section with the sections inside it. */
    inSection(key, ideasModel) {
      if (key === 'all' || !key) return drawings;
      const known = id => !!(id && ideasModel.section(id));
      if (key === 'none') return drawings.filter(d => !known(d.data.section));
      if (!ideasModel.section(key)) return [];
      const ids = ideasModel.sectionDescendants(key);
      return drawings.filter(d => ids.has(d.data.section));
    },
    ofIdea: ideaId => drawings.filter(d => d.data.idea === ideaId),
  };
}

/** What's saved: no empty keys. */
export function storableDrawing(d) {
  const out = { ...normalizeDrawing(d) };
  if (!out.section) out.section = null;
  if (!out.idea) out.idea = null;
  return out;
}

export async function createDrawing({ name, section = null, idea = null, width, height, kind = 'pixel', id = newDrawingId(), file = null }) {
  const data = storableDrawing({ name, section, idea, width, height, kind, created: new Date().toISOString() });
  if (file) await store.putFile(drawingFile(id), file, { source: 'draw' });
  await store.put('drawings', id, data);
  return { id, data };
}

/** Delete a drawing and its picture. */
export async function removeDrawing(id) {
  await store.removeFile(drawingFile(id));
  await store.remove('drawings', id);
}

/* ---------- Colours ---------- */

export const hexOk = v => /^#[0-9a-f]{6}$/i.test(String(v || ''));
export const normHex = v => {
  let s = String(v || '').trim().toLowerCase();
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return hexOk(s) ? s : null;
};
export const hexToRgb = hex => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
const two = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
export const rgbToHex = ({ r, g, b }) => `#${two(r)}${two(g)}${two(b)}`;

export function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: max ? d / max : 0, v: max };
}
export function hsvToRgb({ h: hue, s, v }) {
  const c = v * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** Gray with the same brightness (how bright the eye sees it). */
export const grayOf = (r, g, b) => Math.round(0.299 * r + 0.587 * g + 0.114 * b);

/* ---------- Palettes ---------- */

export const BUILTIN_PALETTES = [
  {
    id: 'builtin-starter', name: 'Starter', builtin: true,
    colors: ['#000000', '#3d3d3d', '#7a7a7a', '#b5b5b5', '#e6e6e6', '#ffffff',
      '#5c1f1f', '#b3312c', '#e8603c', '#f0a33a', '#f5d547', '#a8d84e',
      '#4caf50', '#1f6e43', '#2bb3c0', '#2f78c4', '#2c3e9e', '#6b3fa0',
      '#b04fa0', '#f08ba8', '#7a4e26', '#a06c3a', '#c99158', '#e6b97e'],
  },
  {
    id: 'builtin-dyes', name: 'Minecraft dyes', builtin: true,
    colors: ['#f9fffe', '#9d9d97', '#474f52', '#1d1d21', '#835432', '#b02e26', '#f9801d', '#fed83d',
      '#80c71f', '#5e7c16', '#169c9c', '#3ab3da', '#3c44aa', '#8932b8', '#c74ebd', '#f38baa'],
  },
];

export function normalizePalette(id, d) {
  const seen = new Set();
  const colors = (Array.isArray(d?.colors) ? d.colors : []).map(normHex).filter(c => c && !seen.has(c) && seen.add(c));
  return { id, name: String(d?.name || '').trim() || 'Palette', colors, order: Number.isFinite(d?.order) ? d.order : 0, builtin: false };
}

/** Built-in palettes first, then yours (in the order you made them). */
export async function getPalettes() {
  const mine = (await store.list('palettes')).map(r => ({ ...normalizePalette(r.id, r.data), dirty: r.dirty }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return [...BUILTIN_PALETTES, ...mine];
}

export async function savePalette(p) {
  await store.put('palettes', p.id, { name: p.name, colors: p.colors, order: p.order });
}

export async function createPalette({ name, colors = [] }) {
  const mine = (await store.list('palettes')).map(r => r.data?.order).filter(Number.isFinite);
  const p = { id: newPaletteId(), name, colors: [...new Set(colors.map(normHex).filter(Boolean))].slice(0, 256), order: (mine.length ? Math.max(...mine) : 0) + 10 };
  await savePalette(p);
  return p;
}
