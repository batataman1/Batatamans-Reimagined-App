// Saving changes to the wiki's groups, sub-groups and templates (Customize, part 2b step 3).
//
// Collection "groups", id = group id. For a built-in group only what differs from the
// built-in is saved (the name is always kept, so lists can show it):
//   { name, icon?, order?, hidden?, subgroups?: [{ id, name, template, icon, hidden? }] }
// A group you made saves everything. When a built-in group ends up exactly like it came,
// its saved changes are removed, so it follows the built-in again.
//
// Collection "templates", id = template id: { name, fields: [{ key, label, kind? }] }.
// The same goes for built-in templates: identical to the built-in = nothing saved.
//
// Field keys never change once made (renaming a field only changes its label), so the values
// pages already have stay attached. Nothing here ever changes a page.

import { store } from '../core/store.js';
import { GROUPS, TEMPLATES } from '../config/wiki.js';
import { slugify, isValidId, uid, humanizeKey } from '../core/util.js';
import { humanizeId } from './model.js';

export const builtinGroup = id => GROUPS.find(g => g.id === id) || null;
export const builtinOrder = id => (GROUPS.findIndex(g => g.id === id) + 1) * 10;

/** A group as the editors change it (a copy of the merged group from the model). */
export function groupDraft(g) {
  return {
    id: g.id, name: g.name, icon: g.icon, order: g.order, hidden: !!g.hidden,
    subgroups: g.subgroups.map(s => ({ id: s.id, name: s.name, template: s.template, icon: s.icon, hidden: !!s.hidden })),
  };
}

/** The built-in version of a group, as a draft. */
export function builtinGroupDraft(id) {
  const b = builtinGroup(id);
  if (!b) return null;
  return groupDraft({ ...b, order: builtinOrder(id), subgroups: b.subgroups });
}

const subRecord = s => ({
  id: s.id, name: String(s.name || '').trim() || humanizeId(s.id), template: s.template, icon: s.icon,
  ...(s.hidden ? { hidden: true } : {}),
});

/** What gets saved for a group, or null when it's just the built-in. */
export function groupRecord(d) {
  const name = String(d.name || '').trim();
  const subs = d.subgroups.map(subRecord);
  const b = builtinGroup(d.id);
  if (!b) {
    return { name: name || humanizeId(d.id), icon: d.icon, order: d.order, ...(d.hidden ? { hidden: true } : {}), subgroups: subs };
  }
  const data = { name: name || b.name };
  if (d.icon !== b.icon) data.icon = d.icon;
  if (d.order !== builtinOrder(d.id)) data.order = d.order;
  if (d.hidden) data.hidden = true;
  const builtinSubs = b.subgroups.map(subRecord);
  if (JSON.stringify(subs) !== JSON.stringify(builtinSubs)) data.subgroups = subs;
  return Object.keys(data).length === 1 && data.name === b.name ? null : data;
}

/** Save a group draft (or remove its saved changes when it's back to the built-in). */
export async function saveGroup(d, opts) {
  const data = groupRecord(d);
  if (data) await store.put('groups', d.id, data, opts);
  else if (await store.get('groups', d.id)) await store.remove('groups', d.id);
}

/** A template as the editor changes it. */
export const templateDraft = (id, t) => ({ id, name: t.name, fields: t.fields.map(f => ({ ...f })) });

export function templateRecord(d) {
  const fields = d.fields.map(f => ({
    key: f.key, label: String(f.label || '').trim() || humanizeKey(f.key), ...(f.kind === 'image' ? { kind: 'image' } : {}),
  }));
  const b = TEMPLATES[d.id];
  const name = String(d.name || '').trim() || b?.name || humanizeId(d.id);
  const data = { name, fields };
  if (b && JSON.stringify(data) === JSON.stringify({ name: b.name, fields: b.fields })) return null;
  return data;
}

export async function saveTemplate(d, opts) {
  const data = templateRecord(d);
  if (data) await store.put('templates', d.id, data, opts);
  else if (await store.get('templates', d.id)) await store.remove('templates', d.id);
}

/* ---------- Names and ids ---------- */

/** An id made from the name that isn't taken yet: "Sea Life" -> "sea-life" (or "sea-life-2"). */
export function freshId(name, taken, fallbackPrefix) {
  let base = slugify(name);
  if (!isValidId(base)) base = `${fallbackPrefix}-${uid()}`;
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`.slice(0, 80);
  return id;
}

/** A field key made from its label: "Attack speed" -> "attackSpeed". */
export function freshKey(label, taken) {
  const words = String(label || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  let base = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  if (!base || /^[0-9]/.test(base)) base = `field${base ? base[0].toUpperCase() + base.slice(1) : ''}`;
  base = base.slice(0, 60);
  let key = base, n = 2;
  while (taken.has(key)) key = `${base}${n++}`;
  return key;
}

/** An order number that puts a group between two others (only the moved group changes). */
export function orderBetween(before, after) {
  if (before == null && after == null) return 10;
  if (before == null) return after - 10;
  if (after == null) return before + 10;
  return (before + after) / 2;
}
