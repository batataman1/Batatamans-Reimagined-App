// Tasks & Bugs, worked out from what's saved on this device (part 2c).
//
// Collection "tasks", id "t-<random>":
// {
//   title, type: "task" | "bug", priority: "critical" | "high" | "normal" | "low",
//   status: "todo" | "doing" | "done",
//   folder: a folder id, or null for "No folder",
//   links: [{ collection: "wiki" | "ideas", id }],     wiki pages (ideas from part 2c Ideas)
//   body: [blocks],                                     the description, same blocks as wiki pages
//   created: ISO time, doneAt: ISO time (only while done)   used for sorting, never shown
// }
// Collection "task-folders", id "f-<random>": { name, parent: folder id or null, order }
// Folders can hold folders, as deep as you like. Opening a folder shows its sub-folders' tasks too.

import { store } from '../core/store.js';
import { isPlainObject, uid } from '../core/util.js';
import { linkTargets, plainText } from '../wiki/text.js';

export const TYPES = { task: 'Task', bug: 'Bug' };
export const PRIORITIES = { critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' };
export const STATUSES = { todo: 'To do', doing: 'In progress', done: 'Done' };
const RANK = { critical: 0, high: 1, normal: 2, low: 3 };

export const newTaskId = () => uid('t');
export const newFolderId = () => uid('f');

let cache = null;
store.on(() => { cache = null; });

/** Everything the Tasks tab needs. Cached until something changes on this device. */
export function getTasks() {
  if (!cache) cache = build();
  return cache;
}

/** A task's saved data with every key in a usable shape. */
export function normalizeTask(d) {
  d = isPlainObject(d) ? d : {};
  return {
    ...d,
    title: String(d.title || '').trim(),
    type: TYPES[d.type] ? d.type : 'task',
    priority: PRIORITIES[d.priority] ? d.priority : 'normal',
    status: STATUSES[d.status] ? d.status : 'todo',
    folder: typeof d.folder === 'string' && d.folder ? d.folder : null,
    links: (Array.isArray(d.links) ? d.links : []).filter(l => l && l.collection && l.id).map(l => ({ collection: String(l.collection), id: String(l.id) })),
    body: Array.isArray(d.body) ? d.body : [],
  };
}

export const byPriority = (a, b) =>
  RANK[a.data.priority] - RANK[b.data.priority]
  || String(a.data.created || a.updatedAt || '').localeCompare(String(b.data.created || b.updatedAt || ''))
  || a.data.title.localeCompare(b.data.title);
export const byDone = (a, b) => String(b.data.doneAt || b.updatedAt || '').localeCompare(String(a.data.doneAt || a.updatedAt || ''));

async function build() {
  const [rows, folderRows] = await Promise.all([store.list('tasks'), store.list('task-folders')]);

  const folders = new Map();
  for (const r of folderRows) {
    const d = isPlainObject(r.data) ? r.data : {};
    folders.set(r.id, {
      id: r.id, name: String(d.name || '').trim() || 'Folder',
      parent: typeof d.parent === 'string' && d.parent ? d.parent : null,
      order: typeof d.order === 'number' && Number.isFinite(d.order) ? d.order : 1000,
      dirty: !!r.dirty,
    });
  }
  // A folder whose parent is missing, or that would end up inside itself, goes to the top.
  for (const f of folders.values()) {
    if (f.parent && !folders.has(f.parent)) { f.parent = null; continue; }
    const seen = new Set([f.id]);
    for (let p = f.parent; p; p = folders.get(p)?.parent) {
      if (seen.has(p)) { f.parent = null; break; }
      seen.add(p);
    }
  }
  const byOrder = (a, b) => a.order - b.order || a.name.localeCompare(b.name);
  const childrenOf = parent => [...folders.values()].filter(f => f.parent === parent).sort(byOrder);

  const tasks = new Map();
  for (const r of rows) tasks.set(r.id, { id: r.id, data: normalizeTask(r.data), updatedAt: r.updatedAt, dirty: !!r.dirty });

  const folderOf = t => (t.data.folder && folders.has(t.data.folder) ? t.data.folder : null);
  const descendants = id => {
    const out = new Set([id]);
    const walk = p => { for (const c of childrenOf(p)) { out.add(c.id); walk(c.id); } };
    walk(id);
    return out;
  };

  /** "all", "none" or a folder id -> the tasks shown there. */
  function tasksIn(key) {
    const all = [...tasks.values()];
    if (key === 'all' || !key) return all;
    if (key === 'none') return all.filter(t => !folderOf(t));
    if (!folders.has(key)) return [];
    const ids = descendants(key);
    return all.filter(t => ids.has(folderOf(t)));
  }

  /** Folders in tree order with their depth: [{ folder, depth }]. */
  const tree = () => {
    const out = [];
    const walk = (p, depth) => { for (const f of childrenOf(p)) { out.push({ folder: f, depth }); walk(f.id, depth + 1); } };
    walk(null, 0);
    return out;
  };

  /** Folder names from the top down to this folder. */
  const path = id => {
    const out = [];
    for (let f = folders.get(id); f; f = f.parent ? folders.get(f.parent) : null) out.unshift(f);
    return out;
  };

  /** Tasks that link a wiki page, in their Links or with [[...]] in the description. */
  function linkedTo(collection, id) {
    return [...tasks.values()].filter(t =>
      t.data.links.some(l => l.collection === collection && l.id === id)
      || (collection === 'wiki' && t.data.body.some(b => linkTargets(b?.text).includes(id) || linkTargets(b?.caption).includes(id))));
  }

  /** The words a search looks through. */
  const textOf = (t, wiki) => [t.data.title, ...t.data.body.map(b => plainText(b?.text || b?.caption || '', wiki))].join(' \n ');

  return {
    tasks, folders,
    get: id => tasks.get(id) || null,
    folder: id => folders.get(id) || null,
    childrenOf, descendants, tasksIn, tree, path, linkedTo, textOf,
    folderOf,
    openCount: key => tasksIn(key).filter(t => t.data.status !== 'done').length,
  };
}

const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Keep the tasks that match the filters: { type: 'all'|'task'|'bug', priorities: [...], query }. */
export function filterTasks(list, model, wiki, { type = 'all', priorities = [], query = '' } = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return list.filter(t => {
    if (type !== 'all' && t.data.type !== type) return false;
    if (priorities.length && !priorities.includes(t.data.priority)) return false;
    if (words.length) {
      const text = fold(model.textOf(t, wiki));
      if (!words.every(w => text.includes(w))) return false;
    }
    return true;
  });
}

/** Save a change to a task (status changes keep doneAt right). */
export async function updateTask(id, change, opts) {
  const row = await store.get('tasks', id);
  if (!row) return;
  const next = { ...row.data, ...change };
  if (change.status) {
    if (change.status === 'done' && row.data.status !== 'done') next.doneAt = new Date().toISOString();
    if (change.status !== 'done') delete next.doneAt;
  }
  await store.put('tasks', id, next, opts);
}

/** Make a new task. Returns its id. */
export async function createTask({ title, type = 'task', priority = 'normal', status = 'todo', folder = null, links = [] }) {
  const id = newTaskId();
  await store.put('tasks', id, {
    title: String(title).trim(), type, priority, status, folder: folder || null, links, created: new Date().toISOString(),
  });
  return id;
}
