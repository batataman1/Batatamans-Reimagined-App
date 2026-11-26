// Thin promise wrapper around IndexedDB (the browser's built-in database).
//
// Object stores:
//   records  { key: "collection/id", collection, id, data, updatedAt, dirty, deleted }
//   files    { path: "images/abc.png", blob, mime, updatedAt, dirty, deleted }
//   base     { path: "data/wiki/ostrich.json", sha }   what the repo looked like at the last sync
//   meta     { k, v }                                   settings, connection, sync times

const DB_NAME = 'batatamans-reimagined';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        db.createObjectStore('records', { keyPath: 'key' }).createIndex('collection', 'collection');
      }
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('base')) db.createObjectStore('base', { keyPath: 'path' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The app is open in another tab with an older version. Close the other tabs and reload.'));
  });
  return dbPromise;
}

export function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run fn(transaction) and resolve with its result once the transaction commits. */
export async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Saving was cancelled.'));
    Promise.resolve()
      .then(() => fn(t))
      .then(r => { result = r; }, err => { try { t.abort(); } catch { /* already finished */ } reject(err); });
  });
}

export const idb = {
  get: (store, key) => tx([store], 'readonly', t => reqP(t.objectStore(store).get(key))),
  getAll: store => tx([store], 'readonly', t => reqP(t.objectStore(store).getAll())),
  getAllByIndex: (store, index, value) =>
    tx([store], 'readonly', t => reqP(t.objectStore(store).index(index).getAll(value))),
  put: (store, value) => tx([store], 'readwrite', t => reqP(t.objectStore(store).put(value))),
  delete: (store, key) => tx([store], 'readwrite', t => reqP(t.objectStore(store).delete(key))),
  count: store => tx([store], 'readonly', t => reqP(t.objectStore(store).count())),
};
