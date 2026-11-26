// Applies color themes. A theme is a style (Black, Dark, Light, White) plus a color.
// The choice is per device (saved in this browser only).

import { STYLES, COLORS, buildTheme, DEFAULT_STYLE, DEFAULT_COLOR } from '../config/themes.js';

const KEY = 'brr.theme';
const VARS_KEY = 'brr.themeVars'; // read by the tiny script in index.html to avoid a flash on load
const listeners = new Set();

const DEFAULT_STATE = {
  style: DEFAULT_STYLE, color: DEFAULT_COLOR,
  lastDarkStyle: 'dark', lastLightStyle: 'white', custom: null,
};

// Themes from the first versions of the app, so a saved choice carries over.
const OLD_IDS = {
  'midnight-navy': ['dark', 'cyan'], 'forest-dark': ['dark', 'green'], 'deep-teal': ['dark', 'teal'],
  'slate-dark': ['dark', 'blue'], 'rose-night': ['dark', 'pink'], amethyst: ['dark', 'purple'],
  ember: ['dark', 'orange'], crimson: ['dark', 'red'], deepslate: ['black', 'gold'], moss: ['dark', 'lime'],
  light: ['white', 'cyan'], blossom: ['white', 'pink'], sand: ['white', 'gold'], mint: ['white', 'green'],
  sky: ['white', 'blue'], lavender: ['white', 'purple'], paper: ['white', 'blue'], peach: ['white', 'orange'],
  sage: ['white', 'lime'], cherry: ['white', 'red'],
};

const MODE_COLORS = {
  dark:  { text: '#E6EEF2', danger: '#F07178', warn: '#E8B44C', ok: '#5FD08A' },
  light: { text: '#152229', danger: '#C0392B', warn: '#9A6200', ok: '#1E7F45' },
};

export function getThemeState() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && typeof s === 'object') {
      if (!s.style && OLD_IDS[s.id]) [s.style, s.color] = OLD_IDS[s.id];
      return { ...DEFAULT_STATE, ...s };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_STATE };
}

function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const isDarkStyle = id => !!STYLES.find(s => s.id === id)?.dark;

/** The colors currently in use (custom colors win when switched on). */
export function activeColors(state = getThemeState()) {
  if (state.custom?.on) return { ...state.custom, name: 'Custom' };
  return buildTheme(state.style, state.color);
}

export function modeOf(hex) {
  return luminance(hex) < 0.4 ? 'dark' : 'light';
}

export function applyTheme(state = getThemeState()) {
  const c = activeColors(state);
  const mode = modeOf(c.bg);
  const m = MODE_COLORS[mode];
  const vars = {
    '--bg': c.bg,
    '--panel': c.panel,
    '--accent': c.accent,
    '--on-accent': bestText(c.accent),
    '--text': m.text,
    '--danger': m.danger,
    '--warn': m.warn,
    '--ok': m.ok,
  };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c.bg);
  try { localStorage.setItem(VARS_KEY, JSON.stringify({ vars, mode })); } catch { /* storage full */ }
  for (const fn of listeners) fn(state);
}

function update(changes) {
  const state = getThemeState();
  const next = { ...state, ...changes, custom: state.custom ? { ...state.custom, on: false } : null };
  if (isDarkStyle(next.style)) next.lastDarkStyle = next.style;
  else next.lastLightStyle = next.style;
  save(next);
  applyTheme(next);
}

export function setStyle(style) {
  if (STYLES.some(s => s.id === style)) update({ style });
}

export function setColor(color) {
  if (COLORS.some(c => c.id === color)) update({ color });
}

/** One tap: switch between the dark and light style you used last, keeping the color. */
export function toggleMode() {
  const state = getThemeState();
  if (state.custom?.on) { update({}); return; }
  update({ style: isDarkStyle(state.style) ? state.lastLightStyle : state.lastDarkStyle });
}

export function setCustomColors({ bg, panel, accent }) {
  const state = getThemeState();
  const next = { ...state, custom: { on: true, bg, panel, accent } };
  save(next);
  applyTheme(next);
}

export function turnOffCustomColors() {
  const state = getThemeState();
  if (!state.custom) return;
  const next = { ...state, custom: { ...state.custom, on: false } };
  save(next);
  applyTheme(next);
}

export function currentMode() {
  return modeOf(activeColors().bg);
}

/* ---------- Color math ---------- */

function channel(v) {
  v /= 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex) {
  const n = parseInt(String(hex).replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function bestText(accent) {
  return contrast(accent, '#061521') >= contrast(accent, '#FFFFFF') ? '#061521' : '#FFFFFF';
}
