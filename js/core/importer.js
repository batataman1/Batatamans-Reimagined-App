// "Import from Claude": Claude writes an update block in chat, the user pastes it here.
//
// Format (version 1):
// {
//   "format": "batataman-import",
//   "version": 1,
//   "summary": "Add the Hippo page",
//   "changes": [
//     { "action": "upsert", "collection": "wiki", "id": "hippo", "data": { ... } },
//     { "action": "delete", "collection": "tasks", "id": "t-abc123" }
//   ]
// }
//
// upsert: creates the item, or merges into the existing one. Objects merge key by key, so an
//         update only touches the fields it names. Arrays and text are replaced.
// delete: always unticked in the preview; the user has to tick it and confirm.

import { store } from './store.js';
import { isPlainObject, isValidId, slugify, deepMerge, diffObjects } from './util.js';

export const IMPORT_FORMAT = 'batataman-import';

export const COLLECTIONS = {
  wiki: 'Wiki page',
  templates: 'Template',
  tasks: 'Task',
  ideas: 'Idea',
  sections: 'Idea section',
};

export function parseImportText(text) {
  let t = String(text || '').trim();
  if (!t) throw new Error('Paste the update from Claude first.');
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) t = fenced[1];
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error("This doesn't look like an update from Claude. Copy the whole block, from the first { to the last }.");
  }
  let obj;
  try {
    obj = JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    throw new Error(`Part of the update is missing or changed (${e.message}). Copy the whole block again.`);
  }
  if (obj.format !== IMPORT_FORMAT) {
    throw new Error(`This isn't an app update. Updates from Claude start with "format": "${IMPORT_FORMAT}".`);
  }
  if (obj.version !== 1) {
    throw new Error(`This update uses version ${obj.version}, which this version of the app can't read. Update the app first.`);
  }
  if (!Array.isArray(obj.changes) || obj.changes.length === 0) {
    throw new Error('The update has no changes in it.');
  }
  return obj;
}

/**
 * Work out what each change would do, without saving anything.
 * Returns [{ status, collection, id, title, diffs, next, problem, checked }]
 * status: create | update | same | delete | invalid
 */
export async function previewImport(update) {
  const seen = new Set();
  const items = [];
  for (const ch of update.changes) {
    const item = {
      status: 'invalid', collection: ch?.collection, id: ch?.id, title: '', diffs: [],
      next: null, problem: null, checked: false,
    };
    items.push(item);

    if (!isPlainObject(ch)) { item.problem = 'This change is not readable.'; continue; }
    if (!COLLECTIONS[ch.collection]) { item.problem = `Unknown part of the app: "${ch.collection}".`; continue; }
    let id = ch.id;
    if (!id && isPlainObject(ch.data) && ch.data.name) id = slugify(ch.data.name);
    item.id = id;
    item.title = (isPlainObject(ch.data) && (ch.data.name || ch.data.title)) || id || '(no id)';
    if (!isValidId(id)) { item.problem = `"${id ?? ''}" isn't a valid id (use lowercase letters, numbers and dashes).`; continue; }
    const key = `${ch.collection}/${id}`;
    if (seen.has(key)) { item.problem = 'This item appears twice in the same update. Only the first one is used.'; continue; }
    seen.add(key);

    const existing = await store.get(ch.collection, id);
    if (existing) item.title = existing.data?.name || existing.data?.title || item.title;

    if (ch.action === 'upsert') {
      if (!isPlainObject(ch.data)) { item.problem = 'This change has no data.'; continue; }
      const next = existing ? deepMerge(existing.data, ch.data) : structuredClone(ch.data);
      item.next = next;
      item.title = next.name || next.title || item.title;
      item.diffs = diffObjects(existing?.data ?? {}, next);
      item.status = !existing ? 'create' : item.diffs.length ? 'update' : 'same';
      item.checked = item.status !== 'same';
    } else if (ch.action === 'delete') {
      if (!existing) { item.problem = 'Already gone from this device.'; continue; }
      item.status = 'delete';
      item.checked = false;
    } else {
      item.problem = `Unknown action "${ch.action}".`;
    }
  }
  return items;
}

/** Save the ticked items. Returns counts. */
export async function applyImport(items) {
  let saved = 0, deleted = 0;
  for (const it of items) {
    if (!it.checked) continue;
    if (it.status === 'create' || it.status === 'update') {
      await store.put(it.collection, it.id, it.next, { silent: true });
      saved++;
    } else if (it.status === 'delete') {
      await store.remove(it.collection, it.id);
      deleted++;
    }
  }
  store.emit({ type: 'import' });
  return { saved, deleted };
}
