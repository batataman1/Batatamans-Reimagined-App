// Everything the app saves on this device goes through here.
//
// A "record" is one JSON item (a wiki page, a task, an idea...). It lives in a collection
// and is pushed to the data repo as   data/<collection>/<id>.json
// A "file" is an image or drawing layer. It is pushed as   files/<path>
//
// Every change marks the item "dirty" (not pushed yet). Deleting an item that is already on
// GitHub leaves a "tombstone" so the next Push removes it from the repo too.

import { idb, tx, reqP, openDB } from './db.js';
import { mimeFromPath, base64ToUtf8, base64ToBlob } from './util.js';

const listeners = new Set();

export const recordPath = (collection, id) => `data/${collection}/${id}.json`;
export const filePath = path => `files/${path}`;
export const isManagedPath = p => p.startsWith('data/') || p.startsWith('files/');

/** Turn a repo path back into what it means on this device. */
export function parseRepoPath(p) {
  const rec = /^data\/([a-z0-9_-]+)\/([a-z0-9][a-z0-9_-]*)\.json$/.exec(p);
  if (rec) return { kind: 'record', collection: rec[1], id: rec[2] };
  if (p.startsWith('files/') && p.length > 6) return { kind: 'file', path: p.slice(6) };
  return null;
}

/** What a record looks like as a file in the repo. */
export function serializeRecord(row) {
  return JSON.stringify({ id: row.id, collection: row.collection, updated: row.updatedAt, data: row.data }, null, 2) + '\n';
}

const now = () => new Date().toISOString();

export const store = {
  open: () => openDB(),

  /** Subscribe to changes. Returns an unsubscribe function. */
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(detail) {
    for (const fn of listeners) { try { fn(detail); } catch (e) { console.error(e); } }
  },

  /* ---------- Records ---------- */

  /** All live items in a collection: [{ id, data, updatedAt, dirty }] */
  async list(collection) {
    const rows = await idb.getAllByIndex('records', 'collection', collection);
    return rows.filter(r => !r.deleted);
  },

  async get(collection, id) {
    const row = await idb.get('records', `${collection}/${id}`);
    return row && !row.deleted ? row : null;
  },

  async put(collection, id, data, { silent = false } = {}) {
    const row = { key: `${collection}/${id}`, collection, id, data, updatedAt: now(), dirty: true, deleted: false };
    await idb.put('records', row);
    if (!silent) this.emit({ type: 'record', collection, id });
    return row;
  },

  async remove(collection, id) {
    const key = `${collection}/${id}`;
    const row = await idb.get('records', key);
    if (!row) return;
    const onGitHub = await idb.get('base', recordPath(collection, id));
    if (onGitHub) await idb.put('records', { ...row, deleted: true, dirty: true, updatedAt: now() });
    else await idb.delete('records', key);
    this.emit({ type: 'record', collection, id, removed: true });
  },

  /* ---------- Files (images, drawing layers) ---------- */

  async getFile(path) {
    const row = await idb.get('files', path);
    return row && !row.deleted ? row : null;
  },

  async putFile(path, blob) {
    const row = { path, blob, mime: blob.type || mimeFromPath(path), updatedAt: now(), dirty: true, deleted: false };
    await idb.put('files', row);
    this.emit({ type: 'file', path });
    return row;
  },

  async removeFile(path) {
    const row = await idb.get('files', path);
    if (!row) return;
    const onGitHub = await idb.get('base', filePath(path));
    if (onGitHub) await idb.put('files', { ...row, blob: null, deleted: true, dirty: true, updatedAt: now() });
    else await idb.delete('files', path);
    this.emit({ type: 'file', path, removed: true });
  },

  /* ---------- Settings ---------- */

  async getMeta(k, fallback = null) {
    const row = await idb.get('meta', k);
    return row ? row.v : fallback;
  },
  async setMeta(k, v) { await idb.put('meta', { k, v }); },
  async deleteMeta(k) { await idb.delete('meta', k); },

  /* ---------- Sync internals ---------- */

  /** Everything changed on this device since the last Push or Pull. */
  async pending() {
    const [records, files] = await Promise.all([idb.getAll('records'), idb.getAll('files')]);
    return [
      ...records.filter(r => r.dirty).map(r => ({
        kind: 'record', repoPath: recordPath(r.collection, r.id), row: r,
        deleted: r.deleted, updatedAt: r.updatedAt, label: labelFor(r),
      })),
      ...files.filter(f => f.dirty).map(f => ({
        kind: 'file', repoPath: filePath(f.path), row: f,
        deleted: f.deleted, updatedAt: f.updatedAt, label: f.path,
      })),
    ];
  },

  async pendingCount() {
    return (await this.pending()).length;
  },

  /** Map of repo path -> blob sha, as of the last sync. */
  async getBase() {
    const rows = await idb.getAll('base');
    return new Map(rows.map(r => [r.path, r.sha]));
  },

  async setBase(map) {
    await tx(['base'], 'readwrite', async t => {
      const s = t.objectStore('base');
      await reqP(s.clear());
      for (const [path, sha] of map) s.put({ path, sha });
    });
  },

  /** After a successful Push: mark items clean unless they were edited again during the Push. */
  async markPushed(items) {
    await tx(['records', 'files'], 'readwrite', async t => {
      for (const item of items) {
        const storeName = item.kind === 'record' ? 'records' : 'files';
        const key = item.kind === 'record' ? item.row.key : item.row.path;
        const s = t.objectStore(storeName);
        const current = await reqP(s.get(key));
        if (!current || current.updatedAt !== item.updatedAt) continue;
        if (current.deleted) s.delete(key);
        else s.put({ ...current, dirty: false });
      }
    });
  },

  /** Write something downloaded from the repo (base64 content from GitHub). */
  async applyRemote(repoPath, base64) {
    const target = parseRepoPath(repoPath);
    if (!target) return false;
    if (target.kind === 'record') {
      const parsed = JSON.parse(base64ToUtf8(base64));
      await idb.put('records', {
        key: `${target.collection}/${target.id}`, collection: target.collection, id: target.id,
        data: parsed.data ?? {}, updatedAt: parsed.updated || now(), dirty: false, deleted: false,
      });
    } else {
      const mime = mimeFromPath(target.path);
      await idb.put('files', {
        path: target.path, blob: base64ToBlob(base64, mime), mime, updatedAt: now(), dirty: false, deleted: false,
      });
    }
    return true;
  },

  /** Remove something locally because it was removed from the repo. */
  async deleteLocal(repoPath) {
    const target = parseRepoPath(repoPath);
    if (!target) return;
    if (target.kind === 'record') await idb.delete('records', `${target.collection}/${target.id}`);
    else await idb.delete('files', target.path);
  },

  async counts() {
    const [records, files] = await Promise.all([idb.getAll('records'), idb.getAll('files')]);
    const byCollection = {};
    for (const r of records) if (!r.deleted) byCollection[r.collection] = (byCollection[r.collection] || 0) + 1;
    return { byCollection, files: files.filter(f => !f.deleted).length };
  },
};

function labelFor(row) {
  const d = row.data || {};
  return d.name || d.title || row.id;
}
