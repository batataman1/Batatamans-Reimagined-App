// Turns wiki text into what you see on screen.
//
// Inside any text:
//   [[ostrich-egg]]            link to a page (shows the page's current name)
//   [[ostrich-egg|an egg]]     link with your own text
//   **bold**  *italic*  `code`
// A link to a page that doesn't exist yet is drawn dashed.
//
// The page text (page.body) is a list of blocks, one per paragraph, like Notion:
//   { type: "p" | "h1" | "h2" | "h3" | "quote", text }
//   { type: "bullet" | "number", text }      next to each other they form one list
//   { type: "todo", text, checked }
//   { type: "divider" }
//   { type: "image", src: "images/x.png", caption }   images and GIFs

import { h, slugify } from '../core/util.js';

export const LINK_RE = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

/** "Ostrich Egg", "ostrich-egg" or " ostrich-egg " -> "ostrich-egg" */
export function targetId(target) {
  const t = String(target || '').trim();
  return /^[a-z0-9][a-z0-9_-]*$/.test(t) ? t : slugify(t);
}

export function linkTargets(text) {
  const out = [];
  for (const m of String(text || '').matchAll(LINK_RE)) {
    const id = targetId(m[1]);
    if (id) out.push(id);
  }
  return out;
}

const nameFor = (wiki, target, label) => {
  if (label) return label.trim();
  const page = wiki.get(targetId(target));
  if (page) return String(page.data.name || '').trim() || humanize(page.id);
  const t = target.trim();
  return /^[a-z0-9][a-z0-9_-]*$/.test(t) ? humanize(t) : t;
};

const humanize = id => id.split(/[-_]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Text without the link brackets or ** marks, for search and short previews. */
export function plainText(text, wiki) {
  return String(text || '')
    .replace(LINK_RE, (_, t, label) => nameFor(wiki, t, label))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
}

/** A link element to a wiki page (dashed if the page doesn't exist yet). */
export function pageLink(wiki, target, label) {
  const id = targetId(target);
  const exists = !!wiki.get(id);
  return h('a', {
    class: exists ? 'wlink' : 'wlink wlink-missing',
    href: `#/wiki/p/${id}`,
    title: exists ? null : "This page doesn't exist yet",
  }, nameFor(wiki, target, label));
}

/** Text with links and simple formatting, as DOM nodes. Line breaks are kept by CSS. */
export function renderText(text, wiki) {
  const frag = document.createDocumentFragment();
  const s = String(text ?? '');
  let last = 0;
  for (const m of s.matchAll(LINK_RE)) {
    if (m.index > last) frag.append(marks(s.slice(last, m.index)));
    frag.append(pageLink(wiki, m[1], m[2]));
    last = m.index + m[0].length;
  }
  if (last < s.length) frag.append(marks(s.slice(last)));
  return frag;
}

const MARK_RE = /\*\*([^*]+)\*\*|(?<![*\w])\*([^*\s][^*]*?)\*(?![*\w])|`([^`]+)`/g;

function marks(s) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of s.matchAll(MARK_RE)) {
    if (m.index > last) frag.append(s.slice(last, m.index));
    if (m[1] !== undefined) frag.append(h('strong', { text: m[1] }));
    else if (m[2] !== undefined) frag.append(h('em', { text: m[2] }));
    else frag.append(h('code', { text: m[3] }));
    last = m.index + m[0].length;
  }
  if (last < s.length) frag.append(s.slice(last));
  return frag;
}

/**
 * The page text. images(src) returns an <img> (or placeholder) for a file path.
 * Checkboxes are shown but can't be ticked here; editing arrives with the editor.
 */
export function renderBody(blocks, wiki, { image } = {}) {
  const out = document.createDocumentFragment();
  let list = null;
  let listType = null;
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== 'object') continue;
    const type = b.type || 'p';
    if (type === 'bullet' || type === 'number') {
      if (listType !== type) {
        list = h(type === 'bullet' ? 'ul' : 'ol', { class: 'b-list' });
        listType = type;
        out.append(list);
      }
      list.append(h('li', renderText(b.text, wiki)));
      continue;
    }
    list = null; listType = null;
    switch (type) {
      case 'h1': out.append(h('h2', { class: 'b-h1' }, renderText(b.text, wiki))); break;
      case 'h2': out.append(h('h3', { class: 'b-h2' }, renderText(b.text, wiki))); break;
      case 'h3': out.append(h('h4', { class: 'b-h3' }, renderText(b.text, wiki))); break;
      case 'quote': out.append(h('blockquote', { class: 'b-quote' }, renderText(b.text, wiki))); break;
      case 'divider': out.append(h('hr', { class: 'b-divider' })); break;
      case 'todo':
        out.append(h('div', { class: `b-todo${b.checked ? ' done' : ''}` },
          h('input', { type: 'checkbox', checked: !!b.checked, disabled: true, 'aria-label': b.checked ? 'Done' : 'Not done' }),
          h('span', renderText(b.text, wiki))));
        break;
      case 'image':
        out.append(h('figure', { class: 'b-image' },
          image ? image(b.src, b.caption || '') : null,
          b.caption ? h('figcaption', renderText(b.caption, wiki)) : null));
        break;
      default:
        out.append(h('p', { class: 'b-p' }, renderText(b.text, wiki)));
    }
  }
  return out;
}
