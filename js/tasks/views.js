// The Tasks & Bugs tab's screens.
//
// Addresses (after #/tasks/):
//   (nothing)      all tasks
//   f/none         tasks without a folder
//   f/<folder>     a folder (its sub-folders' tasks included)
//   t/<task>       a task's page (tasks/editor.js)
//
// The list/board choice and the filters are remembered on this device (not synced).

import { h, clear, plural } from '../core/util.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { openModal, confirmDialog, messageDialog, errorDialog, toast } from '../ui/dialogs.js';
import { sortable } from '../ui/drag.js';
import { openPopup } from '../wiki/popup.js';
import { topNav } from '../wiki/parts.js';
import { nameFor } from '../wiki/text.js';
import { orderBetween } from '../wiki/custom.js';
import { crossTabClick } from '../ui/nav.js';
import { TYPES, PRIORITIES, STATUSES, byPriority, byDone, filterTasks, updateTask, createTask, newFolderId } from './model.js';
import { taskEditorView } from './editor.js';
import { removeTaskAndFiles, confirmDeleteTask, folderSelect } from './actions.js';

const APP_TITLE = "Batataman's Reimagined";

export function parseTasksPath(path) {
  const [kind, a] = String(path || '').split('/').map(x => decodeURIComponent(x));
  if (kind === 't' && a) return { view: 'task', id: a };
  if (kind === 'f' && a) return { view: 'list', folder: a };
  return { view: 'list', folder: 'all' };
}

export function renderTasksView(el, path, model, wiki, ui) {
  const route = parseTasksPath(path);
  document.title = `Tasks & Bugs · ${APP_TITLE}`;
  if (route.view === 'task') return taskEditorView(el, model, wiki, ui, route.id);
  return homeView(el, model, wiki, ui, route.folder);
}

/* ---------- Small pieces ---------- */

const folderHref = key => (key === 'all' ? '#/tasks' : `#/tasks/f/${encodeURIComponent(key)}`);

function folderTitle(model, key) {
  if (key === 'all') return 'All tasks';
  if (key === 'none') return 'No folder';
  return model.folder(key)?.name || 'Folder';
}

function tags(t, { showStatus = true } = {}) {
  const d = t.data;
  return [
    d.type === 'bug' ? h('span', { class: 'tag tag-bug' }, icon('bug', { size: 12 }), 'Bug') : null,
    d.priority !== 'normal' ? h('span', { class: `tag tag-pri tag-pri-${d.priority}`, text: PRIORITIES[d.priority] }) : null,
    showStatus && d.status === 'doing' ? h('span', { class: 'tag tag-doing', text: 'In progress' }) : null,
    t.dirty ? h('span', { class: 'tag tag-dirty', text: 'Not pushed' }) : null,
  ];
}

/** "Ostrich, Rope": the names of the wiki pages a task links. */
function linkNames(t, wiki) {
  return t.data.links.filter(l => l.collection === 'wiki').map(l => nameFor(wiki, l.id)).join(', ');
}

/** The folder a task is in, shown when it isn't the folder being looked at. */
function folderLine(t, model, key) {
  const f = model.folderOf(t);
  if (!f || f === key) return '';
  return model.path(f).map(x => x.name).join(' › ');
}

/** The ⋯ menu of a task (in the list and on the board). */
export function taskMenu(t, anchor, model, ui) {
  const status = s => ({ label: s === 'done' ? 'Mark done' : `Move to ${STATUSES[s]}`, onPick: () => updateTask(t.id, { status: s }) });
  openPopup({
    rect: anchor.getBoundingClientRect(),
    title: t.data.title || 'Task',
    items: [
      { label: 'Open', icon: 'edit', onPick: () => ui.go(`t/${t.id}`) },
      ...Object.keys(STATUSES).filter(s => s !== t.data.status).map(status),
      { label: 'Move to folder…', icon: 'tasks', onPick: () => moveTaskDialog(t, model) },
      {
        label: 'Delete', icon: 'trash',
        onPick: async () => {
          if (!(await confirmDeleteTask(t.data.title))) return;
          await removeTaskAndFiles(t.id, t.data);
          toast('Deleted. Push to remove it from GitHub too.');
        },
      },
    ],
  });
}

function moveTaskDialog(t, model) {
  const sel = folderSelect(model, t.data.folder);
  return openModal({
    title: `Move “${t.data.title || 'task'}”`,
    body: h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Folder' }), sel),
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'move', label: 'Move', kind: 'primary', onClick: async close => { await updateTask(t.id, { folder: sel.value || null }); close('moved'); } },
    ],
  }).result;
}

