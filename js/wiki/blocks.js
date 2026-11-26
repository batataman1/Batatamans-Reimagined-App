// The page text editor, Notion style: the text is a list of blocks (paragraphs, headings,
// list items, checkboxes, quotes, dividers, pictures).
//
//   /          block menu (type to filter: "head", "check", "image"...)
//   []         turns the line into a checkbox
//   - or *     bulleted list        1.   numbered list
//   # ## ###   headings             >    quote          ---   divider
//   [[         link to a page
//   Enter      new block (on an empty list item: back to normal text)
//   Shift+Enter  line break inside the block
//   Backspace at the start: turns a list item/heading back into text, or joins with the block above
// Each block has a ⋮⋮ handle: turn into another type, move up or down, delete.

import { h, uid } from '../core/util.js';
import { openPopup, currentPopup, caretRect } from './popup.js';
import {
  richText, serializeEditable, textBeforeCaret, caretAtStart, placeCaret, placeCaretAt,
  unitLength, deleteBeforeCaret, rangeIn,
} from './richtext.js';
import { fileImage } from './parts.js';

const TEXT_TYPES = new Set(['p', 'h1', 'h2', 'h3', 'quote', 'bullet', 'number', 'todo']);
const KEEP_ON_ENTER = new Set(['bullet', 'number', 'todo']);

const TYPES = [
  { type: 'p', label: 'Text', hint: '', keys: 'text paragraph plain' },
  { type: 'h1', label: 'Heading 1', hint: '#', keys: 'heading title big h1' },
  { type: 'h2', label: 'Heading 2', hint: '##', keys: 'heading subtitle h2' },
  { type: 'h3', label: 'Heading 3', hint: '###', keys: 'heading small h3' },
  { type: 'bullet', label: 'Bulleted list', hint: '-', keys: 'bullet list dot' },
  { type: 'number', label: 'Numbered list', hint: '1.', keys: 'number list ordered' },
  { type: 'todo', label: 'Checkbox', hint: '[]', keys: 'checkbox todo task check' },
  { type: 'quote', label: 'Quote', hint: '>', keys: 'quote' },
];
const MENU = [
  ...TYPES,
  { type: 'divider', label: 'Divider', hint: '---', keys: 'divider line separator hr' },
  { type: 'image', label: 'Picture or GIF', hint: '', keys: 'image picture photo gif' },
  { type: 'link', label: 'Link to a page', hint: '[[', keys: 'link page' },
];

const PLACEHOLDER = {
  p: 'Type / for blocks, [] for a checkbox, [[ to link a page',
  h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3',
  bullet: 'List item', number: 'List item', todo: 'To do', quote: 'Quote',
};

const SHORTCUTS = [
  ['[] ', 'todo'], ['[]', 'todo'], ['- ', 'bullet'], ['* ', 'bullet'], ['1. ', 'number'],
  ['### ', 'h3'], ['## ', 'h2'], ['# ', 'h1'], ['> ', 'quote'],
];

/**
 * blocks: the saved page text. onChange(blocks) after every edit.
 * chooseImage(): asks for a picture, resolves with its file path (or null).
 * saveImage(file): saves a pasted picture, resolves with its file path.
 */
