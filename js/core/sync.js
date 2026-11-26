// Push and Pull between this device and the private data repo.
//
// How changes are detected:
//   base     = what the repo looked like the last time this device pulled or pushed
//   remote   = what the repo looks like right now
//   pending  = what changed on this device since then
// Anything where remote differs from base was changed by another device ("incoming").
// If an incoming item is also pending here, it changed in both places ("overlap").
//
// Push only runs when there is nothing incoming, so it never overwrites another device's work
// unless the user explicitly chose "Keep mine". GitHub itself also refuses a Push if another
// device pushed in between (the ref update is not forced).

import { store, isManagedPath, serializeRecord, parseRepoPath } from './store.js';
import { createClient, GitHubError } from './github.js';
import { utf8ToBase64, blobToBase64, plural } from './util.js';

/* ---------- Connection settings (stored on this device only) ---------- */

export async function loadConnection() {
  const c = await store.getMeta('connection');
  return c && c.owner && c.repo && c.token ? c : null;
}

export async function saveConnection(c) {
  await store.setMeta('connection', c);
  store.emit({ type: 'connection' });
}

export async function forgetToken() {
  const c = await store.getMeta('connection');
  if (c) await store.setMeta('connection', { ...c, token: '' });
  store.emit({ type: 'connection' });
}

export async function clientFromSettings() {
  const c = await loadConnection();
  return c ? { gh: createClient(c), connection: c } : null;
}

/* ---------- Planning ---------- */

async function remoteState(gh) {
  const head = await gh.getHead();
  const commit = await gh.getCommit(head);
  const tree = await gh.getTree(commit.tree.sha);
  if (tree.truncated) {
    throw new GitHubError('toolarge', 'The data repo has too many files for GitHub to list at once.');
  }
  const files = new Map();
  for (const e of tree.tree) {
    if (e.type === 'blob' && isManagedPath(e.path)) files.set(e.path, e.sha);
  }
  return { head, treeSha: commit.tree.sha, files };
}

function diffRemote(base, files) {
  const out = [];
  for (const [path, sha] of files) {
    if (base.get(path) !== sha) out.push({ path, sha, action: base.has(path) ? 'update' : 'add' });
  }
  for (const path of base.keys()) {
    if (!files.has(path)) out.push({ path, action: 'remove' });
  }
  return out;
}

/** Look at GitHub and this device, and work out what a Push or Pull would do. */
export async function planSync(gh) {
  const [remote, base, pending] = await Promise.all([remoteState(gh), store.getBase(), store.pending()]);
  const pendingByPath = new Map(pending.map(p => [p.repoPath, p]));
  const incoming = diffRemote(base, remote.files).map(c => {
    const mine = pendingByPath.get(c.path);
    // Removed in both places is not a conflict.
    const overlap = !!mine && !(c.action === 'remove' && mine.deleted);
    return { ...c, overlap, label: labelForPath(c.path, mine) };
  });
  return { remote, pending, incoming, overlaps: incoming.filter(c => c.overlap) };
}

function labelForPath(path, pendingItem) {
  if (pendingItem) return pendingItem.label;
  const t = parseRepoPath(path);
  if (!t) return path;
  return t.kind === 'record' ? `${t.collection}/${t.id}` : t.path;
}

/* ---------- Pull ---------- */

/**
 * Download incoming changes.
 * keepMine: for items changed in both places, keep this device's version (it will be pushed next).
 */
export async function applyIncoming(gh, plan, { keepMine = false, onProgress } = {}) {
  const todo = plan.incoming.filter(c => !(c.overlap && keepMine));
  let n = 0;
  for (const c of todo) {
    onProgress?.(`Downloading ${++n} of ${todo.length}`);
    if (c.action === 'remove') {
      await store.deleteLocal(c.path);
    } else {
      const blob = await gh.getBlob(c.sha);
      await store.applyRemote(c.path, blob.content);
    }
  }
  await store.setBase(plan.remote.files);
  await store.setMeta('lastCommit', plan.remote.head);
  await store.setMeta('lastPull', new Date().toISOString());
  store.emit({ type: 'sync' });
  return { downloaded: todo.length, keptMine: keepMine ? plan.overlaps.length : 0 };
}

/* ---------- Push ---------- */

/** Upload everything pending as one commit. Call only when plan.incoming is empty. */
export async function pushPending(gh, plan, { device = 'This device', onProgress } = {}) {
  if (plan.incoming.length) throw new Error('Pull before pushing.');
  const entries = [];
  let n = 0, changed = 0, removed = 0;

  for (const item of plan.pending) {
    onProgress?.(`Uploading ${++n} of ${plan.pending.length}`);
    const inRepo = plan.remote.files.get(item.repoPath);
    if (item.deleted) {
      if (inRepo) { entries.push({ path: item.repoPath, mode: '100644', type: 'blob', sha: null }); removed++; }
      continue;
    }
    const base64 = item.kind === 'record'
      ? utf8ToBase64(serializeRecord(item.row))
      : await blobToBase64(item.row.blob);
    const { sha } = await gh.createBlob(base64);
    if (sha === inRepo) continue; // identical to what's already on GitHub
    entries.push({ path: item.repoPath, mode: '100644', type: 'blob', sha });
    changed++;
  }

  if (entries.length) {
    onProgress?.('Saving to GitHub');
    const parts = [changed && `${plural(changed, 'change')}`, removed && `${removed} removed`].filter(Boolean);
    const tree = await gh.createTree(plan.remote.treeSha, entries);
    const commit = await gh.createCommit(`${device}: ${parts.join(', ')}`, tree.sha, [plan.remote.head]);
    try {
      await gh.updateRef(commit.sha);
    } catch (e) {
      if (e.status === 422 || e.status === 409) {
        throw new GitHubError('race',
          'Another device pushed at the same moment, so nothing was saved. Tap Pull, then Push again.', e.status);
      }
      throw e;
    }
    const newBase = new Map(plan.remote.files);
    for (const e of entries) e.sha === null ? newBase.delete(e.path) : newBase.set(e.path, e.sha);
    await store.setBase(newBase);
    await store.setMeta('lastCommit', commit.sha);
  } else {
    await store.setBase(plan.remote.files);
    await store.setMeta('lastCommit', plan.remote.head);
  }

  await store.markPushed(plan.pending);
  await store.setMeta('lastPush', new Date().toISOString());
  store.emit({ type: 'sync' });
  return { changed, removed };
}
