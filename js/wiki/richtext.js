// An editable piece of wiki text (overview, a field, a block of the page text...).
//
// It's a contenteditable box: links show as highlighted chips instead of [[...]], bold and
// italic show as bold and italic. What's saved is the same plain text format the wiki reads
// (see wiki/text.js): [[page-id]], **bold**, *italic*, `code`, and line breaks.
//
//   [[       opens the page picker (type to filter, Enter or tap to insert a link)
//   Ctrl+B   bold        Ctrl+I   italic
//   Pasting always pastes plain text (pictures are handed to onPasteImage if given).

import { h, slugify } from '../core/util.js';
import { LINK_RE, MARK_RE, nameFor, targetId } from './text.js';
import { openPopup, currentPopup, closePopup, caretRect } from './popup.js';
import { pageName } from './model.js';

/* ---------- Text <-> editable DOM ---------- */

export function linkChip(wiki, target, label = '') {
  const id = targetId(target);
  return h('span', {
    class: wiki.get(id) ? 'wlink' : 'wlink wlink-missing',
    contenteditable: 'false',
    dataset: { target: id, label: label || '' },
  }, nameFor(wiki, target, label));
}

function appendPlain(parent, s) {
  const parts = String(s).split('\n');
  parts.forEach((part, i) => {
    if (i) parent.append(document.createElement('br'));
    if (part) parent.append(document.createTextNode(part));
  });
}

function appendMarks(parent, s) {
  let last = 0;
  for (const m of s.matchAll(MARK_RE)) {
    if (m.index > last) appendPlain(parent, s.slice(last, m.index));
    const tag = m[1] !== undefined ? 'strong' : m[2] !== undefined ? 'em' : 'code';
    const el = document.createElement(tag);
    appendPlain(el, m[1] ?? m[2] ?? m[3]);
    parent.append(el);
    last = m.index + m[0].length;
  }
  if (last < s.length) appendPlain(parent, s.slice(last));
}

/** Show saved text in an editable element. */
export function fillEditable(el, text, wiki) {
  el.replaceChildren();
  const s = String(text ?? '');
  let last = 0;
  for (const m of s.matchAll(LINK_RE)) {
    if (m.index > last) appendMarks(el, s.slice(last, m.index));
    el.append(linkChip(wiki, m[1], m[2] || ''));
    last = m.index + m[0].length;
  }
  if (last < s.length) appendMarks(el, s.slice(last));
  // A line break at the very end needs a second one to show up as an empty line.
  if (s.endsWith('\n')) el.append(document.createElement('br'));
}

function wrapMark(inner, mark) {
  if (!inner.trim()) return inner;
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

function serializeNodes(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.nodeValue.replace(/ /g, ' ').replace(/​/g, '');
    } else if (n.nodeType !== Node.ELEMENT_NODE) {
      continue;
    } else if (n.tagName === 'BR') {
      out += '\n';
    } else if (n.dataset?.target) {
      out += `[[${n.dataset.target}${n.dataset.label ? `|${n.dataset.label}` : ''}]]`;
    } else if (n.tagName === 'B' || n.tagName === 'STRONG') {
      out += wrapMark(serializeNodes(n), '**');
    } else if (n.tagName === 'I' || n.tagName === 'EM') {
      out += wrapMark(serializeNodes(n), '*');
    } else if (n.tagName === 'CODE') {
      out += wrapMark(serializeNodes(n), '`');
    } else if (n.tagName === 'DIV' || n.tagName === 'P') {
      if (out && !out.endsWith('\n')) out += '\n';
      out += serializeNodes(n);
    } else {
      out += serializeNodes(n);
    }
  }
  return out;
}

/** The saved-text version of an editable element. */
export function serializeEditable(el) {
  let out = serializeNodes(el);
  if (out.endsWith('\n')) out = out.slice(0, -1);   // the extra line break that shows an empty last line
  return out.replace(/[ \t]+$/gm, '');
}

/* ---------- Cursor helpers ---------- */

/** The selection's range if the cursor is inside el. */
export function rangeIn(el) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return el.contains(r.startContainer) ? r : null;
}

/** Text from the start of el up to the cursor (links count as their shown name). */
export function textBeforeCaret(el) {
  const r = rangeIn(el);
  if (!r) return '';
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString();
}

export function caretAtStart(el) {
  const r = rangeIn(el);
  if (!r || !r.collapsed) return false;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  const frag = pre.cloneContents();
  return frag.textContent === '' && !frag.querySelector?.('[data-target]');
}

export function caretAtEnd(el) {
  const r = rangeIn(el);
  if (!r || !r.collapsed) return false;
  const post = document.createRange();
  post.selectNodeContents(el);
  post.setStart(r.endContainer, r.endOffset);
  const frag = post.cloneContents();
  return frag.textContent === '' && !frag.querySelector?.('[data-target]');
}

