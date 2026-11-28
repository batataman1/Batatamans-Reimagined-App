// Editing a wiki page (#/wiki/e/<id>), making new pages and deleting them.
//
// Changes save on this device by themselves while you type (like Notion), and the page is
// marked "Not pushed" until you Push. "Undo all changes" puts the page back the way it was
// when you opened the editor. "Done" goes back to reading the page.

import { h, clear, slugify, isValidId, humanizeKey } from '../core/util.js';
import { store } from '../core/store.js';
import { STATUSES } from '../config/wiki.js';
import { icon } from '../ui/icons.js';
import { openModal, confirmDialog, errorDialog, toast } from '../ui/dialogs.js';
import { pageName } from './model.js';
import { topNav, fileImage } from './parts.js';
import { richText, pageItems, linkChip } from './richtext.js';
import { openPopup, currentPopup, closePopup } from './popup.js';
import { blockEditor } from './blocks.js';
import { saveImage, filesOfPage, isPicturePath } from './images.js';
import { chooseDrawingBlob } from '../draw/wikipic.js';
import { confirmDeletePage, removePageAndFiles } from './actions.js';

const APP_TITLE = "Batataman's Reimagined";

/* ---------- Shared bits ---------- */

/**
 * A dropdown of every sub-group, grouped by group. value is "group/sub".
 * Hidden groups and sub-groups are left out, unless the page is already in one.
 */
function whereSelect(wiki, value, { allowNone = false, placeholder = 'Choose where it goes' } = {}) {
  const sel = h('select', { class: 'input', name: 'where', 'aria-label': 'Sub-group' },
    allowNone ? h('option', { value: '', text: 'Not sorted yet' }) : h('option', { value: '', text: placeholder, disabled: true }),
    wiki.groups.map(g => {
      const subs = g.subgroups.filter(s => (!g.hidden && !s.hidden) || `${g.id}/${s.id}` === value);
      return subs.length ? h('optgroup', { label: g.hidden ? `${g.name} (hidden)` : g.name },
        subs.map(s => h('option', { value: `${g.id}/${s.id}`, text: s.hidden ? `${s.name} (hidden)` : s.name }))) : null;
    }));
  sel.value = value || '';
  return sel;
}

function placeOf(wiki, data) {
  const g = wiki.groups.find(x => x.id === data.group);
  const s = g?.subgroups.find(x => x.id === data.subgroup);
  return s ? { group: g, sub: s } : null;
}

const formField = (label, control, hint) => h('label', { class: 'field' },
  h('span', { class: 'field-label', text: label }), control,
  hint ? h('span', { class: 'field-hint', text: hint }) : null);

/* ---------- New page ---------- */

/**
 * Ask for a name and a sub-group, create the page, open the editor.
 * id: create the page with this exact id (from a dashed link), so links to it work.
 */
export function newPageDialog(wiki, ui, { where = '', id: fixedId = null, name = '' } = {}) {
  const nameInput = h('input', { class: 'input', name: 'name', value: name, autocomplete: 'off', placeholder: 'For example: Ostrich Feather', maxLength: 80 });
  const whereSel = whereSelect(wiki, where);
  const planned = h('input', { type: 'checkbox', name: 'planned' });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const fail = text => { error.textContent = text; error.hidden = false; };

  async function create(close) {
    error.hidden = true;
    const n = nameInput.value.trim();
    if (!n) return fail('Give the page a name.');
    if (!whereSel.value) return fail('Choose where the page goes.');
    const id = fixedId || slugify(n);
    if (!isValidId(id)) return fail('Use some letters or numbers in the name.');
    const existing = await store.get('wiki', id);
    if (existing) return fail(`There's already a page called “${pageName(existing)}”. Pick another name.`);
    const [group, subgroup] = whereSel.value.split('/');
    const data = { name: n, group, subgroup };
    if (planned.checked) data.status = 'planned';
    await store.put('wiki', id, data);
    close('created');
    ui.go(`e/${id}`);
  }

  const m = openModal({
    title: fixedId ? 'Create this page' : 'New page',
    body: h('div', { class: 'connect-form' },
      formField('Name', nameInput, fixedId ? 'Links to this page keep working if you change the name.' : null),
      formField('Goes in', whereSel, 'The sub-group decides which fields the info box has.'),
      h('label', { class: 'ed-check' }, planned, h('span', { text: 'Planned (not in the mod yet)' })),
      error),
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'create', label: 'Create page', kind: 'primary', onClick: create },
    ],
    onOpen: () => { nameInput.focus(); nameInput.select(); },
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(m.close); } });
  return m.result;
}