/** The round tick: done / not done. */
function tick(t) {
  const done = t.data.status === 'done';
  return h('button', {
    type: 'button', class: 'tk-tick', role: 'checkbox', 'aria-checked': String(done),
    'aria-label': `${done ? 'Done' : 'Not done'}: ${t.data.title || 'task'}`, title: done ? 'Mark not done' : 'Mark done',
    onclick: () => updateTask(t.id, { status: done ? 'todo' : 'done' }),
  }, done ? '✓' : '');
}

function taskItem(t, model, wiki, ui, key) {
  const more = h('button', {
    type: 'button', class: 'row-menu', 'aria-label': `More for ${t.data.title || 'task'}`, title: 'Status, folder, delete',
    onclick: () => taskMenu(t, more, model, ui),
  }, '⋯');
  const where = folderLine(t, model, key);
  const links = linkNames(t, wiki);
  return h('li', { class: `tk-item tk-pri-${t.data.priority} tk-${t.data.status}`, dataset: { task: t.id } },
    tick(t),
    h('a', { class: 'tk-row', href: `#/tasks/t/${t.id}` },
      h('span', { class: 'tk-row-head' }, h('span', { class: 'tk-title', text: t.data.title || '(no title)' }), tags(t)),
      where || links ? h('span', { class: 'tk-row-sub' },
        where ? h('span', { class: 'tk-where' }, icon('tasks', { size: 12 }), where) : null,
        links ? h('span', { class: 'tk-links' }, icon('book', { size: 12 }), links) : null) : null),
    more);
}

/** A task in the "Tasks & bugs" box of a wiki page: tick, title (opens the task), tags. */
export function linkedTaskItem(t) {
  const a = h('a', { class: 'tk-row', href: `#/tasks/t/${t.id}` },
    h('span', { class: 'tk-row-head' }, h('span', { class: 'tk-title', text: t.data.title || '(no title)' }), tags(t)));
  a.addEventListener('click', crossTabClick);
  return h('li', { class: `tk-item tk-pri-${t.data.priority} tk-${t.data.status}`, dataset: { task: t.id } }, tick(t), a);
}

/* ---------- Folders ---------- */

function folderPanel(model, ui, key) {
  const panel = h('div', { class: 'tk-side-panel', id: 'tk-folders' });
  const toggle = h('button', {
    type: 'button', class: 'btn tk-side-toggle', 'aria-expanded': String(!!ui.foldersOpen), 'aria-controls': 'tk-folders',
    onclick: () => {
      ui.foldersOpen = !ui.foldersOpen;
      toggle.setAttribute('aria-expanded', String(ui.foldersOpen));
      panel.classList.toggle('open', ui.foldersOpen);
    },
  }, icon('tasks', { size: 18 }), h('span', { class: 'tk-side-current', text: folderTitle(model, key) }), h('span', { class: 'tk-caret', 'aria-hidden': 'true', text: '▾' }));
  panel.classList.toggle('open', !!ui.foldersOpen);

  const link = (k, label, depth = 0) => h('a', {
    class: 'tk-flink', href: folderHref(k), 'aria-current': k === key ? 'page' : null,
    style: { '--depth': depth },
    onclick: () => { ui.foldersOpen = false; },
  }, h('span', { class: 'tk-fname', text: label }), h('span', { class: 'tk-fcount', 'aria-label': plural(model.openCount(k), 'open task'), text: String(model.openCount(k) || '') }));

  const list = parent => {
    const box = h('div', { class: 'tk-flist' }, model.childrenOf(parent).map((f, i, sibs) => {
      const handle = h('button', {
        type: 'button', class: 'sort-handle tk-fhandle', 'aria-label': `Move ${f.name}`, title: 'Drag to change the order. Tap for more',
        onclick: () => folderMenu(f, handle, model, ui, i, sibs),
      }, '⋮⋮');
      return h('div', { class: 'tk-frow sort-row', dataset: { folder: f.id } },
        h('div', { class: 'tk-fline' }, handle, link(f.id, f.name, model.path(f.id).length - 1)),
        model.childrenOf(f.id).length ? list(f.id) : null);
    }));
    sortable(box, { onMove: (from, to) => moveFolder(model, parent, from, to) });
    return box;
  };

  clear(panel,
    h('div', { class: 'tk-side-head' },
      h('h2', { text: 'Folders' }),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => newFolderDialog(model, ui, null) }, icon('plus', { size: 14 }), 'New folder')),
    h('nav', { class: 'tk-fnav', 'aria-label': 'Folders' },
      link('all', 'All tasks'),
      link('none', 'No folder'),
      model.folders.size ? list(null) : h('p', { class: 'muted small tk-fempty', text: 'No folders yet. Folders group tasks that belong together, like everything for one mob.' })),
    model.folders.size ? h('p', { class: 'muted small tk-fhint', text: 'Drag ⋮⋮ to change the order; tap it to rename, move or delete.' }) : null);

  return h('aside', { class: 'tk-side' }, toggle, panel);
}

