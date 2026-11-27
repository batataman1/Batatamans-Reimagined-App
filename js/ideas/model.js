// Ideas, worked out from what's saved on this device (part 2c Ideas).
//
// Collection "ideas", id "i-<random>":
// {
//   title,
//   section: a section id, or null for "Not sorted",
//   parent: the idea it comes under (its "main bubble" on the mind map), or null = straight under the section,
//   links: [{ collection: "wiki", id }],          wiki pages
//   body: [blocks],                                the note, same blocks as wiki pages
//   created: ISO time                              used for sorting, never shown
//   order: number (optional)                       place among its siblings after a drag
//   map: { x, y } (optional)                       its place on the mind map (missing = placed automatically)
//   size: "s" | "l" | "xl" (optional)              its bubble size (missing = normal)
//   connections: [idea ids] (optional)             dashed lines on the mind map to other ideas
// }
// Siblings are sorted by `order`; an idea without one counts as the time it was made (in ms),
// so new ideas come last and a dragged idea gets a number between its new neighbours.
// An idea that comes under another idea is always in that idea's section (its own `section` is
// only used when it has no parent), so moving an idea moves everything under it along.
// Tasks made from an idea link it ({ collection: "ideas", id } in the task's links).
//
// Collection "sections", id "s-<random>": { name, parent: section id or null, order, map?, size? }
// Sections can hold sections, as deep as you like.

import { store } from '../core/store.js';
import { isPlainObject, uid } from '../core/util.js';
import { plainText } from '../wiki/text.js';

export const newIdeaId = () => uid('i');
export const newSectionId = () => uid('s');

let cache = null;
store.on(() => { cache = null; });

/** Everything the Ideas tab needs. Cached until something changes on this device. */
export function getIdeas() {
  if (!cache) cache = build();
  return cache;
}

/** An idea's saved data with every key in a usable shape. */
export function normalizeIdea(d) {
  d = isPlainObject(d) ? d : {};
  return {
    ...d,
    title: String(d.title || '').trim(),
    section: typeof d.section === 'string' && d.section ? d.section : null,
    parent: typeof d.parent === 'string' && d.parent ? d.parent : null,
    links: (Array.isArray(d.links) ? d.links : []).filter(l => l && l.collection && l.id).map(l => ({ collection: String(l.collection), id: String(l.id) })),
    body: Array.isArray(d.body) ? d.body : [],
    map: mapPoint(d.map),
    size: BUBBLE_SIZES.includes(d.size) ? d.size : 'm',
    connections: [...new Set((Array.isArray(d.connections) ? d.connections : []).filter(c => typeof c === 'string' && c))],
  };
}

/** An idea's data ready to save: defaults (normal size, no map place, no connections) left out. */
export function storableIdea(d) {
  const out = { ...d };
  if (!out.map) delete out.map;
  if (!out.size || out.size === 'm') delete out.size;
  if (!Array.isArray(out.connections) || !out.connections.length) delete out.connections;
  return out;
}

/** Bubble sizes on the mind map, smallest first ("m" = normal, never saved). */
export const BUBBLE_SIZES = ['s', 'm', 'l', 'xl'];
export const SIZE_NAMES = { s: 'Small', m: 'Normal', l: 'Big', xl: 'Huge' };

/** A saved place on the mind map, or null. */
export function mapPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
}

/** Where an idea sits among its siblings (smaller first). */
export const orderKey = i => (typeof i.data.order === 'number' && Number.isFinite(i.data.order) ? i.data.order
  : Date.parse(i.data.created || i.updatedAt || '') || 0);
const byCreated = (a, b) => orderKey(a) - orderKey(b) || a.data.title.localeCompare(b.data.title);

