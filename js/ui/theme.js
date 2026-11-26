// Applies color themes. Theme choice is per device (saved in this browser only).

import { THEMES, DEFAULT_THEME, DEFAULT_LIGHT_THEME } from '../config/themes.js';

const KEY = 'brr.theme';
const VARS_KEY = 'brr.themeVars'; // read by the tiny script in index.html to avoid a flash on load
const listeners = new Set();

const MODE_COLORS = {
  dark:  { text: '#E6EEF2', danger: '#F07178', warn: '#E8B44C', ok: '#5FD08A' },
  light: { text: '#152229', danger: '#C0392B', warn: '#9A6200', ok: '#1E7F45' },
};

export function getThemeState() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && typeof s === 'object') return { id: DEFAULT_THEME, lastDark: DEFAULT_THEME, custom: null, ...s };
  } catch { /* fall through */ }
  return { id: DEFAULT_THEME, lastDark: DEFAULT_THEME, custom: null };
}

function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function themeById(id) {
  return THEMES.find(t => t.id === id) || THEMES.find(t => t.id === DEFAULT_THEME);
}

/** The colors currently in use (custom colors win when switched on). */
export function activeColors(state = getThemeState()) {
  if (state.custom?.on) return { ...state.custom, name: 'Custom' };
  return themeById(state.id);
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

export function setTheme(id) {
  const state = getThemeState();
  const t = themeById(id);
  const next = { ...state, id: t.id, custom: state.custom ? { ...state.custom, on: false } : null };
  if (modeOf(t.bg) === 'dark') next.lastDark = t.id;
  save(next);
  applyTheme(next);
}

/** One tap: switch between your dark theme and the light theme. */
export function toggleMode() {
  const state = getThemeState();
  const current = modeOf(activeColors(state).bg);
  setTheme(current === 'dark' ? DEFAULT_LIGHT_THEME : (state.lastDark || DEFAULT_THEME));
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