async function moveFolder(model, parent, from, to) {
  const sibs = [...model.childrenOf(parent)];
  const [f] = sibs.splice(from, 1);
  sibs.splice(to, 0, f);
  const before = sibs[to - 1]?.order ?? null, after = sibs[to + 1]?.order ?? null;
  const order = orderBetween(before, after);
  try {
    if ((before !== null && !(order > before)) || (after !== null && !(order < after))) {
      for (const [i, x] of sibs.entries()) await saveFolder(x, { order: (i + 1) * 10 });
    } else {
      await saveFolder(f, { order });
    }
  } catch (err) { errorDialog(err, "The new order couldn't be saved"); }
}

const saveFolder = (f, change) => store.put('task-folders', f.id, { name: f.name, parent: f.parent, order: f.order, ...change });

function folderMenu(f, anchor, model, ui, i, sibs) {
  openPopup({
    rect: anchor.getBoundingClientRect(),
    title: f.name,
    items: [
      { label: 'New folder inside', icon: 'plus', onPick: () => newFolderDialog(model, ui, f.id) },
      { label: 'Rename', icon: 'edit', onPick: () => renameFolderDialog(f) },
      { label: 'Move into another folder…', icon: 'tasks', onPick: () => moveFolderDialog(f, model) },
      i > 0 ? { label: 'Move up', onPick: () => moveFolder(model, f.parent, i, i - 1) } : null,
      i < sibs.length - 1 ? { label: 'Move down', onPick: () => moveFolder(model, f.parent, i, i + 1) } : null,
      { label: 'Delete folder', icon: 'trash', onPick: () => deleteFolder(f, model, ui) },
    ].filter(Boolean),
  });
}

function nameDialog({ title, value = '', label = 'Name', confirm, hint, extra = null, onSave }) {
  const input = h('input', { class: 'input', name: 'name', value, autocomplete: 'off', maxLength: 60, placeholder: 'For example: Ostrich' });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const save = async close => {
    const n = input.value.trim();
    if (!n) { error.textContent = 'Give it a name.'; error.hidden = false; return; }
    try { await onSave(n); } catch (err) { error.textContent = err.message || String(err); error.hidden = false; return; }
    close('saved');
  };
  const m = openModal({
    title,
    body: h('div', { class: 'connect-form' },
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), input, hint ? h('span', { class: 'field-hint', text: hint }) : null),
      extra, error),
    actions: [{ id: 'cancel', label: 'Cancel', kind: 'quiet' }, { id: 'save', label: confirm, kind: 'primary', onClick: save }],
    onOpen: () => { input.focus(); input.select(); },
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(m.close); } });
  return m.result;
}

function newFolderDialog(model, ui, parent) {
  const inside = folderSelect(model, parent, { none: 'Top level (not inside a folder)', name: 'parent' });
  return nameDialog({
    title: 'New folder', confirm: 'Make folder',
    extra: h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Inside' }), inside),
    onSave: async name => {
      const p = inside.value || null;
      const sibs = model.childrenOf(p);
      const order = sibs.length ? sibs[sibs.length - 1].order + 10 : 10;
      const id = newFolderId();
      await store.put('task-folders', id, { name, parent: p, order });
      ui.go(`f/${id}`);
    },
  });
}

function renameFolderDialog(f) {
  return nameDialog({ title: 'Rename folder', value: f.name, confirm: 'Save', onSave: name => saveFolder(f, { name }) });
}

function moveFolderDialog(f, model) {
  const blocked = model.descendants(f.id);
  const sel = folderSelect(model, f.parent, { none: 'Top level (not inside a folder)', exclude: blocked, name: 'parent' });
  return openModal({
    title: `Move “${f.name}”`,
    body: [
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Put it inside' }), sel),
      h('p', { class: 'muted small', text: 'Its tasks and the folders inside it move along.' }),
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      {
        id: 'move', label: 'Move', kind: 'primary',
        onClick: async close => {
          const p = sel.value || null;
          if (p !== f.parent) {
            const sibs = model.childrenOf(p);
            await saveFolder(f, { parent: p, order: sibs.length ? sibs[sibs.length - 1].order + 10 : 10 });
          }
          close('moved');
        },
      },
    ],
  }).result;
}

