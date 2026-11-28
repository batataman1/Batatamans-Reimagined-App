// "Review your changes" before a Push: what will be sent, with a way to look at each change,
// edit it, leave it out of this Push, or undo it.
//
// A wiki page and its pictures are one entry, so a page never reaches GitHub without them.
// Unticked entries stay on this device and show up again next time you tap Push.
// Undo puts the item back the way it is on GitHub (a new item is deleted from this device);
// "Undo all changes" does that for every entry at once.

import { h, clear, plural, humanizeKey, base64ToUtf8, isPlainObject } from '../core/util.js';
import { store } from '../core/store.js';
import { openModal, confirmDialog, errorDialog, messageDialog, progressDialog, toast } from './dialogs.js';
import { icon } from './icons.js';
import { getWiki } from '../wiki/model.js';
import { plainText, nameFor } from '../wiki/text.js';
import { filesOfPage, isFileOfPage, isPicturePath } from '../wiki/images.js';
import { GROUPS, TEMPLATES } from '../config/wiki.js';
import { builtinOrder } from '../wiki/custom.js';
import { PICKABLE_ICONS } from '../config/icons.js';
import { getTasks, TYPES, PRIORITIES, STATUSES, DIFFICULTIES } from '../tasks/model.js';
import { getIdeas, SIZE_NAMES, LINE_STYLES, normalizeConnections } from '../ideas/model.js';
import { isDrawingFile, normalizePalette } from '../draw/model.js';
import { isStampFile } from '../draw/stamps.js';

const COLLECTION_NAMES = {
  wiki: 'Wiki page', tasks: 'Task', 'task-folders': 'Task folder', ideas: 'Idea', sections: 'Idea section',
  groups: 'Wiki group', templates: 'Wiki template', drawings: 'Drawing', palettes: 'Colour palette', stamps: 'Stamp',
};
// Collections whose items own pictures (images/<id>-…; a drawing owns drawings/<id>.png),
// shown as one entry with them.
const OWNS_PICTURES = new Set(['wiki', 'tasks', 'ideas', 'drawings', 'stamps']);
const ownsFile = (e, path) => isFileOfPage(path, e.main.row.id) || filesOfPage(e.main.row.data).has(path)
  || (e.main.row.collection === 'drawings' && isDrawingFile(path, e.main.row.id))
  || (e.main.row.collection === 'stamps' && isStampFile(path, e.main.row.id));
const STATUS_TEXT = { new: 'New', changed: 'Changed', deleted: 'Deleted' };

/* ---------- Grouping what's pending ---------- */

async function loadEntries() {
  const [pending, base] = await Promise.all([store.pending(), store.getBase()]);
  const status = item => (item.deleted ? 'deleted' : base.has(item.repoPath) ? 'changed' : 'new');
  const entries = [];
  const pages = [];
  for (const item of pending.filter(p => p.kind === 'record')) {
    const e = { key: item.repoPath, main: item, files: [], status: status(item) };
    entries.push(e);
    if (OWNS_PICTURES.has(item.row.collection)) pages.push(e);
  }
  for (const item of pending.filter(p => p.kind === 'file')) {
    const owner = pages.find(e => ownsFile(e, item.row.path));
    if (owner) owner.files.push({ item, status: status(item) });
    else entries.push({ key: item.repoPath, main: item, files: [], status: status(item) });
  }
  entries.sort((a, b) => a.main.label.localeCompare(b.main.label));
  return { entries, base };
}

const kindText = e => {
  if (e.main.row.collection === 'drawings') return e.main.row.data?.kind === 'reference' ? 'Reference picture' : 'Drawing';
  if (e.main.row.collection === 'stamps') return 'Stamp';
  const what = e.main.kind === 'file' ? (e.main.row.path?.startsWith('drawings/') ? 'Drawing picture' : e.main.row.path?.startsWith('stamps/') ? 'Stamp picture' : 'Picture')
    : e.main.row.collection === 'tasks' && e.main.row.data?.type === 'bug' ? 'Bug'
    : (COLLECTION_NAMES[e.main.row.collection] || humanizeKey(e.main.row.collection));
  return e.files.length ? `${what} + ${plural(e.files.length, 'picture')}` : what;
};

const allItems = e => [e.main, ...e.files.map(f => f.item)];

/** Saved changes to a built-in group or template (the app has it even without them). */
const isBuiltin = e => e.main.kind === 'record'
  && ((e.main.row.collection === 'groups' && GROUPS.some(g => g.id === e.main.row.id))
    || (e.main.row.collection === 'templates' && !!TEMPLATES[e.main.row.id]));
/** Its saved changes were removed: it goes back to the built-in. */
const isReset = e => e.status === 'deleted' && isBuiltin(e);
/** First changes to a built-in: shown as Changed (undo = back to the built-in), not New. */
const shownStatus = e => (e.status === 'new' && isBuiltin(e) ? 'changed' : e.status);
const statusText = e => (isReset(e) ? 'Reset to built-in' : STATUS_TEXT[shownStatus(e)]);

