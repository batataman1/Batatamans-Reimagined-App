// The wiki's data, worked out from what's saved on this device:
// pages (collection "wiki"), groups and templates (built-in, plus any saved changes),
// where each page belongs, and which pages link to which ("Linked from").
//
// A wiki page record looks like:
// {
//   name, group, subgroup, status ("planned" or missing), vanilla (true for a vanilla thing
//   the mod changes), overview, picture ("images/x.png", a file), versionAdded,
//   related: [page ids], notes,
//   fields: { health: "18 (9 hearts)", ... }       template fields, text with [[links]]
//                                                    (picture fields hold a file path instead)
//   variants: [{ name, note }]                       e.g. the blocks of a wood set
//   body: [{ type, text, ... }]                      the page text, see wiki/text.js
// }
// Links are written [[page-id]] or [[page-id|shown text]]. A page name also works: [[Ostrich Egg]].

import { store } from '../core/store.js';
import { GROUPS, TEMPLATES } from '../config/wiki.js';
import { isPlainObject } from '../core/util.js';
import { linkTargets, targetId, plainText } from './text.js';
import { isPicturePath } from './images.js';

let cache = null;
store.on(() => { cache = null; });

/** Everything the Wiki tab needs. Cached until something changes on this device. */
export function getWiki() {
  if (!cache) cache = build();
  return cache;
}

async function build() {
  const [rows, groupRows, templateRows] = await Promise.all([
    store.list('wiki'), store.list('groups'), store.list('templates'),
  ]);
  const templates = mergeTemplates(templateRows);
  const groups = mergeGroups(groupRows);

  const pages = new Map();
  for (const r of rows) {
    const data = isPlainObject(r.data) ? r.data : {};
    pages.set(r.id, { id: r.id, data, updatedAt: r.updatedAt, dirty: !!r.dirty });
  }

  // Where each page belongs, and the counts shown on the tiles.
  const placed = new Map();       // page id -> { group, sub }
  const bySub = new Map();        // "group/sub" -> [page]
  const unsorted = [];
  for (const p of pages.values()) {
    const group = groups.find(g => g.id === p.data.group);
    const sub = group?.subgroups.find(x => x.id === p.data.subgroup);
    if (!group || !sub) { unsorted.push(p); continue; }
    placed.set(p.id, { group, sub });
    const k = `${group.id}/${sub.id}`;
    if (!bySub.has(k)) bySub.set(k, []);
    bySub.get(k).push(p);
  }
  for (const list of bySub.values()) list.sort(byName);
  unsorted.sort(byName);

  // Links between pages.
  const backlinks = new Map();    // target id -> Set(source ids)
  for (const p of pages.values()) {
    for (const target of linksOf(p.data)) {
      if (target === p.id) continue;
      if (!backlinks.has(target)) backlinks.set(target, new Set());
      backlinks.get(target).add(p.id);
    }
  }

  const wiki = {
    pages, groups, templates, unsorted, backlinks,
    /** Groups shown on the Wiki start (not hidden). */
    visibleGroups: groups.filter(g => !g.hidden),
    get: id => pages.get(id) || null,
    group: id => groups.find(g => g.id === id) || null,
    placeOf: page => placed.get(page.id) || null,
    pagesIn: (groupId, subId) => bySub.get(`${groupId}/${subId}`) || [],
    // A group's count leaves out its hidden sub-groups (their tiles aren't shown either).
    countIn: (groupId, subId) => subId
      ? (bySub.get(`${groupId}/${subId}`) || []).length
      : (groups.find(g => g.id === groupId)?.subgroups || []).filter(s => !s.hidden)
          .reduce((n, s) => n + (bySub.get(`${groupId}/${s.id}`) || []).length, 0),
    /** Every page in a group, hidden sub-groups included. */
    allIn: groupId => (groups.find(g => g.id === groupId)?.subgroups || [])
      .reduce((n, s) => n + (bySub.get(`${groupId}/${s.id}`) || []).length, 0),
    /** The sub-groups that use a template: [{ group, sub, count }]. */
    usersOf: templateId => groups.flatMap(g => g.subgroups.filter(s => s.template === templateId)
      .map(s => ({ group: g, sub: s, count: (bySub.get(`${g.id}/${s.id}`) || []).length }))),
    templateOf(page) {
      const place = placed.get(page.id);
      return place ? templates[place.sub.template] || null : null;
    },
    linkedFrom: id => [...(backlinks.get(id) || [])].map(x => pages.get(x)).filter(Boolean).sort(byName),
    recent: (n = 6) => [...pages.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, n),
    search: q => searchPages(wiki, q),
  };
  return wiki;
}

export function pageName(page) {
  return String(page?.data?.name || '').trim() || humanizeId(page?.id || '');
}