async function deleteFolder(f, model, ui) {
  const n = model.tasksIn(f.id).length;
  const subs = model.childrenOf(f.id).length;
  if (n || subs) {
    await messageDialog({
      title: `${f.name} isn't empty`,
      body: h('p', { text: `It has ${[n ? plural(n, 'task') : '', subs ? plural(subs, 'folder') : ''].filter(Boolean).join(' and ')} inside. Move or delete ${n + subs === 1 ? 'it' : 'them'} first.` }),
    });
    return;
  }
  const ok = await confirmDialog({
    title: `Delete the folder “${f.name}”?`,
    body: h('p', { text: "It's empty, so nothing else changes." }),
    confirm: 'Delete folder', danger: true,
  });
  if (!ok) return;
  await store.remove('task-folders', f.id);
  toast('Folder deleted. Push to remove it from GitHub too.');
  if (location.hash === folderHref(f.id)) ui.leaveTo(f.parent ? `f/${f.parent}` : '');
}

/* ---------- The main screen ---------- */

function homeView(el, model, wiki, ui, key) {
  if (key !== 'all' && key !== 'none' && !model.folder(key)) {
    clear(el, topNav(ui, '', { href: '#/tasks', label: 'Tasks & Bugs' }),
      h('div', { class: 'notice' }, h('p', { text: "This folder doesn't exist (anymore)." })));
    return;
  }
  const prefs = ui.prefs;
  const title = folderTitle(model, key);
  document.title = `${title} · Tasks & Bugs · ${APP_TITLE}`;

  /* Quick add */
  const typeBtn = type => h('button', {
    type: 'button', class: 'seg-btn', 'aria-pressed': String(prefs.quickType === type),
    onclick: () => { prefs.quickType = type; ui.savePrefs(); drawAdd(); },
  }, type === 'bug' ? icon('bug', { size: 14 }) : icon('tasks', { size: 14 }), TYPES[type]);
  const addInput = h('input', {
    class: 'input tk-add-input', type: 'text', autocomplete: 'off', enterkeyhint: 'done', maxLength: 200,
    'aria-label': 'New task title', dataset: { focusKey: 'task-add' },
  });
  const typeHost = h('div', { class: 'seg', role: 'group', 'aria-label': 'Kind of the new item' });
  const drawAdd = () => {
    clear(typeHost, typeBtn('task'), typeBtn('bug'));
    addInput.placeholder = prefs.quickType === 'bug' ? 'Add a bug, then press Enter' : 'Add a task, then press Enter';
  };
  drawAdd();
  async function add() {
    const title = addInput.value.trim();
    if (!title) { addInput.focus(); return; }
    addInput.value = '';
    try {
      await createTask({ title, type: prefs.quickType, folder: key === 'all' || key === 'none' ? null : key });
    } catch (err) { errorDialog(err, "The task couldn't be saved"); }
  }
  addInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  /* Filters */
  const chip = (label, pressed, onclick, cls = '') => h('button', {
    type: 'button', class: `fchip ${cls}`.trim(), 'aria-pressed': String(pressed), onclick,
  }, label);
  const search = h('input', {
    type: 'search', class: 'input tk-search', placeholder: 'Search', 'aria-label': 'Search tasks', value: ui.query || '',
    autocomplete: 'off', enterkeyhint: 'search', dataset: { focusKey: 'task-search' },
  });
  search.addEventListener('input', () => { ui.query = search.value; drawContent(); });
  const setType = type => { prefs.type = type; ui.savePrefs(); drawFilters(); drawContent(); };
  const togglePri = p => {
    prefs.priorities = prefs.priorities.includes(p) ? prefs.priorities.filter(x => x !== p) : [...prefs.priorities, p];
    ui.savePrefs(); drawFilters(); drawContent();
  };
  const filtersHost = h('div', { class: 'tk-filters' });
  const drawFilters = () => clear(filtersHost,
    h('div', { class: 'fchips', role: 'group', 'aria-label': 'Show' },
      chip('All', prefs.type === 'all', () => setType('all')),
      chip('Tasks', prefs.type === 'task', () => setType('task')),
      chip('Bugs', prefs.type === 'bug', () => setType('bug'))),
    h('div', { class: 'fchips', role: 'group', 'aria-label': 'Priority' },
      Object.entries(PRIORITIES).map(([p, label]) => chip(label, prefs.priorities.includes(p), () => togglePri(p), `fchip-pri fchip-${p}`))),
    search);
  drawFilters();

  /* View switch */
  const viewBtn = (v, label, ic) => h('button', {
    type: 'button', class: 'seg-btn', 'aria-pressed': String(prefs.view === v),
    onclick: () => { prefs.view = v; ui.savePrefs(); homeView(el, model, wiki, ui, key); },
  }, icon(ic, { size: 14 }), label);

  /* The tasks */
  const content = h('div', { class: 'tk-content' });
  const all = model.tasksIn(key);
  function drawContent() {
    const shown = filterTasks(all, model, wiki, { type: prefs.type, priorities: prefs.priorities, query: ui.query || '' });
    const filtered = shown.length !== all.length;
    if (!all.length) {
      clear(content, h('p', { class: 'muted tk-empty', text: key === 'all' ? 'No tasks yet. Type one above and press Enter.' : 'Nothing here yet. Type a task above and press Enter.' }));
      return;
    }
    if (!shown.length) {
      clear(content, h('p', { class: 'muted tk-empty', text: 'No tasks match the filters.' }));
      return;
    }
    clear(content,
      filtered ? h('p', { class: 'muted small tk-count', text: `Showing ${shown.length} of ${all.length}.` }) : null,
      prefs.view === 'board' ? board(shown, model, wiki, ui, key) : list(shown, model, wiki, ui, key));
  }
  drawContent();

  const open = model.openCount(key);
  clear(el, h('div', { class: 'tk-layout' },
    folderPanel(model, ui, key),
    h('div', { class: 'tk-main' },
      key !== 'all' && key !== 'none'
        ? topNav(ui, model.folder(key).parent ? `f/${model.folder(key).parent}` : '', { href: '#/tasks', label: 'Tasks & Bugs' },
          ...model.path(key).slice(0, -1).map(f => ({ href: folderHref(f.id), label: f.name })), { label: title })
        : null,
      h('div', { class: 'tab-head tk-head' }, h('h1', { text: title }), h('span', { class: 'muted', text: `${open} open` }),
        h('div', { class: 'seg head-action', role: 'group', 'aria-label': 'View' }, viewBtn('list', 'List', 'tasks'), viewBtn('board', 'Board', 'block'))),
      h('div', { class: 'tk-add' }, typeHost, addInput,
        h('button', { type: 'button', class: 'btn btn-primary tk-add-btn', onclick: add, 'aria-label': 'Add' }, icon('plus', { size: 18 }), h('span', { class: 'tk-add-label', text: 'Add' }))),
      filtersHost,
      content)));
}