/** Where the Edit button goes, or null. */
function editAddress(e) {
  if (e.main.kind !== 'record' || e.status === 'deleted') return null;
  const id = encodeURIComponent(e.main.row.id);
  return { wiki: `#/wiki/e/${id}`, groups: `#/wiki/c/g/${id}`, templates: `#/wiki/c/t/${id}`, tasks: `#/tasks/t/${id}`, ideas: `#/ideas/i/${id}`, drawings: `#/ideas/draw/${id}` }[e.main.row.collection] || null;
}

/**
 * If one of these entries is open in an editor right now, leave the editor first, so it doesn't
 * save it again after it's put back. A changed wiki page goes to its page, the rest to the list.
 */
async function leaveEditorsOf(list) {
  for (const e of list) {
    const open = editAddress({ ...e, status: 'changed' });
    if (!open || !(location.hash === open || location.hash.startsWith(`${open}/`))) continue;
    const c = e.main.row.collection;
    location.hash = c === 'wiki' ? (e.status === 'new' ? '#/wiki' : `#/wiki/p/${encodeURIComponent(e.main.row.id)}`)
      : { tasks: '#/tasks', ideas: '#/ideas', drawings: '#/ideas/d/all' }[c] || '#/wiki/c';
    await new Promise(r => setTimeout(r, 400));
    return;
  }
}

/* ---------- The screen ---------- */

/**
 * Show the review. Resolves with a Set of repo paths to push (page + its pictures),
 * an empty Set if nothing is left, null if cancelled, or false if the user went to edit something.
 */
