// Where the bubbles of the mind map go (part 2c Ideas, step 2).
//
// All maps share one big drawing ("the world"): "All ideas" sits at 0,0, the top sections
// and "Not sorted" around it, each section's sub-sections and ideas around that section, and
// each idea's ideas around it. A section's map shows only that section's part of the world,
// so a bubble moved on one map is moved on every map.
//
// A bubble keeps the place it was moved to (`map: { x, y }` on the idea or section). A bubble
// without one is placed automatically around its main bubble, fanning outwards, so new ideas
// find a spot by themselves. Tidy up gives every bubble of a map a new, neat place.

import { BUBBLE_SIZES } from './model.js';

/** How big each bubble size draws: text size and widest line (in map units). */
export const SIZE_STYLE = {
  s: { font: 13, width: 130 },
  m: { font: 15, width: 170 },
  l: { font: 19, width: 220 },
  xl: { font: 25, width: 280 },
};
const RADIUS = { s: 50, m: 62, l: 80, xl: 100 };

/** The fold id of a node: ideas use their own id, sections "s:<id>" (shared with the list). */
export const foldId = n => (n.kind === 'idea' ? n.id : n.kind === 'section' ? `s:${n.id}` : n.kind === 'none' ? 's:none' : 'root');

/**
 * The whole world as a tree of nodes:
 *   { key: "root" | "s:<id>" | "s:none" | "i:<id>", kind: "root" | "section" | "none" | "idea",
 *     id, label, size, saved: {x,y} | null, parent: node | null, children: [nodes], idea?, section? }
 */
export function worldTree(model) {
  const nodes = new Map();
  const add = (n, parent) => {
    n.parent = parent || null;
    n.children = [];
    nodes.set(n.key, n);
    parent?.children.push(n);
    return n;
  };
  const root = add({ key: 'root', kind: 'root', id: null, label: 'All ideas', size: 'xl', saved: { x: 0, y: 0 } }, null);
  const addIdeas = (list, parent) => {
    for (const i of list) {
      const n = add({ key: `i:${i.id}`, kind: 'idea', id: i.id, label: i.data.title || '(no title)', size: i.data.size, saved: i.data.map, idea: i }, parent);
      addIdeas(model.kidsOf(i.id), n);
    }
  };
  const addSection = (s, parent) => {
    const n = add({ key: `s:${s.id}`, kind: 'section', id: s.id, label: s.name, size: s.size, saved: s.map, section: s }, parent);
    for (const c of model.childrenOf(s.id)) addSection(c, n);
    addIdeas(model.topIdeas(s.id), n);
  };
  for (const s of model.childrenOf(null)) addSection(s, root);
  const loose = model.topIdeas(null);
  if (loose.length) {
    const none = add({ key: 's:none', kind: 'none', id: 'none', label: 'Not sorted', size: 'l', saved: null }, root);
    addIdeas(loose, none);
  }
  return { root, nodes, get: key => nodes.get(key) || null };
}

/** The node a map is about: "all", "none" or a section id. */
export function centerOf(world, key) {
  if (key === 'all') return world.root;
  if (key === 'none') return world.get('s:none');
  return world.get(`s:${key}`);
}

export const radiusOf = n => RADIUS[n.size] || RADIUS.m;

/** Every node of a branch (the node itself first). */
export function branchNodes(n) {
  const out = [];
  const walk = x => { out.push(x); x.children.forEach(walk); };
  walk(n);
  return out;
}

/**
 * Places for every node: saved ones where they are, the others around their main bubble.
 * `nonePos` is where "Not sorted" was put on this device (it has no record to keep it in).
 * Returns Map key -> { x, y }.
 */