function list(tasks, model, wiki, ui, key) {
  const doing = tasks.filter(t => t.data.status === 'doing').sort(byPriority);
  const todo = tasks.filter(t => t.data.status === 'todo').sort(byPriority);
  const done = tasks.filter(t => t.data.status === 'done').sort(byDone);
  const ul = items => h('ul', { class: 'tk-list' }, items.map(t => taskItem(t, model, wiki, ui, key)));
  const doneBox = h('details', { class: 'tk-donebox', open: !!ui.doneOpen }, h('summary', { text: `Done (${done.length})` }), ul(done));
  doneBox.addEventListener('toggle', () => { ui.doneOpen = doneBox.open; });
  return [
    doing.length ? h('section', { class: 'tk-section' }, h('h2', { text: `In progress (${doing.length})` }), ul(doing)) : null,
    h('section', { class: 'tk-section' }, h('h2', { text: `To do (${todo.length})` }),
      todo.length ? ul(todo) : h('p', { class: 'muted small', text: 'Nothing to do here.' })),
    done.length ? doneBox : null,
  ];
}

/* ---------- Board ---------- */

function board(tasks, model, wiki, ui, key) {
  const cols = Object.entries(STATUSES).map(([status, label]) => {
    const items = tasks.filter(t => t.data.status === status).sort(status === 'done' ? byDone : byPriority);
    return h('section', { class: `tb-col tb-${status}`, dataset: { status }, 'aria-label': label },
      h('h2', { class: 'tb-head' }, label, h('span', { class: 'tb-count', text: String(items.length) })),
      h('div', { class: 'tb-cards' }, items.length
        ? items.map(t => card(t, model, wiki, ui, key))
        : h('p', { class: 'muted small tb-empty', text: status === 'doing' ? 'Drag a card here when you start on it.' : 'Nothing here.' })));
  });
  return h('div', { class: 'tb-board' }, cols);
}