export async function reviewChanges(gh) {
  let { entries, base } = await loadEntries();
  const chosen = new Set(entries.map(e => e.key));
  const list = h('ul', { class: 'rv-list' });
  const summary = h('p', { class: 'muted small rv-summary' });
  const undoAllBtn = h('button', {
    type: 'button', class: 'btn btn-small btn-danger-outline rv-undo-all',
    onclick: () => undoAll(),
  }, icon('undo', { size: 14 }), 'Undo all changes');

  const m = openModal({
    title: 'Check your changes',
    className: 'modal-wide modal-review',
    body: [
      h('p', { class: 'rv-intro', text: 'Ticked changes go to GitHub. Untick one to keep it on this device for a later Push.' }),
      h('div', { class: 'rv-bar' }, summary, undoAllBtn), list,
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'push', label: 'Push', kind: 'primary', onClick: close => close('push') },
    ],
  });
  const pushBtn = () => m.dialog.querySelector('[data-action="push"]');

  function refreshCount() {
    const n = entries.filter(e => chosen.has(e.key)).length;
    const btn = pushBtn();
    if (btn) {
      btn.textContent = n ? `Push ${plural(n, 'change')}` : 'Push';
      btn.disabled = !n;
    }
    summary.textContent = entries.length
      ? `${plural(entries.length, 'change')} on this device · ${n} ticked`
      : 'Nothing left to push.';
    undoAllBtn.hidden = !entries.length;
  }

  async function reload() {
    ({ entries, base } = await loadEntries());
    for (const k of [...chosen]) if (!entries.some(e => e.key === k)) chosen.delete(k);
    draw();
  }

  function draw() {
    clear(list, entries.map(row));
    refreshCount();
  }

  function row(e) {
    const editTo = editAddress(e);
    const details = h('div', { class: 'rv-details', hidden: true });
    const toggle = h('button', {
      type: 'button', class: 'btn btn-small btn-quiet', 'aria-expanded': 'false',
      onclick: async () => {
        const open = details.hidden;
        details.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? 'Hide changes' : 'See changes';
        if (open && !details.dataset.loaded) {
          details.dataset.loaded = '1';
          clear(details, h('p', { class: 'muted small', text: 'Loading…' }));
          try { clear(details, await describe(e, gh, base)); }
          catch (err) { delete details.dataset.loaded; clear(details, h('p', { class: 'form-error', text: `Couldn't load the changes: ${err.message || err}` })); }
        }
      },
    }, 'See changes');

    const check = h('input', {
      type: 'checkbox', checked: chosen.has(e.key), 'aria-label': `Push ${e.main.label}`,
      onchange: ev => { ev.target.checked ? chosen.add(e.key) : chosen.delete(e.key); refreshCount(); },
    });

    return h('li', { class: `rv-item rv-${shownStatus(e)}` },
      h('label', { class: 'rv-check' }, check),
      h('div', { class: 'rv-main' },
        h('div', { class: 'rv-head' },
          h('span', { class: 'rv-name', text: e.main.label }),
          h('span', { class: `tag rv-tag rv-tag-${shownStatus(e)}`, text: statusText(e) }),
          h('span', { class: 'rv-kind muted small', text: kindText(e) })),
        h('div', { class: 'button-row rv-actions' },
          toggle,
          editTo ? h('button', {
            type: 'button', class: 'btn btn-small btn-quiet',
            onclick: () => { m.close('edit'); location.hash = editTo; },
          }, icon('edit', { size: 14 }), 'Edit') : null,
          h('button', {
            type: 'button', class: 'btn btn-small btn-quiet rv-undo',
            onclick: () => undo(e),
          }, e.status === 'deleted' ? 'Bring back' : shownStatus(e) === 'new' ? 'Delete' : 'Undo changes')),
        details));
  }

  async function undo(e) {
    const name = e.main.label;
    const text = isBuiltin(e) ? {
      new: [`Undo the changes to “${name}”?`, 'It goes back to how it came with the app. The changes on this device are lost.', 'Undo changes'],
      changed: [`Undo the changes to “${name}”?`, 'It goes back to how it is on GitHub. The changes on this device are lost.', 'Undo changes'],
      deleted: [`Undo the reset of “${name}”?`, 'Your changes come back the way they are on GitHub.', 'Bring back'],
    }[e.status] : {
      new: [`Delete “${name}”?`, "It's new and only on this device, so it will be gone for good.", 'Delete'],
      changed: [`Undo the changes to “${name}”?`, 'It goes back to how it is on GitHub. The changes on this device are lost.', 'Undo changes'],
      deleted: [`Bring back “${name}”?`, 'It comes back the way it is on GitHub.', 'Bring back'],
    }[e.status];
    const ok = await confirmDialog({ title: text[0], body: h('p', { text: text[1] }), confirm: text[2], danger: e.status !== 'deleted' });
    if (!ok) return;
    try {
      await leaveEditorsOf([e]);
      await discard(e, gh, base);
      toast(e.status === 'deleted' ? 'Brought back.' : 'Change undone.', { kind: 'ok' });
    } catch (err) {
      errorDialog(err, "That couldn't be undone");
    }
    store.emit({ type: 'discarded' });
    await reload();
  }

  /** Throw away every change waiting on this device (ticked or not): all back to how GitHub has it. */
  async function undoAll() {
    const all = [...entries];
    const n = all.length;
    if (!n) return;
    const count = s => all.filter(e => shownStatus(e) === s).length;
    const nNew = count('new'), nChanged = count('changed'), nDeleted = count('deleted');
    const what = [
      nNew && `${plural(nNew, 'new item')} ${nNew === 1 ? 'is' : 'are'} deleted (${nNew === 1 ? "it's" : "they're"} only on this device)`,
      nChanged && `${plural(nChanged, 'changed item')} ${nChanged === 1 ? 'goes' : 'go'} back to how ${nChanged === 1 ? 'it is' : 'they are'} on GitHub`,
      nDeleted && `${plural(nDeleted, 'deleted item')} ${nDeleted === 1 ? 'comes' : 'come'} back`,
    ].filter(Boolean);
    const all1 = n === 1 ? `the ${plural(n, 'change')}` : `all ${plural(n, 'change')}`;
    const ok = await confirmDialog({
      title: `Undo ${all1}?`,
      body: [
        h('p', { text: `${all1[0].toUpperCase()}${all1.slice(1)} waiting to be pushed on this device will be thrown away, ticked or not. Everything goes back to how it is on GitHub.` }),
        h('ul', { class: 'rv-undo-all-list' }, what.map(t => h('li', { text: t }))),
        h('p', { class: 'muted', text: "This can't be undone." }),
      ],
      confirm: n === 1 ? 'Undo 1 change' : `Undo all ${plural(n, 'change')}`,
      danger: true,
    });
    if (!ok) return;

    await leaveEditorsOf(all);
    const prog = progressDialog('Undoing your changes');
    const failed = [];
    let i = 0;
    for (const e of all) {
      prog.set(`${++i} of ${n}: ${e.main.label}`);
      try { await discard(e, gh, base); }
      catch (err) { failed.push({ e, err }); }
    }
    prog.close();
    store.emit({ type: 'discarded' });
    await reload();

    if (failed.length) {
      const names = failed.map(f => f.e.main.label);
      await messageDialog({
        title: failed.length === n ? "The changes couldn't be undone" : `${plural(failed.length, 'change')} couldn't be undone`,
        body: [
          h('p', { text: `${failed[0].err?.message || failed[0].err}` }),
          h('p', { class: 'muted', text: `Still on this device: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}. Try again when you're online.` }),
        ],
      });
      console.error(failed);
    }
    if (!entries.length) {
      m.close('undone');
      toast(`Undid ${plural(n, 'change')}. This device matches GitHub again.`, { kind: 'ok' });
    } else if (failed.length < n) {
      toast(`Undid ${plural(n - failed.length, 'change')}.`, { kind: 'ok' });
    }
  }

  draw();
  const result = await m.result;
  if (result === 'edit' || result === 'undone') return false;   // went to edit something / threw everything away; no message needed
  if (result !== 'push') return null;
  const paths = new Set();
  for (const e of entries) if (chosen.has(e.key)) for (const it of allItems(e)) paths.add(it.repoPath);
  return paths;
}