export function placeCaret(el, where = 'end') {
  el.focus({ preventScroll: false });
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(where === 'start');
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Put the cursor after the first `units` characters (a link counts as 1, a line break as 1). */
export function placeCaretAt(el, units) {
  const r = document.createRange();
  let left = units;
  let placed = false;
  for (const n of el.childNodes) {
    const isText = n.nodeType === Node.TEXT_NODE;
    const len = isText ? n.nodeValue.length : (n.dataset?.target || n.tagName === 'BR') ? 1 : n.textContent.length;
    if (left <= len) {
      if (isText) r.setStart(n, left);
      else if (left === 0) r.setStartBefore(n);
      else r.setStartAfter(n);   // inside bold/italic text: just after it is close enough
      placed = true;
      break;
    }
    left -= len;
  }
  if (!placed) { r.selectNodeContents(el); r.collapse(false); }
  r.collapse(true);
  el.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/** How many caret units el holds (see placeCaretAt). */
export function unitLength(el) {
  let n = 0;
  for (const c of el.childNodes) {
    n += c.nodeType === Node.TEXT_NODE ? c.nodeValue.length : (c.dataset?.target || c.tagName === 'BR') ? 1 : c.textContent.length;
  }
  return n;
}

/** Delete the `count` characters just before the cursor (within the same piece of text). */
export function deleteBeforeCaret(el, count) {
  const r = rangeIn(el);
  if (!r || count <= 0) return;
  const node = r.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || r.startOffset < count) return;
  const del = document.createRange();
  del.setStart(node, r.startOffset - count);
  del.setEnd(node, r.startOffset);
  del.deleteContents();
}

/* ---------- Page picker ---------- */

const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Popup items for pages matching query. pick(id) is called with the chosen page id.
 * A query that matches no page name offers a link to a new page (created later from the link).
 */
export function pageItems(wiki, query, pick, { exclude = [] } = {}) {
  const q = fold(query).trim();
  const out = [];
  for (const p of wiki.pages.values()) {
    if (exclude.includes(p.id)) continue;
    const name = fold(pageName(p));
    if (q && !name.includes(q) && !p.id.includes(slugify(query))) continue;
    out.push({ p, name, score: !q ? 0 : name === q ? 3 : name.startsWith(q) ? 2 : name.split(/\s+/).some(w => w.startsWith(q)) ? 1 : 0 });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const items = out.slice(0, 8).map(({ p }) => {
    const place = wiki.placeOf(p);
    return { label: pageName(p), hint: place ? place.sub.name : '', icon: place?.sub.icon || 'book', onPick: () => pick(p.id) };
  });
  const id = slugify(query);
  if (q && id && !wiki.get(id) && !out.some(x => x.score === 3) && !exclude.includes(id)) {
    items.push({ label: `“${query.trim()}”`, hint: 'New page (create it later)', icon: 'book', onPick: () => pick(id) });
  }
  return items;
}

/* ---------- The component ---------- */

/**
 * options:
 *   value, wiki, onChange(text)
 *   multiline   Enter adds a line break (otherwise Enter does nothing, or what onKeyDown says)
 *   onKeyDown(e) return true when you handled the key
 *   onPasteImage(file) a picture was pasted
 */
export function richText({ value = '', wiki, multiline = true, placeholder = '', label, className = '', onChange, onKeyDown, onPasteImage }) {
  const el = h('div', {
    class: `rt ${className}`.trim(), contenteditable: 'true', role: 'textbox', spellcheck: 'true',
    'aria-multiline': String(multiline), 'aria-label': label || placeholder || 'Text',
    dataset: { placeholder },
  });
  let last = String(value ?? '');
  fillEditable(el, last, wiki);

  const refreshEmpty = () => el.classList.toggle('is-empty', el.textContent === '' && !el.querySelector('[data-target]'));
  refreshEmpty();

  const changed = () => {
    refreshEmpty();
    const v = serializeEditable(el);
    if (v !== last) { last = v; onChange?.(v); }
  };

  // [[ opens the page picker
  const linkTrigger = () => {
    const m = textBeforeCaret(el).match(/\[\[([^[\]\n|]{0,40})$/);
    const pop = currentPopup();
    if (!m) {
      if (pop?.owner === el && pop.kind === 'link') pop.close();
      return;
    }
    const items = pageItems(wiki, m[1], id => insertLink(m[0].length, id));
    if (pop?.owner === el && pop.kind === 'link') {
      pop.setItems(items);
      pop.place(caretRect(el));
    } else {
      const p = openPopup({ rect: caretRect(el), items, title: 'Link to a page', emptyText: 'Type a page name' });
      p.owner = el;
      p.kind = 'link';
    }
  };

  function insertLink(typedLength, id) {
    el.focus();
    deleteBeforeCaret(el, typedLength);
    const r = rangeIn(el);
    if (!r) return;
    const chip = linkChip(wiki, id);
    const space = document.createTextNode(' ');
    r.insertNode(space);
    r.insertNode(chip);
    const after = document.createRange();
    after.setStart(space, 1);
    after.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(after);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.insertLinkAtCaret = id => insertLink(0, id);

  el.addEventListener('input', () => { changed(); linkTrigger(); });

  el.addEventListener('keydown', e => {
    const pop = currentPopup();
    if (pop && pop.owner === el) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pop.move(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pop.pick(); return; }
      if (e.key === 'Escape') { e.preventDefault(); pop.close(); return; }
    }
    if (onKeyDown?.(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (multiline || e.shiftKey) document.execCommand('insertLineBreak');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'b' || e.key === 'i')) {
      e.preventDefault();
      document.execCommand(e.key === 'b' ? 'bold' : 'italic');
    }
  });

  el.addEventListener('paste', e => {
    const file = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
    e.preventDefault();
    if (file && onPasteImage) { onPasteImage(file); return; }
    const text = e.clipboardData?.getData('text/plain') || '';
    const lines = (multiline ? text : text.replace(/\s*\n\s*/g, ' ')).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (i) document.execCommand('insertLineBreak');
      if (line) document.execCommand('insertText', false, line);
    });
  });

  // Dropped text would bring formatting along; keep it simple.
  el.addEventListener('drop', e => e.preventDefault());

  el.addEventListener('blur', () => {
    setTimeout(() => {
      const pop = currentPopup();
      if (pop?.owner === el && document.activeElement !== el) pop.close();
    }, 200);
  });

  el.getValue = () => serializeEditable(el);
  el.setValue = v => { last = String(v ?? ''); fillEditable(el, last, wiki); refreshEmpty(); };
  el.refresh = changed;
  return el;
}

export { closePopup };
