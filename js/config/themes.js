// Color themes: pick a style (Black, Dark, Light, White) and a color.
// To add a color: add one line to COLORS with a hue (0-360) and an optional saturation.
// To fine-tune one exact combination, add it to EXACT.
// Text, borders and muted colors are worked out from bg, panel and accent automatically.

export const STYLES = [
  { id: 'black', name: 'Black', dark: true },   // neutral black background, colored accent
  { id: 'dark',  name: 'Dark',  dark: true },   // dark shade of the color, light shade as accent
  { id: 'light', name: 'Light', dark: false },  // light shade of the color, dark shade as accent
  { id: 'white', name: 'White', dark: false },  // white background, colored accent
];

export const COLORS = [
  { id: 'cyan',   name: 'Cyan',   hue: 186 },
  { id: 'teal',   name: 'Teal',   hue: 168 },
  { id: 'green',  name: 'Green',  hue: 145 },
  { id: 'lime',   name: 'Lime',   hue: 82 },
  { id: 'gold',   name: 'Gold',   hue: 44, sat: 0.62 },
  { id: 'orange', name: 'Orange', hue: 24 },
  { id: 'red',    name: 'Red',    hue: 356 },
  { id: 'pink',   name: 'Pink',   hue: 330 },
  { id: 'purple', name: 'Purple', hue: 265 },
  { id: 'blue',   name: 'Blue',   hue: 222 },
];

// Hand-picked combinations (the original theme colors).
const EXACT = {
  'dark-cyan':  { bg: '#0B1A2E', panel: '#13263F', accent: '#2BB3C0' }, // Midnight Navy
  'dark-green': { bg: '#0F1F17', panel: '#1A3327', accent: '#4CAF7A' }, // Forest Dark
  'dark-teal':  { bg: '#0A1C1E', panel: '#132C2F', accent: '#3FBFB0' }, // Deep Teal
  'dark-blue':  { bg: '#11151C', panel: '#1B2230', accent: '#7C9CFF' }, // Slate Dark
  'white-cyan': { bg: '#F4F7F6', panel: '#FFFFFF', accent: '#1F7A8C' },
  'black-gold': { bg: '#141518', panel: '#212328', accent: '#D4B66A' },
};

export const DEFAULT_STYLE = 'dark';
export const DEFAULT_COLOR = 'cyan';

/** The colors for one style + color combination: { id, name, bg, panel, accent }. */
export function buildTheme(styleId, colorId) {
  const style = STYLES.find(s => s.id === styleId) || STYLES.find(s => s.id === DEFAULT_STYLE);
  const color = COLORS.find(c => c.id === colorId) || COLORS.find(c => c.id === DEFAULT_COLOR);
  const id = `${style.id}-${color.id}`;
  const name = `${style.name} ${color.name.toLowerCase()}`;
  if (EXACT[id]) return { id, name, ...EXACT[id] };
  const h = color.hue, s = color.sat ?? 0.68;
  let t;
  switch (style.id) {
    case 'black': t = { bg: '#111214', panel: '#1C1D20', l: 0.63 }; break;
    case 'dark':  t = { bg: hsl(h, 0.42, 0.10), panel: hsl(h, 0.34, 0.16), l: 0.62 }; break;
    case 'light': t = { bg: hsl(h, 0.48, 0.87), panel: hsl(h, 0.55, 0.95), l: 0.30 }; break;
    default:      t = { bg: hsl(h, 0.22, 0.965), panel: '#FFFFFF', l: 0.34 }; // white
  }
  // Nudge the accent lighter (dark styles) or darker (light styles) until it's easy to read.
  let l = t.l;
  let accent = hsl(h, s, l);
  while (contrast(accent, t.panel) < 4.5 && l > 0.12 && l < 0.88) {
    l += style.dark ? 0.02 : -0.02;
    accent = hsl(h, s, l);
  }
  return { id, name, bg: t.bg, panel: t.panel, accent };
}

function channel(v) {
  v /= 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function hsl(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`.toUpperCase();
}