/** Put an entry back the way it is on GitHub. */
async function discard(e, gh, base) {
  for (const it of allItems(e)) {
    const sha = base.get(it.repoPath);
    if (sha) {
      const blob = await gh.getBlob(sha);
      await store.applyRemote(it.repoPath, blob.content);
    } else {
      await store.deleteLocal(it.repoPath);
    }
    if (it.kind === 'record') store.emit({ type: 'record', collection: it.row.collection, id: it.row.id });
    else store.emit({ type: 'file', path: it.row.path });
  }
}

/* ---------- What changed ---------- */

async function describe(e, gh, base) {
  const out = [];
  const pics = [];
  if (e.main.kind === 'file') pics.push({ item: e.main, status: e.status });
  pics.push(...e.files);

  if (e.main.kind === 'record') {
    if (isReset(e)) {
      out.push(h('p', { class: 'small', text: 'Your changes were removed on this device, so it\'s back to how it came with the app. Pushing does the same on your other devices.' }));
    } else if (e.status === 'deleted') {
      out.push(h('p', { class: 'small', text: 'Removed on this device. Pushing removes it from GitHub too (it stays in the repo\'s history).' }));
    } else {
      let before = {};
      if (e.status === 'changed') {
        const blob = await gh.getBlob(base.get(e.main.repoPath));
        before = JSON.parse(base64ToUtf8(blob.content)).data ?? {};
      }
      const after = e.main.row.data ?? {};
      const kind = e.main.row.collection;
      const lines = kind === 'wiki' ? await wikiDiff(before, after)
        : kind === 'groups' ? await groupDiff(e.main.row.id, e.status === 'new' ? null : before, after)
        : kind === 'templates' ? await templateDiff(e.main.row.id, e.status === 'new' ? null : before, after)
        : kind === 'tasks' ? await taskDiff(e.status === 'new' ? null : before, after)
        : kind === 'task-folders' ? await folderDiff(e.status === 'new' ? null : before, after)
        : kind === 'ideas' ? await ideaDiff(e.status === 'new' ? null : before, after)
        : kind === 'sections' ? await sectionDiff(e.status === 'new' ? null : before, after)
        : kind === 'drawings' ? await drawingDiff(e.status === 'new' ? null : before, after)
        : kind === 'palettes' ? paletteDiff(e.status === 'new' ? null : before, after, e.main.row.id)
        : kind === 'stamps' ? stampDiff(e.status === 'new' ? null : before, after)
        : genericDiff(before, after);
      out.push(lines.length
        ? h('dl', { class: 'rv-diff' }, lines)
        : h('p', { class: 'muted small', text: ['drawings', 'stamps'].includes(e.main.row.collection) && e.files.length ? 'The picture changed (below).' : 'Saved again, but nothing in it is different from GitHub.' }));
    }
  }

  if (pics.length) {
    out.push(h('div', { class: 'rv-pics' }, pics.map(({ item, status }) => h('figure', { class: `rv-pic rv-${status}` },
      status === 'deleted' || !item.row.blob
        ? h('span', { class: 'rv-pic-gone', text: 'Removed' })
        : h('img', { src: objectUrl(item.row.blob), alt: '' }),
      h('figcaption', { class: 'small', text: `${STATUS_TEXT[status]} picture` })))));
    if (['drawings', 'stamps'].includes(e.main.row.collection) || /^(drawings|stamps)\//.test(e.main.row.path || '')) out[out.length - 1].classList.add('rv-pics-drawing');
  }
  return out;
}

// Pictures shown in the review are freed when the next review opens.
let urls = [];
function objectUrl(blob) {
  if (urls.length > 60) { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; }
  const u = URL.createObjectURL(blob);
  urls.push(u);
  return u;
}

const has = v => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && !v.length);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const cut = (s, max = 160) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** One "label: before → now" line. */
function line(label, before, after, show = v => String(v)) {
  const parts = [];
  if (has(before)) parts.push(h('span', { class: 'rv-old', text: cut(show(before)) }));
  if (has(after)) parts.push(h('span', { class: 'rv-new', text: cut(show(after)) }));
  if (!has(after)) parts.push(h('span', { class: 'muted', text: '(removed)' }));
  return [h('dt', { text: label }), h('dd', parts)];
}