async function build() {
  const [rows, sectionRows] = await Promise.all([store.list('ideas'), store.list('sections')]);

  /* Sections (same rules as task folders) */
  const sections = new Map();
  for (const r of sectionRows) {
    const d = isPlainObject(r.data) ? r.data : {};
    sections.set(r.id, {
      id: r.id, name: String(d.name || '').trim() || 'Section',
      parent: typeof d.parent === 'string' && d.parent ? d.parent : null,
      order: typeof d.order === 'number' && Number.isFinite(d.order) ? d.order : 1000,
      map: mapPoint(d.map),
      size: BUBBLE_SIZES.includes(d.size) ? d.size : 'l',   // section bubbles start big
      data: d,                                       // as saved, so changes keep every key
      dirty: !!r.dirty,
    });
  }
  for (const s of sections.values()) {
    if (s.parent && !sections.has(s.parent)) { s.parent = null; continue; }
    const seen = new Set([s.id]);
    for (let p = s.parent; p; p = sections.get(p)?.parent) {
      if (seen.has(p)) { s.parent = null; break; }
      seen.add(p);
    }
  }
  const byOrder = (a, b) => a.order - b.order || a.name.localeCompare(b.name);
  const childrenOf = parent => [...sections.values()].filter(s => s.parent === parent).sort(byOrder);
  const sectionDescendants = id => {
    const out = new Set([id]);
    const walk = p => { for (const c of childrenOf(p)) { out.add(c.id); walk(c.id); } };
    walk(id);
    return out;
  };
  const tree = () => {
    const out = [];
    const walk = (p, depth) => { for (const s of childrenOf(p)) { out.push({ section: s, depth }); walk(s.id, depth + 1); } };
    walk(null, 0);
    return out;
  };
  const path = id => {
    const out = [];
    for (let s = sections.get(id); s; s = s.parent ? sections.get(s.parent) : null) out.unshift(s);
    return out;
  };

  /* Ideas */
  const ideas = new Map();
  for (const r of rows) ideas.set(r.id, { id: r.id, data: normalizeIdea(r.data), updatedAt: r.updatedAt, dirty: !!r.dirty });

  // The idea each one really comes under: a missing parent, or one that would put it under
  // itself, counts as "straight under the section".
  const parentOf = new Map();
  for (const i of ideas.values()) {
    let p = i.data.parent && i.data.parent !== i.id && ideas.has(i.data.parent) ? i.data.parent : null;
    if (p) {
      const seen = new Set([i.id]);
      for (let q = p; q; q = ideas.get(q)?.data.parent) {
        if (seen.has(q)) { p = null; break; }
        seen.add(q);
        if (!ideas.has(q)) break;
      }
    }
    parentOf.set(i.id, p);
  }
  const rootOf = i => { let x = i; while (parentOf.get(x.id)) x = ideas.get(parentOf.get(x.id)); return x; };
  /** The section an idea is in (its top idea's section), or null for Not sorted. */
  const sectionOf = i => { const s = rootOf(i).data.section; return s && sections.has(s) ? s : null; };

  const kids = new Map();
  for (const i of ideas.values()) {
    const p = parentOf.get(i.id);
    if (!p) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(i);
  }
  for (const list of kids.values()) list.sort(byCreated);
  const kidsOf = id => kids.get(id) || [];

  /** The ideas straight under a section (null = Not sorted). */
  const topIdeas = key => [...ideas.values()].filter(i => !parentOf.get(i.id) && sectionOf(i) === (key || null)).sort(byCreated);

  /** An idea and everything under it. */
  const branch = id => {
    const out = new Set([id]);
    const walk = p => { for (const c of kidsOf(p)) { out.add(c.id); walk(c.id); } };
    walk(id);
    return out;
  };

  /** "all", "none" or a section id -> the ideas shown there (sub-sections included). */
  function ideasIn(key) {
    const all = [...ideas.values()];
    if (key === 'all' || !key) return all;
    if (key === 'none') return all.filter(i => !sectionOf(i));
    if (!sections.has(key)) return [];
    const ids = sectionDescendants(key);
    return all.filter(i => ids.has(sectionOf(i)));
  }

  /** Ideas from the top of the branch down to this idea's parent. */
  const ideaPath = id => {
    const out = [];
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) out.unshift(ideas.get(p));
    return out;
  };

  /** The words a search looks through. */
  const textOf = (i, wiki) => [i.data.title, ...i.data.body.map(b => plainText(b?.text || b?.caption || '', wiki))].join(' \n ');

  return {
    ideas, sections,
    get: id => ideas.get(id) || null,
    section: id => sections.get(id) || null,
    childrenOf, sectionDescendants, tree, path,
    parentOf: id => parentOf.get(id) || null,
    sectionOf, kidsOf, topIdeas, branch, ideasIn, ideaPath, textOf,
    count: key => ideasIn(key).length,
    /** The ideas next to this one: under the same idea, or straight under the same section. */
    siblingsOf: i => (parentOf.get(i.id) ? kidsOf(parentOf.get(i.id)) : topIdeas(sectionOf(i))),
  };
}

const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The ideas whose title or note has every word of the search. */
export function searchIdeas(list, model, wiki, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter(i => { const t = fold(model.textOf(i, wiki)); return words.every(w => t.includes(w)); });
}

/** Make a new idea. Returns its id. */
export async function createIdea({ title, section = null, parent = null, links = [], map = null }) {
  const id = newIdeaId();
  await store.put('ideas', id, {
    title: String(title).trim(), section: section || null, parent: parent || null,
    ...(links.length ? { links } : {}), ...(map ? { map } : {}), created: new Date().toISOString(),
  });
  return id;
}

/** Save a change to an idea. */
export async function updateIdea(id, change, opts) {
  const row = await store.get('ideas', id);
  if (!row) return;
  await store.put('ideas', id, { ...row.data, ...change }, opts);
}