/** "lizard-scale" -> "Lizard Scale", for pages that don't exist yet. */
export function humanizeId(id) {
  return String(id).split(/[-_]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

const byName = (a, b) => pageName(a).localeCompare(pageName(b), undefined, { sensitivity: 'base' });

/** Every page id this page links to, including its Related pages. */
export function linksOf(data) {
  const out = new Set();
  for (const text of textsOf(data)) for (const t of linkTargets(text)) out.add(t);
  for (const r of Array.isArray(data.related) ? data.related : []) {
    const id = targetId(r);
    if (id) out.add(id);
  }
  return out;
}

/** All the text on a page that may hold links or be searched. */
export function textsOf(data) {
  const out = [];
  const add = v => { if (typeof v === 'string' && v) out.push(v); };
  add(data.overview); add(data.notes);
  if (isPlainObject(data.fields)) Object.values(data.fields).forEach(v => { if (!isPicturePath(v)) add(v); });
  for (const v of Array.isArray(data.variants) ? data.variants : []) { add(v?.name); add(v?.note); }
  for (const b of Array.isArray(data.body) ? data.body : []) { add(b?.text); add(b?.caption); }
  return out;
}

/* ---------- Search ---------- */

const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

function searchPages(wiki, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const results = [];
  for (const p of wiki.pages.values()) {
    const name = fold(pageName(p));
    const place = wiki.placeOf(p);
    const where = fold(place ? `${place.group.name} ${place.sub.name}` : '');
    const text = fold(textsOf(p.data).map(t => plainText(t, wiki)).join(' \n '));
    let score = 0;
    let all = true;
    for (const w of words) {
      if (name.startsWith(w)) score += 10;
      else if (name.split(/\s+/).some(x => x.startsWith(w))) score += 7;
      else if (name.includes(w)) score += 5;
      else if (where.includes(w)) score += 3;
      else if (text.includes(w)) score += 1;
      else { all = false; break; }
    }
    if (all) results.push({ page: p, score, snippet: snippetFor(p, words, wiki) });
  }
  results.sort((a, b) => b.score - a.score || byName(a.page, b.page));
  return results;
}

function snippetFor(page, words, wiki) {
  const texts = textsOf(page.data).map(t => plainText(t, wiki));
  for (const t of texts) {
    const ft = fold(t);
    const hit = words.map(w => ft.indexOf(w)).find(i => i >= 0);
    if (hit !== undefined && hit >= 0) {
      const start = Math.max(0, hit - 40);
      return (start > 0 ? '…' : '') + t.slice(start, start + 140).replace(/\s+/g, ' ') + (t.length > start + 140 ? '…' : '');
    }
  }
  return '';
}

/* ---------- Groups and templates (built-in + saved changes) ---------- */

// Saved changes (collections "groups" and "templates", see wiki/custom.js) override the
// built-ins in config/wiki.js by id. Hidden groups and sub-groups stay in the list (marked
// hidden) so their pages keep their place; only the Wiki start and the pickers skip them.

/** Template fields as saved: [{ key, label, kind? }], each key once. */
export function cleanFields(list) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || !x.key || seen.has(String(x.key))) continue;
    seen.add(String(x.key));
    out.push({ key: String(x.key), label: String(x.label || x.key), ...(x.kind === 'image' ? { kind: 'image' } : {}) });
  }
  return out;
}

function mergeTemplates(rows) {
  const out = {};
  for (const [id, t] of Object.entries(TEMPLATES)) {
    out[id] = { id, name: t.name, fields: cleanFields(t.fields), builtin: true, changed: false, custom: false };
  }
  for (const r of rows) {
    const d = isPlainObject(r.data) ? r.data : {};
    if (!Array.isArray(d.fields)) continue;
    const builtin = !!TEMPLATES[r.id];
    out[r.id] = {
      id: r.id,
      name: String(d.name || out[r.id]?.name || humanizeId(r.id)).trim() || humanizeId(r.id),
      fields: cleanFields(d.fields),
      builtin, changed: builtin, custom: !builtin,
    };
  }
  return out;
}

function mergeGroups(rows) {
  const out = GROUPS.map((g, i) => ({
    ...structuredClone(g), order: (i + 1) * 10, builtin: true, changed: false, hidden: false,
    subgroups: g.subgroups.map(s => ({ ...s, builtin: true, hidden: false })),
  }));
  for (const r of rows) {
    const d = isPlainObject(r.data) ? r.data : {};
    let g = out.find(x => x.id === r.id);
    if (g) g.changed = true;
    else {
      g = { id: r.id, name: humanizeId(r.id), icon: 'book', subgroups: [], order: 1000, builtin: false, changed: false, hidden: false };
      out.push(g);
    }
    if (typeof d.name === 'string' && d.name.trim()) g.name = d.name.trim();
    if (typeof d.icon === 'string' && d.icon) g.icon = d.icon;
    if (typeof d.order === 'number' && Number.isFinite(d.order)) g.order = d.order;
    g.hidden = !!d.hidden;
    if (Array.isArray(d.subgroups)) {
      const builtinSubs = GROUPS.find(x => x.id === g.id)?.subgroups || [];
      const seen = new Set();
      g.subgroups = d.subgroups.filter(x => x && x.id && !seen.has(String(x.id)) && seen.add(String(x.id))).map(x => ({
        id: String(x.id),
        name: String(x.name || '').trim() || humanizeId(x.id),
        template: String(x.template || 'item'),
        icon: String(x.icon || g.subgroups.find(old => old.id === x.id)?.icon || g.icon || 'book'),
        builtin: builtinSubs.some(b => b.id === x.id),
        hidden: !!x.hidden,
      }));
    }
  }
  return out.sort((a, b) => a.order - b.order);
}