async function wikiDiff(a, b) {
  const wiki = await getWiki();
  const txt = v => plainText(String(v), wiki);
  const out = [];
  const where = d => {
    const g = wiki.groups.find(x => x.id === d.group);
    const s = g?.subgroups.find(x => x.id === d.subgroup);
    return s ? `${g.name} › ${s.name}` : (d.group ? `${d.group} › ${d.subgroup || '?'}` : '');
  };

  if (!same(a.name, b.name)) out.push(line('Name', a.name, b.name));
  if (where(a) !== where(b)) out.push(line('Goes in', where(a), where(b)));
  if (!same(a.status, b.status)) out.push(line('Status', a.status ? 'Planned' : 'In the mod', b.status ? 'Planned' : 'In the mod'));
  if (!same(a.versionAdded, b.versionAdded)) out.push(line('Version added', a.versionAdded, b.versionAdded));
  if (!!a.vanilla !== !!b.vanilla) out.push(line('Vanilla thing', a.vanilla ? 'Yes' : 'No', b.vanilla ? 'Yes' : 'No'));
  if (!same(a.picture, b.picture)) out.push(line('Picture', a.picture && 'old picture', b.picture && (a.picture ? 'new picture' : 'added')));
  if (!same(a.overview, b.overview)) out.push(line('Overview', a.overview, b.overview, txt));

  // Info box fields, with the labels from the page's template.
  const fa = isPlainObject(a.fields) ? a.fields : {};
  const fb = isPlainObject(b.fields) ? b.fields : {};
  const g = wiki.groups.find(x => x.id === b.group);
  const tpl = wiki.templates[g?.subgroups.find(x => x.id === b.subgroup)?.template];
  const label = k => tpl?.fields.find(f => f.key === k)?.label || humanizeKey(k);
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (same(fa[k], fb[k])) continue;
    if (isPicturePath(fa[k]) || isPicturePath(fb[k])) out.push(line(label(k), has(fa[k]) && (isPicturePath(fa[k]) ? 'old picture' : txt(fa[k])), has(fb[k]) && (isPicturePath(fb[k]) ? 'new picture' : txt(fb[k]))));
    else out.push(line(label(k), fa[k], fb[k], txt));
  }

  if (!same(a.variants, b.variants)) {
    const show = vs => (Array.isArray(vs) ? vs.map(v => txt(v.name || '')).filter(Boolean).join(', ') : '');
    out.push(line('Variants', show(a.variants), show(b.variants)));
  }
  if (!same(a.body, b.body)) out.push(bodyDiff(a.body, b.body, txt));
  if (!same(a.notes, b.notes)) out.push(line('Notes', a.notes, b.notes, txt));
  if (!same(a.related, b.related)) {
    const show = r => (Array.isArray(r) ? r.map(id => nameFor(wiki, id)).join(', ') : '');
    out.push(line('Related pages', show(a.related), show(b.related)));
  }
  // Anything else on the page (from an import, or a newer version of the app).
  const known = new Set(['name', 'group', 'subgroup', 'status', 'versionAdded', 'vanilla', 'picture', 'overview', 'fields', 'variants', 'body', 'notes', 'related']);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!known.has(k) && !same(a[k], b[k])) out.push(line(humanizeKey(k), short(a[k]), short(b[k])));
  }
  return out;
}

/** Page text: the blocks that were taken out (−) and put in (+), in order. */
function bodyDiff(a, b, txt) {
  const A = (Array.isArray(a) ? a : []).map(x => JSON.stringify(x));
  const B = (Array.isArray(b) ? b : []).map(x => JSON.stringify(x));
  // Longest common run of unchanged blocks.
  const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) {
    L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { i++; j++; }
    else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) ops.push(['+', JSON.parse(B[j++])]);
    else ops.push(['−', JSON.parse(A[i++])]);
  }
  const MAX = 12;
  const show = blk => {
    const pre = { h1: '# ', h2: '## ', h3: '### ', bullet: '• ', number: '1. ', quote: '> ', todo: blk.checked ? '☑ ' : '☐ ' }[blk.type] || '';
    if (blk.type === 'divider') return '———';
    if (blk.type === 'image') return `[picture]${blk.caption ? ' ' + txt(blk.caption) : ''}`;
    return pre + (txt(blk.text || '') || '(empty line)');
  };
  return [
    h('dt', { text: 'Page text' }),
    h('dd', h('ul', { class: 'rv-body' },
      ops.slice(0, MAX).map(([op, blk]) => h('li', { class: op === '+' ? 'rv-new' : 'rv-old' }, h('span', { class: 'rv-op', text: op }), cut(show(blk)))),
      ops.length > MAX ? h('li', { class: 'muted', text: `and ${ops.length - MAX} more` }) : null)),
  ];
}

const short = v => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/* Groups and templates: compared as they look in the app (saved changes on top of the built-in). */

