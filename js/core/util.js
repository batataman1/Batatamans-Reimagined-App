// Small shared helpers: DOM building, ids, encoding, object diffing.

/** Build a DOM element. attrs: class, text, on<Event> handlers, dataset, any attribute. */
export function h(tag, attrs = {}, ...children) {
  // Allow h('li', child, child) without an attributes object.
  if (attrs instanceof Node || typeof attrs === 'string' || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'value') el.value = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Empty an element, then add the given children (null/false are skipped). */
export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** Random id like "t-k3j9x2a1". */
export function uid(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const s = Array.from(bytes, b => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-2);
  return prefix ? `${prefix}-${s}` : s;
}

/** "Baobab Fruit Seeds" -> "baobab-fruit-seeds" */
export function slugify(name) {
  return String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(id);
}

/* ---------- Base64 / UTF-8 ---------- */

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const utf8ToBase64 = str => bytesToBase64(new TextEncoder().encode(str));
export const base64ToUtf8 = b64 => new TextDecoder().decode(base64ToBytes(b64));

export async function blobToBase64(blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function base64ToBlob(b64, mime) {
  return new Blob([base64ToBytes(b64)], { type: mime || 'application/octet-stream' });
}

const MIME = {
  png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', svg: 'image/svg+xml', json: 'application/json', mcmeta: 'application/json',
};
export function mimeFromPath(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/* ---------- Objects ---------- */

export const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Merge patch into base: objects merge key by key, everything else is replaced. Returns a new object. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return structuredClone(patch);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

/** Flatten nested objects to "a.b.c" keys. Arrays and primitives are leaves. */
export function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && Object.keys(v).length) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

/** List of {key, before, after} for every leaf that differs. */
export function diffObjects(before, after) {
  const a = flatten(before), b = flatten(after);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const diffs = [];
  for (const key of keys) {
    const x = a.get(key), y = b.get(key);
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push({ key, before: x, after: y });
  }
  return diffs;
}

/** "fields.stackSize" -> "Stack size" */
export function humanizeKey(key) {
  const last = String(key).split('.').pop();
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function shortValue(v, max = 70) {
  if (v === undefined) return '(empty)';
  if (v === null) return '(cleared)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* ---------- Time ---------- */

export function timeAgo(iso) {
  if (!iso) return 'never';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

export function plural(n, word, many = word + 's') {
  return `${n} ${n === 1 ? word : many}`;
}
