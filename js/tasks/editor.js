// A task's page (#/tasks/t/<id>): title, Task/Bug, priority, status, folder, links to wiki
// pages, and a description written with the same editor as wiki pages (checkboxes, pictures,
// [[ links). Changes save by themselves; "Undo all changes" puts the task back the way it was
// when the page opened.

import { h, clear } from '../core/util.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { confirmDialog, errorDialog, toast } from '../ui/dialogs.js';
import { crossTabClick } from '../ui/nav.js';
import { topNav } from '../wiki/parts.js';
import { pageLink } from '../wiki/text.js';
import { pageItems } from '../wiki/richtext.js';
import { openPopup, currentPopup, closePopup } from '../wiki/popup.js';
import { blockEditor } from '../wiki/blocks.js';
import { saveImage, filesOfPage } from '../wiki/images.js';
import { TYPES, PRIORITIES, STATUSES, DIFFICULTIES, DIFFICULTY_HINTS } from './model.js';
import { folderSelect, confirmDeleteTask, removeTaskAndFiles } from './actions.js';

const APP_TITLE = "Batataman's Reimagined";

export function taskEditorView(el, model, wiki, ui, id) {
  const task = model.get(id);
  if (!task) {
    clear(el, topNav(ui, '', { href: '#/tasks', label: 'Tasks & Bugs' }),
      h('div', { class: 'notice' }, h('p', { text: "This task doesn't exist (anymore). It may have been deleted on another device." })));
    return null;
  }
  const original = structuredClone(task.data);
  let draft = structuredClone(task.data);
  const startFiles = filesOfPage(original);
  const created = new Set();
  let timer = null, pending = false, saving = Promise.resolve(), deleted = false, filesTidied = false;

  document.title = `${task.data.title || 'Task'} · Tasks & Bugs · ${APP_TITLE}`;
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
      .then(() => store.put('tasks', id, data, { source: 'editor' }))
      .then(() => { if (!pending) status.textContent = 'Saved on this device'; })
      .catch(err => { status.textContent = 'Not saved'; errorDialog(err, "Your change couldn't be saved"); });
    return saving;
  }
  async function tidyFiles() {
    if (filesTidied) return;
    filesTidied = true;
    const keep = deleted ? new Set() : filesOfPage(draft);
    for (const f of new Set([...created, ...startFiles])) if (!keep.has(f)) await store.removeFile(f);
  }
  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);

  /* Pictures in the description */

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
  const chooseImage = () => new Promise(resolve => {
    fileInput.value = '';
    fileInput.onchange = async () => { const f = fileInput.files?.[0]; resolve(f ? await addImageFile(f) : null); };
    fileInput.click();
  });

  /* Leaving */

  const back = () => (draft.folder && model.folder(draft.folder) ? `f/${draft.folder}` : '');
  async function done() {
    await flush();
    await tidyFiles();
    ui.finish(back());
  }
  async function undoAll() {
    const ok = await confirmDialog({
      title: 'Undo all changes?',
      body: h('p', { text: 'The task goes back to how it was when you opened it.' }),
      confirm: 'Undo all changes',
    });
    if (!ok) return;
    draft = structuredClone(original);
    changed();
    render();
  }
  async function deleteTask() {
    if (!(await confirmDeleteTask(draft.title))) return;
    deleted = true;
    clearTimeout(timer);
    await saving;
    await tidyFiles();
    await removeTaskAndFiles(id, draft);
    toast('Deleted. Push to remove it from GitHub too.');
    ui.leaveTo(back());
  }

  /* The form */

  const section = (title, ...content) => h('section', { class: 'ed-section' }, h('h2', { text: title }), content);
  const field = (label, control) => h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), control);

  function setStatus(s) {
    if (s === draft.status) return;
    if (s === 'done') draft.doneAt = new Date().toISOString();
    else delete draft.doneAt;
    draft.status = s;
    changed();
  }

  function basics() {
    const typeHost = h('div', { class: 'seg', role: 'group', 'aria-label': 'Task or bug' });
    const drawType = () => clear(typeHost, Object.entries(TYPES).map(([v, label]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': String(draft.type === v),
      onclick: () => { draft.type = v; changed(); drawType(); },
    }, icon(v === 'bug' ? 'bug' : 'tasks', { size: 14 }), label)));
    drawType();
    const select = (name, options, value, onChange) => {
      const sel = h('select', { class: 'input', name, 'aria-label': name },
        Object.entries(options).map(([v, label]) => h('option', { value: v, text: label })));
      sel.value = value;
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    };
    const folder = folderSelect(model, draft.folder);
    folder.addEventListener('change', () => { draft.folder = folder.value || null; changed(); drawNav(); });
    return h('div', { class: 'tk-basics' },
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Kind' }), typeHost),
      field('Priority', select('Priority', PRIORITIES, draft.priority, v => { draft.priority = v; changed(); })),
      field('Difficulty', select('Difficulty',
        { '': 'Not set', ...Object.fromEntries(Object.entries(DIFFICULTIES).map(([k, v]) => [k, `${v} (${DIFFICULTY_HINTS[k]})`])) },
        draft.difficulty || '', v => { draft.difficulty = v || null; changed(); })),
      field('Status', select('Status', STATUSES, draft.status, setStatus)),
      field('Folder', folder));
  }

  function linksEditor() {
    const host = h('div', { class: 'ed-related' });
    const draw = () => {
      const wikiLinks = draft.links.filter(l => l.collection === 'wiki');
      const input = h('input', { class: 'input', placeholder: 'Link a wiki page: type its name', 'aria-label': 'Link a wiki page', autocomplete: 'off', spellcheck: 'false' });
      const pick = pid => {
        draft.links = [...draft.links, { collection: 'wiki', id: pid }];
        changed();
        draw();
        host.querySelector('input')?.focus();
      };
      const update = () => {
        const q = input.value;
        const pop = currentPopup();
        if (!q.trim()) { if (pop?.owner === input) pop.close(); return; }
        const items = pageItems(wiki, q, pick, { exclude: wikiLinks.map(l => l.id) });
        if (pop?.owner === input) { pop.setItems(items); return; }
        const p = openPopup({ rect: input.getBoundingClientRect(), items, title: 'Wiki page', emptyText: 'No page like that' });
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
        draft.links.length
          ? h('div', { class: 'ed-chips' }, draft.links.map((l, i) => {
              const a = l.collection === 'wiki' ? pageLink(wiki, l.id) : h('span', { class: 'wlink', text: `${l.collection}/${l.id}` });
              if (a.tagName === 'A') a.addEventListener('click', crossTabClick);
              return h('span', { class: 'ed-chip' }, a,
                h('button', {
                  type: 'button', class: 'ed-chip-x', 'aria-label': `Remove the link to ${a.textContent}`, title: 'Remove',
                  onclick: () => { draft.links = draft.links.filter((_, j) => j !== i); changed(); draw(); },
                }, '✕'));
            }))
          : h('p', { class: 'muted small', text: 'No links yet. The task shows on the pages it links.' }),
        input);
    };
    draw();
    return host;
  }

  // The path above the title follows the folder and the title as they change.
  const navHost = h('div', { class: 'tk-navhost' });
  function drawNav() {
    const path = draft.folder && model.folder(draft.folder) ? model.path(draft.folder) : [];
    clear(navHost, topNav(ui, back(), { href: '#/tasks', label: 'Tasks & Bugs' }, ...path.map(f => ({ href: `#/tasks/f/${f.id}`, label: f.name })), { label: draft.title.trim() || 'Task' }));
  }

  function render() {
    drawNav();
    clear(el,
      fileInput,
      navHost,
      h('div', { class: 'ed-bar' },
        h('span', { class: 'ed-bar-title' }, icon('edit', { size: 18 }), h('span', { text: draft.type === 'bug' ? 'Editing bug' : 'Editing task' })),
        status,
        h('span', { class: 'ed-bar-actions' },
          h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: undoAll }, 'Undo all changes'),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: done }, 'Done'))),
      h('input', {
        class: 'input ed-name', name: 'title', value: draft.title || '', placeholder: 'What needs doing?', 'aria-label': 'Title', maxLength: 200,
        oninput: e => { draft.title = e.target.value; changed(); drawNav(); },
      }),
      section('Basics', basics()),
      section('Links', linksEditor()),
      section('Description',
        h('p', { class: 'muted small ed-hint', text: 'Type / for blocks, [] for a checkbox, [[ to link a wiki page. Paste a screenshot to add it.' }),
        blockEditor({
          blocks: draft.body, wiki, chooseImage, saveImage: addImageFile,
          onChange: b => { draft.body = b; changed(); },
        })),
      h('section', { class: 'ed-section ed-danger' },
        h('button', { type: 'button', class: 'btn btn-small btn-danger-outline', onclick: deleteTask }, icon('trash', { size: 16 }), 'Delete this task')));
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

/** The saved form of a task: empty things left out. */
function cleaned(d) {
  const out = structuredClone(d);
  out.title = String(out.title || '').trim();
  const seen = new Set();
  out.links = (out.links || []).filter(l => { const k = `${l.collection}/${l.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!out.links.length) delete out.links;
  if (!Array.isArray(out.body) || !out.body.length) delete out.body;
  if (!out.folder) out.folder = null;
  if (!out.difficulty) delete out.difficulty;
  return out;
}