function groupAsShown(id, d) {
  const b = GROUPS.find(g => g.id === id);
  if (!d && !b) return null;
  d = d || {};
  return {
    name: d.name || b?.name || id,
    icon: d.icon || b?.icon || 'book',
    order: typeof d.order === 'number' ? d.order : (b ? builtinOrder(id) : 1000),
    hidden: !!d.hidden,
    subgroups: (Array.isArray(d.subgroups) ? d.subgroups : b?.subgroups || []).filter(s => s && s.id),
  };
}

async function groupDiff(id, a, b) {
  const wiki = await getWiki();
  const tplName = t => wiki.templates[t]?.name || t;
  const A = groupAsShown(id, a), B = groupAsShown(id, b);
  const out = [];
  if (!A) {
    out.push(line('New group', null, `${B.name}${B.subgroups.length ? ` with ${plural(B.subgroups.length, 'sub-group')}: ${B.subgroups.map(s => s.name).join(', ')}` : ''}`));
    return out;
  }
  if (A.name !== B.name) out.push(line('Name', A.name, B.name));
  const iconName = n => PICKABLE_ICONS.find(x => x[0] === n)?.[1] || n;
  if (A.icon !== B.icon) out.push(line('Icon', iconName(A.icon), iconName(B.icon)));
  if (A.order !== B.order) out.push(line('Place in the list', null, 'moved'));
  if (A.hidden !== B.hidden) out.push(line('On the Wiki start', A.hidden ? 'hidden' : 'shown', B.hidden ? 'hidden' : 'shown'));
  const changes = [];
  const before = new Map(A.subgroups.map(s => [s.id, s]));
  const after = new Map(B.subgroups.map(s => [s.id, s]));
  for (const s of B.subgroups) {
    const o = before.get(s.id);
    if (!o) { changes.push(['+', `${s.name} (${tplName(s.template)} template)`]); continue; }
    if (o.name !== s.name) changes.push(['~', `${o.name} renamed to ${s.name}`]);
    if (o.template !== s.template) changes.push(['~', `${s.name}: ${tplName(o.template)} → ${tplName(s.template)} template`]);
    if (o.icon !== s.icon) changes.push(['~', `${s.name}: new icon`]);
    if (!!o.hidden !== !!s.hidden) changes.push(['~', `${s.name}: ${s.hidden ? 'hidden' : 'shown again'}`]);
  }
  for (const s of A.subgroups) if (!after.has(s.id)) changes.push(['−', s.name]);
  const keptA = A.subgroups.filter(s => after.has(s.id)).map(s => s.id).join();
  const keptB = B.subgroups.filter(s => before.has(s.id)).map(s => s.id).join();
  if (keptA !== keptB) changes.push(['~', 'Order changed']);
  if (changes.length) out.push(listLines('Sub-groups', changes));
  return out;
}

async function templateDiff(id, a, b) {
  const builtin = TEMPLATES[id];
  const A = a ? { name: a.name, fields: Array.isArray(a.fields) ? a.fields : [] } : builtin ? { name: builtin.name, fields: builtin.fields } : null;
  const B = { name: b.name, fields: Array.isArray(b.fields) ? b.fields : [] };
  const kindOf = f => (f.kind === 'image' ? 'picture' : 'text');
  const out = [];
  if (!A) {
    out.push(line('New template', null, `${B.name}: ${B.fields.length ? B.fields.map(f => f.label).join(', ') : 'no fields yet'}`));
    return out;
  }
  if (A.name !== B.name) out.push(line('Name', A.name, B.name));
  const before = new Map(A.fields.map(f => [f.key, f]));
  const after = new Map(B.fields.map(f => [f.key, f]));
  const changes = [];
  for (const f of B.fields) {
    const o = before.get(f.key);
    if (!o) { changes.push(['+', `${f.label} (${kindOf(f)})`]); continue; }
    if (o.label !== f.label) changes.push(['~', `${o.label} renamed to ${f.label}`]);
    if (kindOf(o) !== kindOf(f)) changes.push(['~', `${f.label}: now ${kindOf(f) === 'picture' ? 'a picture' : 'text'}`]);
  }
  for (const f of A.fields) if (!after.has(f.key)) changes.push(['−', f.label]);
  const keptA = A.fields.filter(f => after.has(f.key)).map(f => f.key).join();
  const keptB = B.fields.filter(f => before.has(f.key)).map(f => f.key).join();
  if (keptA !== keptB) changes.push(['~', 'Order changed']);
  if (changes.length) out.push(listLines('Fields', changes));
  return out;
}

/* Tasks and their folders */

/** "Ostrich, Idea: Termites make hollow logs": links as names. */
function linkText(ls, wiki, ideas) {
  return Array.isArray(ls) ? ls.map(l => (l.collection === 'wiki' ? nameFor(wiki, l.id)
    : l.collection === 'ideas' ? `Idea: ${ideas.get(l.id)?.data.title || '(a deleted idea)'}`
    : `${l.collection}/${l.id}`)).join(', ') : '';
}

