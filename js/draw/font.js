// Text for the drawing studio (part 2e): a built-in pixel font and the normal fonts.
//
// The pixel font: letters 5 dots wide (some narrower) and 7 high, with room below for the
// tails of g, j, p, q and y. Every dot is one square (or 2, 3, 4 squares with a bigger size),
// so text stays crisp pixel art. It has English letters, numbers and the usual signs; other
// letters (like Hebrew) need one of the normal fonts.
//
// A glyph is its rows from the top, separated by "/", '#' = a dot.

const G = {
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#',
  B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.###./#...#/#..../#..../#..../#...#/.###.',
  D: '####./#...#/#...#/#...#/#...#/#...#/####.',
  E: '#####/#..../#..../####./#..../#..../#####',
  F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.####',
  H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '###/.#./.#./.#./.#./.#./###',
  J: '..###/...#./...#./...#./...#./#..#./.##..',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  N: '#...#/#...#/##..#/#.#.#/#..##/#...#/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.',
  T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/#.#.#/.#.#.',
  X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..',
  Z: '#####/....#/...#./..#../.#.../#..../#####',
  a: '...../...../.###./....#/.####/#...#/.####',
  b: '#..../#..../####./#...#/#...#/#...#/####.',
  c: '...../...../.###./#..../#..../#...#/.###.',
  d: '....#/....#/.####/#...#/#...#/#...#/.####',
  e: '...../...../.###./#...#/#####/#..../.###.',
  f: '.##/#../###/#../#../#../#..',
  g: '...../...../.####/#...#/#...#/#...#/.####/....#/.###.',
  h: '#..../#..../#.##./##..#/#...#/#...#/#...#',
  i: '.#./.../##./.#./.#./.#./###',
  j: '...#/..../..##/...#/...#/...#/...#/#..#/.##.',
  k: '#.../#.../#..#/#.#./##../#.#./#..#',
  l: '##./.#./.#./.#./.#./.#./###',
  m: '...../...../##.#./#.#.#/#.#.#/#.#.#/#.#.#',
  n: '...../...../#.##./##..#/#...#/#...#/#...#',
  o: '...../...../.###./#...#/#...#/#...#/.###.',
  p: '...../...../####./#...#/#...#/#...#/####./#..../#....',
  q: '...../...../.####/#...#/#...#/#...#/.####/....#/....#',
  r: '...../...../#.##./##..#/#..../#..../#....',
  s: '...../...../.####/#..../.###./....#/####.',
  t: '.#../.#../###./.#../.#../.#.#/..#.',
  u: '...../...../#...#/#...#/#...#/#..##/.##.#',
  v: '...../...../#...#/#...#/#...#/.#.#./..#..',
  w: '...../...../#...#/#...#/#.#.#/#.#.#/.#.#.',
  x: '...../...../#...#/.#.#./..#../.#.#./#...#',
  y: '...../...../#...#/#...#/#...#/#...#/.####/....#/.###.',
  z: '...../...../#####/...#./..#../.#.../#####',
  0: '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  1: '.#./##./.#./.#./.#./.#./###',
  2: '.###./#...#/....#/...#./..#../.#.../#####',
  3: '####./....#/....#/.###./....#/....#/####.',
  4: '...#./..##./.#.#./#..#./#####/...#./...#.',
  5: '#####/#..../####./....#/....#/#...#/.###.',
  6: '..##./.#.../#..../####./#...#/#...#/.###.',
  7: '#####/....#/...#./..#../.#.../.#.../.#...',
  8: '.###./#...#/#...#/.###./#...#/#...#/.###.',
  9: '.###./#...#/#...#/.####/....#/...#./.##..',
  '!': '#/#/#/#/#/./#',
  '"': '#.#/#.#',
  '#': '.#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.',
  $: '..#../.####/#.#../.###./..#.#/####./..#..',
  '%': '##..#/##..#/...#./..#../.#.../#..##/#..##',
  '&': '.##../#..#./#.#../.#.../#.#.#/#..#./.##.#',
  "'": '#/#',
  '(': '.#/#./#./#./#./#./.#',
  ')': '#./.#/.#/.#/.#/.#/#.',
  '*': '...../..#../#.#.#/.###./#.#.#/..#..',
  '+': '...../..#../..#../#####/..#../..#..',
  ',': '../../../../../.#/.#/#.',
  '-': '..../..../..../####',
  '.': './././././.#',
  '/': '....#/...#./...#./..#../.#.../.#.../#....',
  ':': './././#/././#',
  ';': '../../../.#/../../.#/.#/#.',
  '<': '...#/..#./.#../#.../.#../..#./...#',
  '=': '..../..../####/..../####',
  '>': '#.../.#../..#./...#/..#./.#../#...',
  '?': '.###./#...#/....#/...#./..#../...../..#..',
  '@': '.###./#...#/#.###/#.#.#/#.###/#..../.###.',
  '[': '##/#./#./#./#./#./##',
  '\\': '#..../.#.../.#.../..#../...#./...#./....#',
  ']': '##/.#/.#/.#/.#/.#/##',
  '^': '..#../.#.#./#...#',
  _: '...../...../...../...../...../...../...../#####',
  '`': '#./.#',
  '{': '..#/.#./.#./#../.#./.#./..#',
  '|': '#/#/#/#/#/#/#',
  '}': '#../.#./.#./..#/.#./.#./#..',
  '~': '...../...../.#.../#.#.#/...#.',
};