export function blockEditor({ blocks, wiki, onChange, chooseImage, saveImage }) {
  const root = h('div', { class: 'blocks' });
  let items = (Array.isArray(blocks) && blocks.length ? blocks : [{ type: 'p', text: '' }])
    .filter(b => b && typeof b === 'object')
    .map(b => ({ ...structuredClone(b), key: uid() }));
  if (!items.length) items = [{ type: 'p', text: '', key: uid() }];

  /* ---------- Saving ---------- */

  const value = () => {
    const out = items.map(it => {
      if (it.type === 'divider') return { type: 'divider' };
      if (it.type === 'image') return { type: 'image', src: it.src, ...(it.caption ? { caption: it.caption } : {}) };
      const b = { type: TEXT_TYPES.has(it.type) ? it.type : 'p', text: it.text || '' };
      if (it.type === 'todo') b.checked = !!it.checked;
      return b;
    });
    // Empty paragraphs at the very end don't count.
    while (out.length && out[out.length - 1].type === 'p' && !out[out.length - 1].text.trim()) out.pop();
    return out;
  };
  const emit = () => onChange?.(value());

  /* ---------- Drawing ---------- */

  function rowFor(item) {
    const handle = h('button', {
      type: 'button', class: 'blk-handle', 'aria-label': 'Block options', title: 'Turn into, move or delete',
      onclick: () => blockMenu(item, handle),
    }, '⋮⋮');

    let body;
    if (TEXT_TYPES.has(item.type)) {
      item.input = richText({
        value: item.text || '', wiki, multiline: false,
        placeholder: PLACEHOLDER[item.type], label: TYPES.find(t => t.type === item.type)?.label,
        className: `blk-text blk-${item.type}`,
        onChange: v => { item.text = v; emit(); },
        onKeyDown: e => keys(e, item),
        onPasteImage: file => pasteImage(item, file),
      });
      item.input.addEventListener('input', () => afterInput(item));
      let prefix = null;
      if (item.type === 'bullet') prefix = h('span', { class: 'blk-prefix blk-bullet', 'aria-hidden': 'true', text: '•' });
      if (item.type === 'number') prefix = h('span', { class: 'blk-prefix blk-num', 'aria-hidden': 'true' });
      if (item.type === 'todo') {
        prefix = h('input', {
          type: 'checkbox', class: 'blk-check', checked: !!item.checked, 'aria-label': 'Done',
          onchange: e => { item.checked = e.target.checked; item.el.classList.toggle('done', item.checked); emit(); },
        });
      }
      body = [prefix, item.input];
    } else if (item.type === 'divider') {
      item.input = null;
      body = h('hr', { class: 'blk-hr' });
    } else if (item.type === 'image') {
      item.input = null;
      const caption = richText({
        value: item.caption || '', wiki, multiline: false, placeholder: 'Caption (optional)', label: 'Caption',
        className: 'blk-caption', onChange: v => { item.caption = v; emit(); },
      });
      body = h('figure', { class: 'blk-figure' }, fileImage(item.src, item.caption || '', { className: 'body-pic', placeholder: 'Picture missing' }), caption);
    }
    item.el = h('div', { class: `blk blk-row-${item.type}${item.checked ? ' done' : ''}`, dataset: { key: item.key } },
      handle, h('div', { class: 'blk-body' }, body));
    return item.el;
  }

  function renumber() {
    let n = 0;
    for (const it of items) {
      n = it.type === 'number' ? n + 1 : 0;
      if (it.type === 'number') it.el.querySelector('.blk-num').textContent = `${n}.`;
    }
  }

  function draw() {
    root.replaceChildren(...items.map(rowFor), tail);
    renumber();
  }

  // Clicking the empty space under the last block continues writing there.
  const tail = h('div', {
    class: 'blk-tail', 'aria-hidden': 'true',
    onclick: () => {
      const last = items[items.length - 1];
      if (last && TEXT_TYPES.has(last.type) && !last.text) { placeCaret(last.input, 'end'); return; }
      const it = newItem('p');
      insertAt(items.length, it);
      placeCaret(it.input, 'start');
    },
  });

  /* ---------- Changing the list ---------- */

  const newItem = (type, extra = {}) => ({ type, text: '', key: uid(), ...extra });
  const indexOf = item => items.indexOf(item);

  function insertAt(index, item) {
    items.splice(index, 0, item);
    const next = items[index + 1];
    root.insertBefore(rowFor(item), next ? next.el : tail);
    renumber();
    emit();
  }

  function removeItem(item) {
    const i = indexOf(item);
    if (i < 0) return;
    items.splice(i, 1);
    item.el.remove();
    if (!items.length) insertAt(0, newItem('p'));
    renumber();
    emit();
  }

  function setType(item, type, { caret = 'start' } = {}) {
    item.type = type;
    if (type !== 'todo') delete item.checked;
    const old = item.el;
    old.replaceWith(rowFor(item));
    renumber();
    emit();
    if (item.input && caret != null) {
      if (typeof caret === 'number') placeCaretAt(item.input, caret);
      else placeCaret(item.input, caret);
    }
  }

  function move(item, delta) {
    const i = indexOf(item);
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    items.splice(i, 1);
    items.splice(j, 0, item);
    draw();
    emit();
    if (item.input) placeCaret(item.input, 'end');
  }

  const focusItem = (item, where) => { if (item?.input) placeCaret(item.input, where); };
  const prevText = item => { for (let i = indexOf(item) - 1; i >= 0; i--) if (items[i].input && TEXT_TYPES.has(items[i].type)) return items[i]; return null; };
  const nextText = item => { for (let i = indexOf(item) + 1; i < items.length; i++) if (items[i].input && TEXT_TYPES.has(items[i].type)) return items[i]; return null; };

  /* ---------- Keys ---------- */

  function keys(e, item) {
    const el = item.input;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!item.text && (KEEP_ON_ENTER.has(item.type) || item.type === 'quote')) {
        setType(item, 'p');
        return true;
      }
      // Split the block at the cursor.
      const r = rangeIn(el);
      if (r && !r.collapsed) r.deleteContents();
      const tailRange = document.createRange();
      const at = rangeIn(el);
      tailRange.setStart(at ? at.startContainer : el, at ? at.startOffset : el.childNodes.length);
      tailRange.setEnd(el, el.childNodes.length);
      const holder = document.createElement('div');
      holder.append(tailRange.extractContents());
      const after = serializeEditable(holder);
      item.text = serializeEditable(el);
      el.setValue(item.text);
      const it = newItem(KEEP_ON_ENTER.has(item.type) ? item.type : 'p', { text: after });
      if (it.type === 'todo') it.checked = false;
      insertAt(indexOf(item) + 1, it);
      placeCaret(it.input, 'start');
      return true;
    }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      return true;
    }
    if (e.key === 'Backspace' && caretAtStart(el)) {
      if (item.type !== 'p') {
        e.preventDefault();
        setType(item, 'p');
        return true;
      }
      const i = indexOf(item);
      const prev = items[i - 1];
      if (!prev) return false;
      e.preventDefault();
      if (prev.type === 'divider') { removeItem(prev); placeCaret(el, 'start'); return true; }
      if (prev.type === 'image') { return true; }
      // Join with the block above.
      const join = unitLength(prev.input);
      prev.text = [prev.text, item.text].filter(Boolean).join('');
      prev.input.setValue(prev.text);
      removeItem(item);
      placeCaretAt(prev.input, join);
      emit();
      return true;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
      const c = caretRect(el);
      const b = el.getBoundingClientRect();
      const up = e.key === 'ArrowUp';
      const edge = up ? c.top - b.top < lh * 0.9 : b.bottom - c.bottom < lh * 0.9;
      const target = up ? prevText(item) : nextText(item);
      if (edge && target) {
        e.preventDefault();
        focusItem(target, up ? 'end' : 'start');
        return true;
      }
    }
    return false;
  }

  /* ---------- Shortcuts and the / menu ---------- */

  function afterInput(item) {
    const before = textBeforeCaret(item.input);
    if (item.type === 'p') {
      if (before === '---') {
        deleteBeforeCaret(item.input, 3);
        item.text = item.input.getValue();
        insertDivider(item);
        return;
      }
      for (const [trigger, type] of SHORTCUTS) {
        if (before === trigger) {
          deleteBeforeCaret(item.input, trigger.length);
          item.text = item.input.getValue();
          setType(item, type, { caret: 'start' });
          return;
        }
      }
    }
    const m = before.match(/(?:^|\s)\/([a-z0-9]{0,12})$/i);
    const pop = currentPopup();
    if (!m) {
      if (pop?.owner === item.input && pop.kind === 'slash') pop.close();
      return;
    }
    const q = m[1].toLowerCase();
    const entries = MENU.filter(x => !q || x.label.toLowerCase().includes(q) || x.keys.includes(q))
      .map(x => ({ label: x.label, hint: x.hint, onPick: () => applyMenu(item, x, m[1].length + 1) }));
    if (pop?.owner === item.input && pop.kind === 'slash') {
      pop.setItems(entries);
      pop.place(caretRect(item.input));
    } else {
      const p = openPopup({ rect: caretRect(item.input), items: entries, title: 'Turn into or add', emptyText: 'No block like that' });
      p.owner = item.input;
      p.kind = 'slash';
    }
  }

  function applyMenu(item, entry, typedLength) {
    item.input.focus();
    deleteBeforeCaret(item.input, typedLength);
    item.text = item.input.getValue();
    const empty = !item.text.trim();
    switch (entry.type) {
      case 'link':
        document.execCommand('insertText', false, '[[');
        return;
      case 'divider':
        insertDivider(item);
        return;
      case 'image':
        chooseImage?.().then(src => { if (src) insertImage(item, src); });
        return;
      default:
        if (empty) {
          setType(item, entry.type);
        } else {
          const it = newItem(entry.type);
          insertAt(indexOf(item) + 1, it);
          placeCaret(it.input, 'start');
        }
    }
  }

  function insertDivider(item) {
    const i = indexOf(item);
    if (!item.text.trim()) {
      // This empty line becomes the divider, and writing continues below it.
      item.type = 'divider';
      item.text = '';
      item.el.replaceWith(rowFor(item));
    } else {
      insertAt(i + 1, newItem('divider'));
    }
    const at = indexOf(item) + (item.type === 'divider' ? 1 : 2);
    let next = items[at];
    if (!next || !TEXT_TYPES.has(next.type)) { next = newItem('p'); insertAt(at, next); }
    renumber();
    emit();
    placeCaret(next.input, 'start');
  }

  function insertImage(item, src) {
    const img = newItem('image', { src });
    delete img.text;
    if (item && TEXT_TYPES.has(item.type) && !item.text.trim()) {
      const i = indexOf(item);
      items.splice(i, 1, img);
      item.el.replaceWith(rowFor(img));
    } else {
      insertAt(item ? indexOf(item) + 1 : items.length, img);
    }
    const at = indexOf(img) + 1;
    let next = items[at];
    if (!next || !TEXT_TYPES.has(next.type)) { next = newItem('p'); insertAt(at, next); }
    renumber();
    emit();
    placeCaret(next.input, 'start');
  }

  async function pasteImage(item, file) {
    const src = await saveImage?.(file);
    if (src) insertImage(item, src);
  }

  /* ---------- The ⋮⋮ menu ---------- */

  function blockMenu(item, anchor) {
    const i = indexOf(item);
    const entries = [];
    if (TEXT_TYPES.has(item.type)) {
      for (const t of TYPES) {
        if (t.type !== item.type) entries.push({ label: `Turn into ${t.label.toLowerCase()}`, hint: t.hint, onPick: () => setType(item, t.type, { caret: 'end' }) });
      }
    }
    if (i > 0) entries.push({ label: 'Move up', hint: '↑', onPick: () => move(item, -1) });
    if (i < items.length - 1) entries.push({ label: 'Move down', hint: '↓', onPick: () => move(item, 1) });
    entries.push({ label: 'Delete block', hint: '', onPick: () => removeItem(item) });
    const p = openPopup({ rect: anchor.getBoundingClientRect(), items: entries, title: 'Block' });
    p.owner = anchor;
    p.kind = 'block';
  }

  draw();
  root.value = value;
  root.addImage = src => insertImage(items[items.length - 1], src);
  return root;
}