async function taskDiff(a, b) {
  const [wiki, model, ideas] = await Promise.all([getWiki(), getTasks(), getIdeas()]);
  const txt = v => plainText(String(v), wiki);
  const where = id => (id ? (model.folder(id) ? model.path(id).map(f => f.name).join(' › ') : '(a deleted folder)') : 'No folder');
  const label = (map, v, dflt) => map[v] || map[dflt];
  const showLinks = ls => linkText(ls, wiki, ideas);
  const out = [];
  if (!a) {
    // New: just what it is.
    out.push(line('Title', null, b.title || '(no title)'));
    out.push(line('Kind', null, label(TYPES, b.type, 'task')));
    out.push(line('Priority', null, label(PRIORITIES, b.priority, 'normal')));
    if (b.difficulty) out.push(line('Difficulty', null, DIFFICULTIES[b.difficulty] || b.difficulty));
    out.push(line('Status', null, label(STATUSES, b.status, 'todo')));
    out.push(line('Folder', null, where(b.folder)));
    if (has(b.links)) out.push(line('Links', null, showLinks(b.links)));
    if (has(b.body)) out.push(bodyDiff([], b.body, txt));
    return out;
  }
  if (!same(a.title, b.title)) out.push(line('Title', a.title, b.title));
  if ((a.type || 'task') !== (b.type || 'task')) out.push(line('Kind', label(TYPES, a.type, 'task'), label(TYPES, b.type, 'task')));
  if ((a.priority || 'normal') !== (b.priority || 'normal')) out.push(line('Priority', label(PRIORITIES, a.priority, 'normal'), label(PRIORITIES, b.priority, 'normal')));
  if ((a.difficulty || null) !== (b.difficulty || null)) out.push(line('Difficulty', DIFFICULTIES[a.difficulty] || 'Not set', DIFFICULTIES[b.difficulty] || 'Not set'));
  if ((a.status || 'todo') !== (b.status || 'todo')) out.push(line('Status', label(STATUSES, a.status, 'todo'), label(STATUSES, b.status, 'todo')));
  if ((a.folder || null) !== (b.folder || null)) out.push(line('Folder', where(a.folder), where(b.folder)));
  if (!same(a.links, b.links)) out.push(line('Links', showLinks(a.links), showLinks(b.links)));
  if (!same(a.body, b.body)) out.push(bodyDiff(a.body, b.body, txt));
  return out;
}

async function folderDiff(a, b) {
  const model = await getTasks();
  const where = id => (id ? model.folder(id)?.name || '(a deleted folder)' : 'Top level');
  if (!a) return [line('New folder', null, b.name), line('Inside', null, where(b.parent))];
  const out = [];
  if (!same(a.name, b.name)) out.push(line('Name', a.name, b.name));
  if ((a.parent || null) !== (b.parent || null)) out.push(line('Inside', where(a.parent), where(b.parent)));
  if (a.order !== b.order && (a.parent || null) === (b.parent || null)) out.push(line('Place in the list', null, 'moved'));
  return out;
}

/* Ideas and their sections */

async function ideaDiff(a, b) {
  const [wiki, model] = await Promise.all([getWiki(), getIdeas()]);
  const txt = v => plainText(String(v), wiki);
  const sec = id => (id ? (model.section(id) ? model.path(id).map(s => s.name).join(' › ') : '(a deleted section)') : 'Not sorted');
  const under = id => (id ? (model.get(id)?.data.title || '(a deleted idea)') : 'Straight under the section');
  const showLinks = ls => linkText(ls, wiki, model.ideas);
  const out = [];
  if (!a) {
    out.push(line('Title', null, b.title || '(no title)'));
    out.push(b.parent ? line('Comes under', null, under(b.parent)) : line('Section', null, sec(b.section)));
    if (has(b.links)) out.push(line('Links', null, showLinks(b.links)));
    if (has(b.body)) out.push(bodyDiff([], b.body, txt));
    return out;
  }
  if (!same(a.title, b.title)) out.push(line('Title', a.title, b.title));
  if ((a.section || null) !== (b.section || null) && !b.parent) out.push(line('Section', sec(a.section), sec(b.section)));
  if ((a.parent || null) !== (b.parent || null)) out.push(line('Comes under', under(a.parent), under(b.parent)));
  if (!same(a.links, b.links)) out.push(line('Links', showLinks(a.links), showLinks(b.links)));
  if (!same(a.body, b.body)) out.push(bodyDiff(a.body, b.body, txt));
  out.push(...mapLines(a, b, 'm'));
  if (has(a.connections) || has(b.connections)) {
    const names = ls => {
      const list = normalizeConnections(ls);
      return list.length ? list.map(c => `${model.get(c.id)?.data.title || '(a deleted idea)'}${c.style === 'dashed' ? '' : ` (${LINE_STYLES[c.style].name.toLowerCase()})`}`).join(', ') : 'None';
    };
    if (names(a.connections) !== names(b.connections)) out.push(line('Connections on the mind map', names(a.connections), names(b.connections)));
  }
  if ((a.order ?? null) !== (b.order ?? null) && (a.parent || null) === (b.parent || null) && (a.section || null) === (b.section || null)) {
    out.push(line('Place in the list', null, 'moved'));
  }
  return out;
}

