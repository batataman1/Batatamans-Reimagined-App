// Things done to tasks from more than one screen: the folder picker, deleting a task,
// and "New task for this page" on wiki pages.

import { h } from '../core/util.js';
import { store } from '../core/store.js';
import { openModal, confirmDialog, toast } from '../ui/dialogs.js';
import { icon } from '../ui/icons.js';
import { filesOfPage, isFileOfPage } from '../wiki/images.js';
import { TYPES, PRIORITIES, DIFFICULTIES, DIFFICULTY_HINTS, getTasks, createTask } from './model.js';

/** A dropdown of the folders, indented like the tree. value '' = no folder. */
export function folderSelect(model, value, { none = 'No folder', exclude = new Set(), name = 'folder' } = {}) {
  const sel = h('select', { class: 'input', name, 'aria-label': 'Folder' },
    h('option', { value: '', text: none }),
    model.tree().filter(({ folder }) => !exclude.has(folder.id)).map(({ folder, depth }) =>
      h('option', { value: folder.id, text: `${' '.repeat(depth)}${folder.name}` })));
  sel.value = value && model.folder(value) && !exclude.has(value) ? value : '';
  return sel;
}

export function confirmDeleteTask(title) {
  return confirmDialog({
    title: `Delete “${title || 'this task'}”?`,
    body: h('p', { text: 'It is removed from this device now, and from GitHub when you push (it stays in the repo\'s history).' }),
    confirm: 'Delete', danger: true,
  });
}

/** Remove a task and the pictures in its description. */
export async function removeTaskAndFiles(id, data) {
  const used = filesOfPage(data);
  for (const f of await store.files()) {
    if (used.has(f.path) || isFileOfPage(f.path, id)) await store.removeFile(f.path);
  }
  await store.remove('tasks', id);
}

/** "New task for this page" on a wiki page: the task links the page. */
export async function newTaskDialog({ pageId, pageName }) {
  const model = await getTasks();
  const title = h('input', { class: 'input', name: 'title', autocomplete: 'off', maxLength: 200, placeholder: `For example: Add a loot table for ${pageName}` });
  const type = h('select', { class: 'input', name: 'type', 'aria-label': 'Task or bug' },
    Object.entries(TYPES).map(([v, label]) => h('option', { value: v, text: label })));
  const priority = h('select', { class: 'input', name: 'priority', 'aria-label': 'Priority' },
    Object.entries(PRIORITIES).map(([v, label]) => h('option', { value: v, text: label })));
  priority.value = 'normal';
  const difficulty = h('select', { class: 'input', name: 'difficulty', 'aria-label': 'Difficulty' },
    h('option', { value: '', text: 'Not set' }),
    Object.entries(DIFFICULTIES).map(([v, label]) => h('option', { value: v, text: `${label} (${DIFFICULTY_HINTS[v]})` })));
  const folder = folderSelect(model, null);
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const field = (label, control) => h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), control);

  async function create(close) {
    const t = title.value.trim();
    if (!t) { error.textContent = 'Give the task a title.'; error.hidden = false; return; }
    await createTask({ title: t, type: type.value, priority: priority.value, difficulty: difficulty.value || null, folder: folder.value || null, links: [{ collection: 'wiki', id: pageId }] });
    close('created');
    toast(`${TYPES[type.value]} added. It's in Tasks & Bugs, linked to ${pageName}.`, { kind: 'ok' });
  }

  const m = openModal({
    title: `New task for ${pageName}`,
    body: h('div', { class: 'connect-form' },
      field('Title', title),
      h('div', { class: 'field-grid' }, field('Task or bug', type), field('Priority', priority)),
      field('Difficulty', difficulty),
      field('Folder', folder),
      h('p', { class: 'muted small' }, icon('book', { size: 12 }), ` Linked to ${pageName}. Open it in Tasks & Bugs to add a description.`),
      error),
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'create', label: 'Add task', kind: 'primary', onClick: create },
    ],
    onOpen: () => title.focus(),
  });
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(m.close); } });
  return m.result;
}
