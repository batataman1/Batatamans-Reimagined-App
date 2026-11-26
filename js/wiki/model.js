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
//   variants: [{ name, note }]                       e.g. the blocks of a wood set
//   body: [{ type, text, ... }]                      the page text, see wiki/text.js
// }
// Links are written [[page-id]] or [[page-id|shown text]]. A page name also works: [[Ostrich Egg]].

import { store } from '../core/store.js';
import { GROUPS, TEMPLATES } from '../config/wiki.js';
import { isPlainObject } from '../core/util.js';
import { linkTargets, targetId, plainText } from './text.js';

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
    get: id => pages.get(id) || null,
    group: id => groups.find(g => g.id === id) || null,
    placeOf: page => placed.get(page.id) || null,
    pagesIn: (groupId, subId) => bySub.get(`${groupId}/${subId}`) || [],
    countIn: (groupId, subId) => subId
      ? (bySub.get(`${groupId}/${subId}`) || []).length
      : (groups.find(g => g.id === groupId)?.subgroups || []).reduce((n, s) => n + (bySub.get(`${groupId}/${s.id}`) || []).length, 0),
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
  if (isPlainObject(data.fields)) Object.values(data.fields).forEach(add);
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

function mergeTemplates(rows) {
  const out = structuredClone(TEMPLATES);
  for (const r of rows) {
    const d = r.data || {};
    if (!Array.isArray(d.fields)) continue;
    out[r.id] = {
      name: d.name || out[r.id]?.name || humanizeId(r.id),
      fields: d.fields.filter(x => x && x.key).map(x => ({ key: String(x.key), label: String(x.label || x.key) })),
      custom: !TEMPLATES[r.id],
    };
  }
  return out;
}

function mergeGroups(rows) {
  const out = GROUPS.map((g, i) => ({ ...structuredClone(g), order: (i + 1) * 10 }));
  for (const r of rows) {
    const d = r.data || {};
    let g = out.find(x => x.id === r.id);
    if (!g) { g = { id: r.id, name: humanizeId(r.id), icon: 'book', subgroups: [], order: 1000 }; out.push(g); }
    if (d.name) g.name = d.name;
    if (d.icon) g.icon = d.icon;
    if (typeof d.order === 'number') g.order = d.order;
    if (d.hidden) g.hidden = true;
    if (Array.isArray(d.subgroups)) {
      g.subgroups = d.subgroups.filter(x => x && x.id).map(x => ({
        id: String(x.id), name: String(x.name || humanizeId(x.id)), template: String(x.template || 'item'),
      }));
    }
  }
  return out.filter(g => !g.hidden).sort((a, b) => a.order - b.order);
}