function card(t, model, wiki, ui, key) {
  const handle = h('button', { type: 'button', class: 'tb-handle', 'aria-label': `Move ${t.data.title || 'task'}`, title: 'Drag to another column. Tap for more' }, '⋮⋮');
  const more = h('button', { type: 'button', class: 'row-menu', 'aria-label': `More for ${t.data.title || 'task'}`, title: 'Status, folder, delete', onclick: () => taskMenu(t, more, model, ui) }, '⋯');
  const where = folderLine(t, model, key);
  const links = linkNames(t, wiki);
  const el = h('article', { class: `tb-card tk-pri-${t.data.priority}`, dataset: { task: t.id } },
    handle,
    h('a', { class: 'tb-body', href: `#/tasks/t/${t.id}` },
      h('span', { class: 'tk-title', text: t.data.title || '(no title)' }),
      h('span', { class: 'tb-tags' }, tags(t, { showStatus: false })),
      where ? h('span', { class: 'tk-where small' }, icon('tasks', { size: 12 }), where) : null,
      links ? h('span', { class: 'tk-links small' }, icon('book', { size: 12 }), links) : null),
    more);
  cardDrag(el, handle, t, model, ui);
  return el;
}

/**
 * Drag a card by its ⋮⋮ handle to another column (mouse or finger). A copy follows the pointer;
 * the column under it lights up. A tap without moving opens the card's menu instead.
 */
function cardDrag(el, handle, t, model, ui) {
  let dragged = false;
  handle.addEventListener('click', () => { if (dragged) { dragged = false; return; } taskMenu(t, handle, model, ui); });
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const boardEl = el.closest('.tb-board');
    const startX = e.clientX, startY = e.clientY;
    let ghost = null, over = null, lastX = startX, lastY = startY, raf = 0, dx = 0, dy = 0;
    handle.setPointerCapture?.(e.pointerId);

    const colAt = (x, y) => document.elementFromPoint(x, y)?.closest('.tb-col') || null;
    const place = () => {
      ghost.style.transform = `translate(${lastX - dx}px, ${lastY - dy}px) rotate(1.5deg)`;
      const col = colAt(lastX, lastY);
      if (col !== over) {
        over?.classList.remove('is-over');
        over = col;
        if (over && over.dataset.status !== t.data.status) over.classList.add('is-over');
      }
    };
    // Scroll the page near the top/bottom of the screen, and the board near its sides (phone).
    const autoScroll = () => {
      const edge = 60;
      let moved = false;
      const vy = lastY < edge ? -(edge - lastY) / 4 : lastY > innerHeight - edge ? (lastY - (innerHeight - edge)) / 4 : 0;
      if (vy) { window.scrollBy(0, vy); moved = true; }
      if (boardEl && boardEl.scrollWidth > boardEl.clientWidth) {
        const r = boardEl.getBoundingClientRect();
        const vx = lastX < r.left + edge ? -(r.left + edge - lastX) / 3 : lastX > r.right - edge ? (lastX - (r.right - edge)) / 3 : 0;
        if (vx) { boardEl.scrollLeft += vx; moved = true; }
      }
      if (moved) place();
      raf = requestAnimationFrame(autoScroll);
    };
    const move = ev => {
      lastX = ev.clientX; lastY = ev.clientY;
      if (!ghost) {
        if (Math.hypot(lastX - startX, lastY - startY) < 6) return;
        const r = el.getBoundingClientRect();
        dx = startX - r.left; dy = startY - r.top;
        ghost = el.cloneNode(true);
        ghost.classList.add('tb-ghost');
        ghost.style.width = `${r.width}px`;
        document.body.append(ghost);
        el.classList.add('dragging');
        document.body.classList.add('is-dragging');
        raf = requestAnimationFrame(autoScroll);
      }
      ev.preventDefault();
      place();
    };
    const end = async ev => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      cancelAnimationFrame(raf);
      if (!ghost) return;
      dragged = true;
      setTimeout(() => { dragged = false; }, 0);
      ghost.remove();
      el.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      over?.classList.remove('is-over');
      const status = over?.dataset.status;
      if (ev.type !== 'pointercancel' && status && status !== t.data.status) {
        try { await updateTask(t.id, { status }); } catch (err) { errorDialog(err, "The task couldn't be moved"); }
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}