/** Place and bubble size on the mind map (ideas and sections). */
function mapLines(a, b, normal) {
  const out = [];
  const pa = a.map ? `${a.map.x},${a.map.y}` : '', pb = b.map ? `${b.map.x},${b.map.y}` : '';
  if (pa !== pb) out.push(line('Place on the mind map', null, pb ? 'moved' : 'placed automatically'));
  if ((a.size || normal) !== (b.size || normal)) out.push(line('Bubble size', SIZE_NAMES[a.size || normal], SIZE_NAMES[b.size || normal]));
  return out;
}

async function sectionDiff(a, b) {
  const model = await getIdeas();
  const where = id => (id ? model.section(id)?.name || '(a deleted section)' : 'Top level');
  if (!a) return [line('New section', null, b.name), line('Inside', null, where(b.parent))];
  const out = [];
  if (!same(a.name, b.name)) out.push(line('Name', a.name, b.name));
  if ((a.parent || null) !== (b.parent || null)) out.push(line('Inside', where(a.parent), where(b.parent)));
  if (a.order !== b.order && (a.parent || null) === (b.parent || null)) out.push(line('Place in the list', null, 'moved'));
  out.push(...mapLines(a, b, 'l'));
  return out;
}

/* Drawings and palettes */

async function drawingDiff(a, b) {
  const model = await getIdeas();
  const sec = id => (id ? (model.section(id) ? model.path(id).map(s => s.name).join(' › ') : '(a deleted section)') : 'Not sorted');
  const idea = id => (id ? (model.get(id)?.data.title || '(a deleted idea)') : 'None');
  const kind = d => `${d.kind === 'reference' ? 'Reference picture' : d.kind === 'free' ? 'Free drawing' : 'Pixel art'}, ${d.width} × ${d.height}`;
  if (!a) {
    const out = [line('Name', null, b.name), line('Kind', null, kind(b)), line('Section', null, sec(b.section))];
    if (b.idea) out.push(line('Belongs to idea', null, idea(b.idea)));
    return out;
  }
  const out = [];
  if (!same(a.name, b.name)) out.push(line('Name', a.name, b.name));
  if ((a.section || null) !== (b.section || null)) out.push(line('Section', sec(a.section), sec(b.section)));
  if ((a.idea || null) !== (b.idea || null)) out.push(line('Belongs to idea', idea(a.idea), idea(b.idea)));
  return out;
}

function paletteDiff(a, b, id) {
  const A = a ? normalizePalette(id, a) : null, B = normalizePalette(id, b);
  const swatches = list => h('span', { class: 'rv-swatches' }, list.map(c => h('span', { class: 'rv-swatch', style: { '--c': c }, title: c })));
  if (!A) return [line('Name', null, B.name), [h('dt', { text: 'Colours' }), h('dd', B.colors.length ? swatches(B.colors) : h('span', { class: 'muted', text: 'none yet' }))]];
  const out = [];
  if (A.name !== B.name) out.push(line('Name', A.name, B.name));
  const added = B.colors.filter(c => !A.colors.includes(c)), removed = A.colors.filter(c => !B.colors.includes(c));
  if (added.length) out.push([h('dt', { text: 'Colours added' }), h('dd', swatches(added))]);
  if (removed.length) out.push([h('dt', { text: 'Colours taken out' }), h('dd', swatches(removed))]);
  return out;
}

function stampDiff(a, b) {
  if (!a) return [line('Name', null, b.name || 'Stamp'), line('Kind', null, b.kind === 'free' ? 'Free (smooth)' : 'Pixel art')];
  return same(a.name, b.name) ? [] : [line('Name', a.name, b.name)];
}

/** A list of + (added), − (removed) and ~ (changed) lines. */
function listLines(label, changes) {
  return [
    h('dt', { text: label }),
    h('dd', h('ul', { class: 'rv-body' }, changes.map(([op, text]) => h('li', { class: op === '+' ? 'rv-new' : op === '−' ? 'rv-old' : '' },
      h('span', { class: 'rv-op', text: op }), text)))),
  ];
}

function genericDiff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (!same(a?.[k], b?.[k])) out.push(line(humanizeKey(k), short(a?.[k]), short(b?.[k])));
  }
  return out;
}
