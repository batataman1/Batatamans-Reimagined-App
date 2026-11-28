// Using a drawing as a wiki page picture (part 2e).
//
// The picture on the page is a copy of the drawing (a PNG in images/<page>-…), like any picture
// you choose: pixel art at one pixel per square (the wiki shows small pictures sharp), free
// drawings with every detail. When the drawing changes, use it again to update the page.

import { h, clear } from '../core/util.js';
import { store } from '../core/store.js';
import { openModal, errorDialog, toast } from '../ui/dialogs.js';
import { goCrossTab } from '../ui/nav.js';
import { getWiki, pageName } from '../wiki/model.js';
import { saveImage, filesOfPage, isFileOfPage } from '../wiki/images.js';
import { createEngine } from './engine.js';
import { getDrawings, fileOf, scaleFor } from './model.js';
import { thumbCanvas } from './gallery.js';

const canvasBlob = c => new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error("The picture couldn't be made"))), 'image/png'));

/** The drawing as a PNG for the wiki. */
async function drawingBlob(d, engine = null) {
  if (!engine) {
    const file = await store.getFile(fileOf(d));
    engine = createEngine({ width: d.data.width, height: d.data.height, scale: d.data.scale || scaleFor(d.data.width, d.data.height) });
    await engine.load(file?.blob);
  }
  return canvasBlob(engine.exportCanvas(d.data.kind === 'pixel' ? 1 : engine.scale));
}

/** From the drawing editor: put this drawing on a wiki page (its picture, a picture field, or the page text). */
export async function drawingToWikiDialog(d, engine) {
  const wiki = await getWiki();
  const pages = [...wiki.pages.values()].sort((a, b) => pageName(a).localeCompare(pageName(b)));
  if (!pages.length) { toast('There are no wiki pages yet.'); return; }
  let chosen = null;
  const search = h('input', { class: 'input', name: 'page', placeholder: 'Type a page name', autocomplete: 'off', 'aria-label': 'Wiki page' });
  const list = h('ul', { class: 'wp-list', role: 'listbox', 'aria-label': 'Pages' });
  const slot = h('select', { class: 'input', name: 'slot', 'aria-label': 'Where on the page' });
  const slotField = h('label', { class: 'field', hidden: true }, h('span', { class: 'field-label', text: 'Where on the page' }), slot);
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });

  function drawList() {
    const q = search.value.trim().toLowerCase();
    const found = pages.filter(p => !q || pageName(p).toLowerCase().includes(q)).slice(0, 8);
    clear(list, found.length ? found.map(p => h('li', {}, h('button', {
      type: 'button', class: `wp-item${chosen?.id === p.id ? ' chosen' : ''}`, role: 'option', 'aria-selected': String(chosen?.id === p.id),
      onclick: () => choose(p),
    }, h('span', { text: pageName(p) }), p.data.picture ? h('span', { class: 'muted small', text: 'has a picture' }) : null))) : h('li', { class: 'muted small', text: 'No page with that name.' }));
  }
  function choose(p) {
    chosen = p;
    const tpl = wiki.templateOf(p);
    const fields = (tpl?.fields || []).filter(f => f.kind === 'image');
    clear(slot,
      h('option', { value: 'picture', text: p.data.picture ? 'Page picture (replaces the one it has)' : 'Page picture' }),
      fields.map(f => h('option', { value: `field:${f.key}`, text: `${f.label}${p.data.fields?.[f.key] ? ' (replaces it)' : ''}` })),
      h('option', { value: 'body', text: 'A picture at the end of the page text' }));
    slotField.hidden = false;
    search.value = pageName(p);
    drawList();
  }
  search.addEventListener('input', () => { chosen = null; slotField.hidden = true; drawList(); });
  drawList();

  const m = openModal({
    title: 'Use as a wiki page picture',
    body: h('div', { class: 'connect-form' },
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Page' }), search, list),
      slotField,
      h('p', { class: 'muted small', text: d.data.kind === 'pixel'
        ? 'The page gets a copy at one pixel per square (shown sharp). If you change the drawing later, use it again to update the page.'
        : 'The page gets a copy of the drawing. If you change the drawing later, use it again to update the page.' }),
      error),
    actions: [{ id: 'cancel', label: 'Cancel', kind: 'quiet' }, {
      id: 'use', label: 'Use picture', kind: 'primary',
      onClick: async close => {
        if (!chosen) { error.textContent = 'Pick a page first.'; error.hidden = false; return; }
        try {
          const path = await saveImage(await drawingBlob(d, engine), chosen.id);
          const row = await store.get('wiki', chosen.id);
          const data = structuredClone(row?.data || {});
          const before = filesOfPage(data);
          const where = slot.value;
          if (where === 'picture') data.picture = path;
          else if (where === 'body') data.body = [...(Array.isArray(data.body) ? data.body : []), { type: 'image', src: path, caption: '' }];
          else data.fields = { ...(data.fields || {}), [where.slice(6)]: path };
          await store.put('wiki', chosen.id, data);
          // The picture it replaced goes, if nothing else on the page uses it.
          const now = filesOfPage(data);
          for (const f of before) if (!now.has(f) && isFileOfPage(f, chosen.id)) await store.removeFile(f);
          close('done');
          const id = chosen.id;
          toast(`It's on “${pageName(chosen)}” now.`, { action: { label: 'Open the page', onClick: () => goCrossTab(`#/wiki/p/${encodeURIComponent(id)}`) } });
        } catch (err) { errorDialog(err, "The picture couldn't be put on the page"); }
      },
    }],
    onOpen: () => search.focus(),
  });
  return m.result;
}

/** From the wiki editor: pick one of your drawings. Resolves with its picture (a PNG blob) or null. */
export async function chooseDrawingBlob() {
  const { drawings } = await getDrawings();
  const list = drawings.filter(d => d.data.kind !== 'reference');
  let picked = null;
  const grid = h('div', { class: 'wp-grid' }, list.length ? list.map(d => h('button', {
    type: 'button', class: 'wp-card', title: d.data.name, onclick: () => { picked = d; m.close('pick'); },
  }, thumbCanvas(d, 70), h('span', { class: 'wp-name', text: d.data.name }))) : h('p', { class: 'muted', text: 'No drawings yet. Make one in Ideas → Drawings.' }));
  const m = openModal({
    title: 'Use a drawing', className: 'modal-wide',
    body: [h('p', { class: 'muted small', text: 'The page gets a copy of the drawing (pixel art at one pixel per square, shown sharp).' }), grid],
    actions: [{ id: 'cancel', label: 'Cancel', kind: 'quiet' }],
  });
  const v = await m.result;
  if (v !== 'pick' || !picked) return null;
  try { return await drawingBlob(picked); } catch (err) { errorDialog(err, "The drawing couldn't be used"); return null; }
}