/* ---------- Editing ---------- */

/** Draw the editor for a page. Returns a function that saves and tidies up when leaving. */
export function editorView(el, wiki, ui, id) {
  const page = wiki.get(id);
  const original = structuredClone(page.data);
  let draft = structuredClone(page.data);
  const startFiles = filesOfPage(original);
  const created = new Set();
  let timer = null;
  let pending = false;
  let saving = Promise.resolve();
  let deleted = false;
  let filesTidied = false;

  document.title = `Editing ${pageName(page)} · ${APP_TITLE}`;
  const status = h('span', { class: 'ed-status', role: 'status', text: 'Changes save by themselves' });

  /* Saving */

  function changed() {
    pending = true;
    status.textContent = 'Saving…';
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }

  function flush() {
    clearTimeout(timer);
    if (!pending || deleted) return saving;
    pending = false;
    const data = cleaned(draft);
    saving = saving
      .then(() => store.put('wiki', id, data, { source: 'editor' }))
      .then(() => { if (!pending) status.textContent = 'Saved on this device'; })
      .catch(err => { status.textContent = 'Not saved'; errorDialog(err, "Your change couldn't be saved"); });
    return saving;
  }

  // Pictures that ended up unused (replaced, removed, or added and then undone) are deleted.
  async function tidyFiles() {
    if (filesTidied) return;
    filesTidied = true;
    const keep = deleted ? new Set() : filesOfPage(draft);
    for (const f of new Set([...created, ...startFiles])) {
      if (!keep.has(f)) await store.removeFile(f);
    }
  }

  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);

  /* Pictures */

  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });

  async function addImageFile(file) {
    status.textContent = 'Saving picture…';
    try {
      const path = await saveImage(file, id);
      created.add(path);
      status.textContent = pending ? 'Saving…' : 'Saved on this device';
      return path;
    } catch (err) {
      status.textContent = 'Saved on this device';
      errorDialog(err, "That picture can't be used");
      return null;
    }
  }

  /** One of your drawings as a picture (a copy). */
  async function chooseDrawing() {
    const blob = await chooseDrawingBlob();
    return blob ? addImageFile(blob) : null;
  }

  function chooseImage() {
    return new Promise(resolve => {
      fileInput.value = '';
      fileInput.onchange = async () => {
        const f = fileInput.files?.[0];
        resolve(f ? await addImageFile(f) : null);
      };
      fileInput.click();
    });
  }

  /* Leaving */

  async function done() {
    await flush();
    await tidyFiles();
    ui.finishEdit(id);
  }

  async function undoAll() {
    const ok = await confirmDialog({
      title: 'Undo all changes?',
      body: h('p', { text: 'The page goes back to how it was when you opened the editor.' }),
      confirm: 'Undo all changes',
    });
    if (!ok) return;
    draft = structuredClone(original);
    changed();
    render();
  }

  async function deletePage() {
    if (!(await confirmDeletePage(draft.name || pageName(page)))) return;
    deleted = true;
    clearTimeout(timer);
    await saving;
    await tidyFiles();
    await removePageAndFiles(id, draft);
    toast('Page deleted. Push to remove it from GitHub too.');
    const place = placeOf(wiki, draft);
    ui.leaveTo(place ? `g/${place.group.id}/${place.sub.id}` : '');
  }

  /* The form */

  function render() {
    const place = placeOf(wiki, draft);
    const name = draft.name || pageName(page);
    clear(el,
      fileInput,
      topNav(ui, `p/${id}`, { href: '#/wiki', label: 'Wiki' },
        ...(place ? [{ href: `#/wiki/g/${place.group.id}`, label: place.group.name }, { href: `#/wiki/g/${place.group.id}/${place.sub.id}`, label: place.sub.name }] : []),
        { href: `#/wiki/p/${id}`, label: name }),
      h('div', { class: 'ed-bar' },
        h('span', { class: 'ed-bar-title' }, icon('edit', { size: 18 }), h('span', { text: 'Editing' })),
        status,
        h('span', { class: 'ed-bar-actions' },
          h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: undoAll }, 'Undo all changes'),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: done }, 'Done'))),
      h('input', {
        class: 'input ed-name', value: draft.name || '', placeholder: 'Page name', 'aria-label': 'Page name', maxLength: 80,
        oninput: e => { draft.name = e.target.value; changed(); },
      }),
      section('Basics', basics()),
      section('Picture', pictureEditor()),
      section('Overview', richText({
        value: draft.overview || '', wiki, label: 'Overview',
        placeholder: 'A short description. It shows at the top of the page and in lists.',
        onChange: v => { draft.overview = v; changed(); },
      })),
      fieldsSection(),
      section('Variants', variantsEditor()),
      section('Page text',
        h('p', { class: 'muted small ed-hint', text: 'Type / for blocks, [] for a checkbox, - for a list, [[ to link a page. Ctrl+B bold, Ctrl+I italic. Paste a picture to add it.' }),
        blockEditor({
          blocks: draft.body, wiki, chooseImage, saveImage: addImageFile,
          onChange: b => { draft.body = b; changed(); },
        })),
      section('Notes', richText({
        value: draft.notes || '', wiki, label: 'Notes', placeholder: 'Anything else worth remembering',
        onChange: v => { draft.notes = v; changed(); },
      })),
      section('Related pages', relatedEditor()),
      h('section', { class: 'ed-section ed-danger' },
        h('button', { type: 'button', class: 'btn btn-small btn-danger-outline', onclick: deletePage },
          icon('trash', { size: 16 }), 'Delete this page')),
    );
  }

  const section = (title, ...content) => h('section', { class: 'ed-section' }, h('h2', { text: title }), content);

  function basics() {
    const place = placeOf(wiki, draft);
    const where = whereSelect(wiki, place ? `${draft.group}/${draft.subgroup}` : '', { allowNone: !place });
    where.addEventListener('change', () => {
      if (where.value) [draft.group, draft.subgroup] = where.value.split('/');
      changed();
      renderFields();
    });
    const statusSel = h('select', { class: 'input', 'aria-label': 'Status' },
      h('option', { value: '', text: 'In the mod' }),
      Object.entries(STATUSES).map(([k, label]) => h('option', { value: k, text: label })));
    statusSel.value = draft.status || '';
    statusSel.addEventListener('change', () => { draft.status = statusSel.value; changed(); });
    const version = h('input', {
      class: 'input', value: draft.versionAdded || '', placeholder: 'e.g. 1.0.0', 'aria-label': 'Version added',
      oninput: e => { draft.versionAdded = e.target.value.trim(); changed(); },
    });
    const vanilla = h('input', {
      type: 'checkbox', checked: !!draft.vanilla,
      onchange: e => { draft.vanilla = e.target.checked; changed(); },
    });
    return h('div', { class: 'ed-grid' },
      formField('Goes in', where),
      formField('Status', statusSel),
      formField('Version added', version),
      h('label', { class: 'ed-check' }, vanilla, h('span', { text: 'A vanilla thing the mod changes' })));
  }

  function pictureEditor() {
    const host = h('div', { class: 'ed-picture' });
    const draw = () => clear(host,
      fileImage(draft.picture, draft.name || '', { className: 'ed-pic', placeholder: 'No picture yet' }),
      h('div', { class: 'ed-pic-side' },
        h('div', { class: 'button-row' },
          h('button', {
            type: 'button', class: 'btn btn-small',
            onclick: async () => { const p = await chooseImage(); if (p) { draft.picture = p; changed(); draw(); } },
          }, icon('image', { size: 16 }), draft.picture ? 'Change picture' : 'Choose a picture'),
          h('button', {
            type: 'button', class: 'btn btn-small btn-quiet', title: 'Use one of your drawings (a copy of it)',
            onclick: async () => { const p = await chooseDrawing(); if (p) { draft.picture = p; changed(); draw(); } },
          }, icon('brush', { size: 16 }), 'From a drawing'),
          draft.picture ? h('button', {
            type: 'button', class: 'btn btn-small btn-quiet',
            onclick: () => { delete draft.picture; changed(); draw(); },
          }, 'Remove') : null),
        h('p', { class: 'muted small', text: 'PNG, JPG, WebP or GIF. Big pictures are made smaller; GIFs keep their animation. It also becomes the page\'s icon in lists.' })));
    draw();
    return host;
  }

  /* Info box fields (they follow the sub-group's template) */

  const fieldsTitle = h('h2');
  const fieldsHost = h('div', { class: 'ed-fields' });

  function fieldsSection() {
    renderFields();
    return h('section', { class: 'ed-section' }, fieldsTitle, fieldsHost);
  }

  function renderFields() {
    const place = placeOf(wiki, draft);
    const tpl = place ? wiki.templates[place.sub.template] : null;
    fieldsTitle.textContent = tpl ? `Info box (${tpl.name} template)` : 'Info box';
    const fields = draft.fields && typeof draft.fields === 'object' ? draft.fields : {};
    const known = tpl ? tpl.fields : [];
    const extra = Object.keys(fields).filter(k => !known.some(f => f.key === k) && fields[k] != null && fields[k] !== '');
    clear(fieldsHost,
      tpl ? null : h('p', { class: 'muted', text: 'Choose where the page goes to get its fields.' }),
      // A text field that holds a picture (its template changed it to text) still shows the picture.
      known.map(f => (f.kind === 'image' || isPicturePath(fields[f.key]) ? pictureFieldRow(f.key, f.label) : fieldRow(f.key, f.label))),
      extra.length ? h('p', { class: 'muted small ed-extra-note', text: 'From a different template. They still show on the page; remove them if you don\'t need them.' }) : null,
      extra.map(k => (isPicturePath(fields[k]) ? pictureFieldRow(k, humanizeKey(k), true) : fieldRow(k, humanizeKey(k), true))));
  }

  const removeField = key => { const f = { ...draft.fields }; delete f[key]; draft.fields = f; changed(); renderFields(); };

  // A field that holds a picture or GIF, like the crafting recipe.
  function pictureFieldRow(key, label, removable = false) {
    const setValue = v => { draft.fields = { ...(draft.fields || {}), [key]: v }; changed(); renderFields(); };
    const current = draft.fields?.[key];
    const oldText = current && !isPicturePath(current) ? String(current) : '';
    const pic = isPicturePath(current) ? current : null;
    return h('div', { class: 'ed-field ed-field-pic' },
      h('span', { class: 'ed-field-label', text: label }),
      h('div', { class: 'ed-field-pic-body' },
        pic ? fileImage(pic, label, { className: 'ed-recipe-pic', placeholder: 'Picture missing' }) : null,
        oldText ? h('p', { class: 'muted small' }, 'Written as text: ', h('span', { class: 'ed-oldtext', text: oldText }), '. Choose a picture to replace it.') : null,
        h('div', { class: 'button-row' },
          h('button', {
            type: 'button', class: 'btn btn-small',
            onclick: async () => { const p = await chooseImage(); if (p) setValue(p); },
          }, icon('image', { size: 16 }), pic ? 'Change picture' : 'Choose a picture or GIF'),
          h('button', {
            type: 'button', class: 'btn btn-small btn-quiet', title: 'Use one of your drawings (a copy of it)',
            onclick: async () => { const p = await chooseDrawing(); if (p) setValue(p); },
          }, icon('brush', { size: 16 }), 'From a drawing'),
          pic || oldText ? h('button', { type: 'button', class: 'btn btn-small btn-quiet', onclick: () => setValue('') }, 'Remove') : null),
        pic ? null : h('p', { class: 'muted small', text: 'A screenshot of the recipe works well; GIFs keep their animation.' })),
      removable ? h('button', {
        type: 'button', class: 'icon-btn ed-x', 'aria-label': `Remove ${label}`, title: 'Remove this field', onclick: () => removeField(key),
      }, icon('close', { size: 14 })) : null);
  }

  function fieldRow(key, label, removable = false) {
    const input = richText({
      value: draft.fields?.[key] ?? '', wiki, label, placeholder: '—',
      onChange: v => { draft.fields = { ...(draft.fields || {}), [key]: v }; changed(); },
    });
    return h('div', { class: 'ed-field' },
      h('span', { class: 'ed-field-label', text: label }),
      input,
      removable ? h('button', {
        type: 'button', class: 'icon-btn ed-x', 'aria-label': `Remove ${label}`, title: 'Remove this field',
        onclick: () => removeField(key),
      }, icon('close', { size: 14 })) : null);
  }

  /* Variants */

  function variantsEditor() {
    const host = h('div', { class: 'ed-variants' });
    const list = () => (Array.isArray(draft.variants) ? draft.variants : (draft.variants = []));
    const tool = (label, text, enabled, fn) => h('button', {
      type: 'button', class: 'icon-btn ed-tool', 'aria-label': label, title: label, disabled: !enabled, onclick: fn,
    }, text);
    const draw = () => {
      const vs = list();
      clear(host,
        vs.length ? h('div', { class: 'ed-variant-list' }, vs.map((v, i) => h('div', { class: 'ed-variant' },
          richText({ value: v.name || '', wiki, multiline: false, placeholder: 'Name', label: `Variant ${i + 1} name`, className: 'ed-variant-name', onChange: t => { v.name = t; changed(); } }),
          richText({ value: v.note || '', wiki, placeholder: 'Note: recipe, how to get it…', label: `Variant ${i + 1} note`, onChange: t => { v.note = t; changed(); } }),
          h('span', { class: 'ed-tools' },
            tool('Move up', '↑', i > 0, () => { [vs[i - 1], vs[i]] = [vs[i], vs[i - 1]]; changed(); draw(); }),
            tool('Move down', '↓', i < vs.length - 1, () => { [vs[i + 1], vs[i]] = [vs[i], vs[i + 1]]; changed(); draw(); }),
            tool('Remove variant', '✕', true, () => { vs.splice(i, 1); changed(); draw(); })))))
          : h('p', { class: 'muted small', text: 'No variants. Use them for things that come in several versions, like the blocks of a wood set.' }),
        h('button', {
          type: 'button', class: 'btn btn-small',
          onclick: () => { vs.push({ name: '', note: '' }); changed(); draw(); host.querySelector('.ed-variant:last-child .rt')?.focus(); },
        }, icon('plus', { size: 16 }), 'Add variant'));
    };
    draw();
    return host;
  }

  /* Related pages */

  function relatedEditor() {
    const host = h('div', { class: 'ed-related' });
    const draw = () => {
      const rel = Array.isArray(draft.related) ? draft.related : [];
      const input = h('input', { class: 'input', placeholder: 'Add a page: type its name', 'aria-label': 'Add a related page', autocomplete: 'off', spellcheck: 'false' });
      const pick = pid => {
        draft.related = [...rel, pid];
        changed();
        draw();
        host.querySelector('input')?.focus();
      };
      const update = () => {
        const q = input.value;
        const pop = currentPopup();
        if (!q.trim()) { if (pop?.owner === input) pop.close(); return; }
        const items = pageItems(wiki, q, pick, { exclude: [id, ...rel] });
        if (pop?.owner === input) { pop.setItems(items); return; }
        const p = openPopup({ rect: input.getBoundingClientRect(), items, title: 'Related page', emptyText: 'No page like that' });
        p.owner = input;
      };
      input.addEventListener('input', update);
      input.addEventListener('keydown', e => {
        const pop = currentPopup();
        if (pop?.owner !== input) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pop.move(e.key === 'ArrowDown' ? 1 : -1); }
        else if (e.key === 'Enter') { e.preventDefault(); pop.pick(); }
        else if (e.key === 'Escape') { e.preventDefault(); pop.close(); }
      });
      input.addEventListener('blur', () => setTimeout(() => { if (currentPopup()?.owner === input && document.activeElement !== input) currentPopup().close(); }, 200));
      clear(host,
        rel.length
          ? h('div', { class: 'ed-chips' }, rel.map((r, i) => h('span', { class: 'ed-chip' },
              linkChip(wiki, r),
              h('button', {
                type: 'button', class: 'ed-chip-x', 'aria-label': `Remove ${r}`, title: 'Remove',
                onclick: () => { draft.related = rel.filter((_, j) => j !== i); changed(); draw(); },
              }, '✕'))))
          : h('p', { class: 'muted small', text: 'None yet.' }),
        input);
    };
    draw();
    return host;
  }

  render();

  return async () => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flush);
    closePopup();
    if (!deleted) await flush();
    await tidyFiles();
  };
}

/** The saved form of the page: empty things left out. */
function cleaned(d) {
  const out = structuredClone(d);
  if (typeof out.name === 'string') out.name = out.name.trim();
  for (const k of ['overview', 'notes', 'versionAdded', 'picture', 'status']) {
    if (out[k] === '' || out[k] === undefined) delete out[k];
  }
  if (!out.vanilla) delete out.vanilla;
  if (out.fields && typeof out.fields === 'object') {
    for (const [k, v] of Object.entries(out.fields)) if (v == null || !String(v).trim()) delete out.fields[k];
    if (!Object.keys(out.fields).length) delete out.fields;
  }
  if (Array.isArray(out.variants)) {
    out.variants = out.variants
      .filter(v => v && ((v.name || '').trim() || (v.note || '').trim()))
      .map(v => ({ name: v.name || '', ...(v.note ? { note: v.note } : {}) }));
    if (!out.variants.length) delete out.variants;
  }
  if (Array.isArray(out.related)) {
    out.related = [...new Set(out.related.filter(Boolean))];
    if (!out.related.length) delete out.related;
  }
  if (Array.isArray(out.body) && !out.body.length) delete out.body;
  return out;
}