export function placeAll(world, nonePos = null) {
  const pos = new Map();
  pos.set('root', { x: 0, y: 0 });
  const walk = n => {
    const p = pos.get(n.key);
    const kids = n.children;
    const count = kids.length;
    if (!count) return;
    let angleOf, dist;
    if (n.kind === 'root') {
      angleOf = i => -Math.PI / 2 + (2 * Math.PI * i) / count;
      dist = 340 + count * 14;
    } else {
      const g = n.parent ? pos.get(n.parent.key) : null;
      const base = g && (g.x !== p.x || g.y !== p.y) ? Math.atan2(p.y - g.y, p.x - g.x) : -Math.PI / 2;
      // About 260 units of arc between neighbours (a normal bubble is up to ~220 wide); if that's
      // more than a wide fan, go further out.
      const GAP = 260, maxFan = Math.PI * 1.3;
      dist = Math.max(200 + radiusOf(n), ((count - 1) * GAP) / maxFan);
      const spread = Math.min(maxFan, ((count - 1) * GAP) / dist);
      angleOf = i => base - spread / 2 + (count === 1 ? 0 : (spread * i) / (count - 1));
    }
    kids.forEach((k, i) => {
      const saved = k.kind === 'none' ? nonePos : k.saved;
      if (saved) pos.set(k.key, { x: saved.x, y: saved.y });
      else {
        const a = angleOf(i);
        const r = dist + radiusOf(k) - 62;
        pos.set(k.key, { x: Math.round(p.x + Math.cos(a) * r), y: Math.round(p.y + Math.sin(a) * r) });
      }
      walk(k);
    });
  };
  walk(world.root);
  return pos;
}

/**
 * Tidy up: neat rings around the map's centre bubble (which stays where it is). Every branch
 * gets a slice of the circle as wide as the number of bubbles at its ends, so nothing crowds.
 * Folded branches are arranged too, so unfolding them later looks right.
 * Returns Map key -> { x, y } for every node under the centre.
 */
export function tidyLayout(center, at) {
  const leaves = new Map();
  const count = n => {
    const v = n.children.length ? n.children.reduce((s, k) => s + count(k), 0) : 1;
    leaves.set(n.key, v);
    return v;
  };
  const total = count(center);
  const ring1 = Math.max(240, (total * 150) / (2 * Math.PI));
  const ringAt = d => ring1 + (d - 1) * 230;
  const out = new Map();
  const assign = (n, a0, a1, depth) => {
    let a = a0;
    for (const k of n.children) {
      const share = ((a1 - a0) * leaves.get(k.key)) / leaves.get(n.key);
      const mid = a + share / 2;
      const r = ringAt(depth + 1);
      out.set(k.key, { x: Math.round(at.x + Math.cos(mid) * r), y: Math.round(at.y + Math.sin(mid) * r) });
      assign(k, a, a + share, depth + 1);
      a += share;
    }
  };
  assign(center, -Math.PI / 2, (3 * Math.PI) / 2, 0);
  return out;
}

/** A free spot for a new bubble next to `n`, away from its other bubbles. */
export function freeSpot(n, pos) {
  const p = pos.get(n.key);
  const g = n.parent ? pos.get(n.parent.key) : null;
  const base = g && (g.x !== p.x || g.y !== p.y) ? Math.atan2(p.y - g.y, p.x - g.x) : -Math.PI / 2;
  const others = [...pos.entries()].filter(([k]) => k !== n.key).map(([, v]) => v);
  const dist = 200 + radiusOf(n) - 62;
  let best = null, bestGap = -1;
  for (let step = 0; step < 24; step++) {
    const off = (step % 2 ? 1 : -1) * Math.ceil(step / 2) * (Math.PI / 12);
    const a = base + off;
    const c = { x: Math.round(p.x + Math.cos(a) * dist), y: Math.round(p.y + Math.sin(a) * dist) };
    const gap = Math.min(Infinity, ...others.map(o => Math.hypot(o.x - c.x, o.y - c.y)));
    if (gap > 150) return c;
    if (gap > bestGap) { bestGap = gap; best = c; }
  }
  return best;
}

export const nextSize = (size, step) => BUBBLE_SIZES[Math.max(0, Math.min(BUBBLE_SIZES.length - 1, BUBBLE_SIZES.indexOf(size || 'm') + step))];