const ROWS = 9;          // 7 for the letters + 2 for tails
const LINE = ROWS + 2;   // rows from one line to the next
const glyphs = new Map(Object.entries(G).map(([ch, s]) => {
  const rows = s.split('/');
  return [ch, { rows, w: Math.max(...rows.map(r => r.length)) }];
}));
const SPACE = 3;

/** True when the pixel font has every letter of the text (otherwise use a normal font). */
export const pixelFontCovers = text => [...String(text)].every(ch => ch === ' ' || ch === '\n' || glyphs.has(ch));

/**
 * The text in the pixel font as squares: { cells (1 = dot), w, h } with every dot `dot` squares.
 * Letters it doesn't have show as a box.
 */
export function pixelText(text, { dot = 1, align = 'left' } = {}) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const widthOf = line => {
    let w = 0;
    for (const ch of line) w += (ch === ' ' ? SPACE : (glyphs.get(ch)?.w ?? 4)) + 1;
    return Math.max(0, w - 1);
  };
  const widths = lines.map(widthOf);
  const w = Math.max(1, ...widths), h = Math.max(ROWS, lines.length * LINE - (LINE - ROWS));
  const cells = new Uint8Array(w * h);
  lines.forEach((line, li) => {
    let x = align === 'center' ? Math.floor((w - widths[li]) / 2) : align === 'right' ? w - widths[li] : 0;
    const y0 = li * LINE;
    for (const ch of line) {
      if (ch === ' ') { x += SPACE + 1; continue; }
      const g = glyphs.get(ch);
      if (!g) {
        // A box for a letter the font doesn't have.
        for (let y = 1; y < 7; y++) for (let xx = 0; xx < 3; xx++) if (y === 1 || y === 6 || xx === 0 || xx === 2) cells[(y0 + y) * w + x + xx] = 1;
        x += 4;
        continue;
      }
      g.rows.forEach((row, y) => { for (let xx = 0; xx < row.length; xx++) if (row[xx] === '#') cells[(y0 + y) * w + x + xx] = 1; });
      x += g.w + 1;
    }
  });
  if (dot <= 1) return { cells, w, h };
  const W = w * dot, out = new Uint8Array(W * h * dot);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!cells[y * w + x]) continue;
    for (let yy = 0; yy < dot; yy++) out.fill(1, (y * dot + yy) * W + x * dot, (y * dot + yy) * W + x * dot + dot);
  }
  return { cells: out, w: W, h: h * dot };
}

export const FONTS = {
  pixel: { name: 'Pixel font', css: null },
  sans: { name: 'Sans', css: 'Arial, Helvetica, "Noto Sans", sans-serif' },
  serif: { name: 'Serif', css: 'Georgia, "Times New Roman", "Noto Serif", serif' },
  mono: { name: 'Mono', css: 'Consolas, "Courier New", "Noto Sans Mono", monospace' },
  hand: { name: 'Handwriting', css: '"Segoe Print", "Comic Sans MS", "Bradley Hand", cursive' },
};

/**
 * Text as a picture: a canvas with the text in colour [r, g, b] (see-through around it).
 *   pixel font: `size` = squares per dot; one canvas pixel per square (unit = 1)
 *   normal fonts: `size` = letter height in squares; drawn with `unit` canvas pixels per square.
 *     With `sharp` (pixel pen) every pixel is either fully on or off: crisp pixel text.
 * Returns { canvas, unit } (canvas pixels per square), or null for empty text.
 */
export function textCanvas(text, { font = 'pixel', size = 1, color = [0, 0, 0], bold = false, align = 'left', unit = 1, sharp = false }) {
  text = String(text || '').replace(/\r/g, '');
  if (!text.trim()) return null;
  const [r, g, b] = color;
  if (font === 'pixel') {
    const t = pixelText(text, { dot: Math.max(1, Math.round(size)), align });
    const c = Object.assign(document.createElement('canvas'), { width: t.w, height: t.h });
    const cg = c.getContext('2d');
    const img = cg.createImageData(t.w, t.h);
    for (let i = 0; i < t.w * t.h; i++) if (t.cells[i]) { img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255; }
    cg.putImageData(img, 0, 0);
    return { canvas: c, unit: 1 };
  }
  const px = Math.max(4, size * unit);
  const css = `${bold ? '700' : '400'} ${px}px ${FONTS[font]?.css || 'sans-serif'}`;
  const lines = text.split('\n');
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = css;
  const widths = lines.map(l => probe.measureText(l).width);
  const lineH = Math.ceil(px * 1.25);
  const pad = Math.ceil(px * 0.15);
  const w = Math.max(1, Math.ceil(Math.max(...widths)) + pad * 2), h = lineH * lines.length + pad;
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const cg = c.getContext('2d', { willReadFrequently: true });
  cg.font = css;
  cg.textBaseline = 'alphabetic';
  cg.fillStyle = `rgb(${r},${g},${b})`;
  lines.forEach((l, i) => {
    const x = align === 'center' ? (w - widths[i]) / 2 : align === 'right' ? w - pad - widths[i] : pad;
    cg.fillText(l, x, i * lineH + px);
  });
  if (sharp) {
    const img = cg.getImageData(0, 0, w, h);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] >= 110 ? 255 : 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]) { img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; }
    cg.putImageData(img, 0, 0);
  }
  // Trim the empty space around it.
  const d = cg.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const t = Object.assign(document.createElement('canvas'), { width: x1 - x0 + 1, height: y1 - y0 + 1 });
  t.getContext('2d').drawImage(c, -x0, -y0);
  return { canvas: t, unit };
}
