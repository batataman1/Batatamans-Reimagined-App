// "Review your changes" before a Push: what will be sent, with a way to look at each change,
// edit it, leave it out of this Push, or undo it.
//
// A wiki page and its pictures are one entry, so a page never reaches GitHub without them.
// Unticked entries stay on this device and show up again next time you tap Push.
// Undo puts the item back the way it is on GitHub (a new item is deleted from this device).

import { h, clear, plural, humanizeKey, base64ToUtf8, isPlainObject } from '../core/util.js';
import { store } from '../core/store.js';
import { openModal, confirmDialog, errorDialog, toast } from './dialogs.js';
import { icon } from './icons.js';
import { getWiki } from '../wiki/model.js';
import { plainText, nameFor } from '../wiki/text.js';
import { filesOfPage, isFileOfPage, isPicturePath } from '../wiki/images.js';

const COLLECTION_NAMES = { wiki: 'Wiki page', tasks: 'Task', bugs: 'Bug', ideas: 'Idea', groups: 'Wiki group', templates: 'Wiki template' };
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
    if (item.row.collection === 'wiki') pages.push(e);
  }
  for (const item of pending.filter(p => p.kind === 'file')) {
    const owner = pages.find(e => isFileOfPage(item.row.path, e.main.row.id) || filesOfPage(e.main.row.data).has(item.row.path));
    if (owner) owner.files.push({ item, status: status(item) });
    else entries.push({ key: item.repoPath, main: item, files: [], status: status(item) });
  }
  entries.sort((a, b) => a.main.label.localeCompare(b.main.label));
  return { entries, base };
}

const kindText = e => {
  const what = e.main.kind === 'file' ? 'Picture' : (COLLECTION_NAMES[e.main.row.collection] || humanizeKey(e.main.row.collection));
  return e.files.length ? `${what} + ${plural(e.files.length, 'picture')}` : what;
};

const allItems = e => [e.main, ...e.files.map(f => f.item)];

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

  const m = openModal({
    title: 'Check your changes',
    className: 'modal-wide modal-review',
    body: [
      h('p', { class: 'rv-intro', text: 'Ticked changes go to GitHub. Untick one to keep it on this device for a later Push.' }),
      summary, list,
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
    const isPage = e.main.kind === 'record' && e.main.row.collection === 'wiki';
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

    return h('li', { class: `rv-item rv-${e.status}` },
      h('label', { class: 'rv-check' }, check),
      h('div', { class: 'rv-main' },
        h('div', { class: 'rv-head' },
          h('span', { class: 'rv-name', text: e.main.label }),
          h('span', { class: `tag rv-tag rv-tag-${e.status}`, text: STATUS_TEXT[e.status] }),
          h('span', { class: 'rv-kind muted small', text: kindText(e) })),
        h('div', { class: 'button-row rv-actions' },
          toggle,
          isPage && e.status !== 'deleted' ? h('button', {
            type: 'button', class: 'btn btn-small btn-quiet',
            onclick: () => { m.close('edit'); location.hash = `#/wiki/e/${encodeURIComponent(e.main.row.id)}`; },
          }, icon('edit', { size: 14 }), 'Edit') : null,
          h('button', {
            type: 'button', class: 'btn btn-small btn-quiet rv-undo',
            onclick: () => undo(e),
          }, e.status === 'deleted' ? 'Bring back' : e.status === 'new' ? 'Delete' : 'Undo changes')),
        details));
  }

  async function undo(e) {
    const name = e.main.label;
    const text = {
      new: [`Delete “${name}”?`, "It's new and only on this device, so it will be gone for good.", 'Delete'],
      changed: [`Undo the changes to “${name}”?`, 'It goes back to how it is on GitHub. The changes on this device are lost.', 'Undo changes'],
      deleted: [`Bring back “${name}”?`, 'It comes back the way it is on GitHub.', 'Bring back'],
    }[e.status];
    const ok = await confirmDialog({ title: text[0], body: h('p', { text: text[1] }), confirm: text[2], danger: e.status !== 'deleted' });
    if (!ok) return;
    try {
      // If that page is open in the editor, leave it first so the editor doesn't save it again.
      if (e.main.kind === 'record' && location.hash.startsWith(`#/wiki/e/${encodeURIComponent(e.main.row.id)}`)) {
        location.hash = `#/wiki/p/${encodeURIComponent(e.main.row.id)}`;
        await new Promise(r => setTimeout(r, 400));
      }
      await discard(e, gh, base);
      toast(e.status === 'deleted' ? 'Brought back.' : 'Change undone.', { kind: 'ok' });
    } catch (err) {
      errorDialog(err, "That couldn't be undone");
    }
    await reload();
  }

  draw();
  const result = await m.result;
  if (result === 'edit') return false;   // went to edit something; no message needed
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
    if (e.status === 'deleted') {
      out.push(h('p', { class: 'small', text: 'Removed on this device. Pushing removes it from GitHub too (it stays in the repo\'s history).' }));
    } else {
      let before = {};
      if (e.status === 'changed') {
        const blob = await gh.getBlob(base.get(e.main.repoPath));
        before = JSON.parse(base64ToUtf8(blob.content)).data ?? {};
      }
      const after = e.main.row.data ?? {};
      const lines = e.main.row.collection === 'wiki'
        ? await wikiDiff(before, after)
        : genericDiff(before, after);
      out.push(lines.length
        ? h('dl', { class: 'rv-diff' }, lines)
        : h('p', { class: 'muted small', text: 'Saved again, but nothing in it is different from GitHub.' }));
    }
  }

  if (pics.length) {
    out.push(h('div', { class: 'rv-pics' }, pics.map(({ item, status }) => h('figure', { class: `rv-pic rv-${status}` },
      status === 'deleted' || !item.row.blob
        ? h('span', { class: 'rv-pic-gone', text: 'Removed' })
        : h('img', { src: objectUrl(item.row.blob), alt: '' }),
      h('figcaption', { class: 'small', text: `${STATUS_TEXT[status]} picture` })))));
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

function genericDiff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (!same(a?.[k], b?.[k])) out.push(line(humanizeKey(k), short(a?.[k]), short(b?.[k])));
  }
  return out;
}
