// The Ideas tab's screens (part 2c Ideas, step 1: sections, the list and idea pages).
//
// Addresses (after #/ideas/):
//   (nothing)      all ideas, section by section
//   s/none         ideas without a section ("Not sorted")
//   s/<section>    a section (its sub-sections' ideas shown below its own)
//   i/<idea>       an idea's page (ideas/editor.js)
//   m/<key>        the mind map of all ideas (m/all), Not sorted (m/none) or a section (ideas/map.js)
//   d/<key>        the drawings of all ideas, Not sorted or a section (draw/gallery.js)
//   draw/<id>      a drawing, full screen, with the other open drawings as tabs (draw/workspace.js)
//
// The list is an outline: an idea that comes under another idea is indented below it, with a
// fold button. Which ideas are folded is remembered on this device (not synced).

import { h, clear, plural } from '../core/util.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { openModal, confirmDialog, errorDialog, toast, deleteWithContentsDialog } from '../ui/dialogs.js';
import { sortable } from '../ui/drag.js';
import { openPopup } from '../wiki/popup.js';
import { topNav } from '../wiki/parts.js';
import { nameFor } from '../wiki/text.js';
import { orderBetween } from '../wiki/custom.js';
import { nameDialog } from '../tasks/views.js';
import { createIdea, newSectionId, searchIdeas, storableIdea } from './model.js';
import { ideaEditorView } from './editor.js';
import { mapScreen } from './map.js';
import { sectionSelect, addUnderDialog, moveIdeaDialog, confirmDeleteIdea, removeIdea, makeTaskDialog, moveIdeaTo } from './actions.js';
import { filesOfPage, isFileOfPage } from '../wiki/images.js';
import { galleryContent, newDrawingDialog, addReferenceFromDevice } from '../draw/gallery.js';
import { drawingWorkspaceView, openDrawingTabs } from '../draw/workspace.js';

const APP_TITLE = "Batataman's Reimagined";

export function parseIdeasPath(path) {
  const [kind, a] = String(path || '').split('/').map(x => decodeURIComponent(x));
  if (kind === 'i' && a) return { view: 'idea', id: a };
  if (kind === 's' && a) return { view: 'list', section: a };
  if (kind === 'm' && a) return { view: 'map', section: a };
  if (kind === 'd' && a) return { view: 'draw', section: a };
  if (kind === 'draw' && a) return { view: 'drawing', id: a };
  return { view: 'list', section: 'all' };
}

export function renderIdeasView(el, path, ctx) {
  const route = parseIdeasPath(path);
  document.title = `Ideas · ${APP_TITLE}`;
  if (route.view === 'idea') return ideaEditorView(el, ctx, route.id);
  if (route.view === 'drawing') return drawingWorkspaceView(el, ctx, route.id);
  return homeView(el, ctx, route.section, route.view);
}

/* ---------- Small pieces ---------- */

const sectionHref = (key, view = 'list') => (view === 'map' ? `#/ideas/m/${encodeURIComponent(key)}`
  : view === 'draw' ? `#/ideas/d/${encodeURIComponent(key)}`
  : key === 'all' ? '#/ideas' : `#/ideas/s/${encodeURIComponent(key)}`);
/** The address (after #/ideas/) of a section in a view: list, map or drawings. */
const sectionPath = (key, view = 'list') => (view === 'map' ? `m/${key}` : view === 'draw' ? `d/${key}` : key === 'all' ? '' : `s/${key}`);
const ideaHref = id => `#/ideas/i/${encodeURIComponent(id)}`;

function sectionTitle(model, key) {
  if (key === 'all') return 'All ideas';
  if (key === 'none') return 'Not sorted';
  return model.section(key)?.name || 'Section';
}

/** "Task", "2 tasks" or "Task done": what became of an idea. */
function taskTag(idea, tasks) {
  const made = tasks.linkedTo('ideas', idea.id);
  if (!made.length) return null;
  const open = made.filter(t => t.data.status !== 'done').length;
  const text = open ? (made.length === 1 ? 'Task' : plural(made.length, 'task')) : (made.length === 1 ? 'Task done' : 'Tasks done');
  return h('span', { class: `tag id-tag-task${open ? '' : ' id-tag-done'}`, title: `Made into ${plural(made.length, 'task')}${open ? `, ${open} not done yet` : ', all done'}` },
    icon('tasks', { size: 12 }), text);
}

/** The ⋯ menu of an idea. */
export function ideaMenu(idea, anchor, ctx) {
  const { model, ui } = ctx;
  openPopup({
    rect: anchor.getBoundingClientRect(),
    title: idea.data.title || 'Idea',
    items: [
      { label: 'Open', icon: 'edit', onPick: () => ui.go(`i/${idea.id}`) },
      { label: 'Add an idea under this', icon: 'plus', onPick: () => addUnderDialog(model, idea, ui) },
      { label: 'Make a task', icon: 'tasks', onPick: () => makeTaskDialog(idea) },
      { label: 'Move to section…', icon: 'idea', onPick: () => moveIdeaDialog(model, idea) },
      {
        label: 'Delete', icon: 'trash',
        onPick: async () => {
          if (!(await confirmDeleteIdea(model, idea))) return;
          try { await removeIdea(model, idea.id, idea.data); } catch (err) { errorDialog(err, "The idea couldn't be deleted"); return; }
          toast('Deleted. Push to remove it from GitHub too.');
        },
      },
    ],
  });
}

/** One idea in the outline, with the ideas under it (unless folded). */
function ideaItem(idea, ctx, { where = '', flat = false } = {}) {
  const { model, tasks, wiki, ui } = ctx;
  const kids = flat ? [] : model.kidsOf(idea.id);
  const folded = ui.isFolded(idea.id);
  const hidden = folded ? model.branch(idea.id).size - 1 : 0;
  const more = h('button', {
    type: 'button', class: 'row-menu', 'aria-label': `More for ${idea.data.title || 'idea'}`, title: 'Add under, make a task, move, delete',
    onclick: () => ideaMenu(idea, more, ctx),
  }, '⋯');
  const foldBtn = kids.length
    ? h('button', {
        type: 'button', class: 'id-fold', 'aria-expanded': String(!folded),
        'aria-label': `${folded ? 'Show' : 'Hide'} the ideas under ${idea.data.title || 'this idea'}`, title: folded ? 'Show the ideas under it' : 'Hide the ideas under it',
        onclick: () => ui.toggleFold(idea.id),
      }, folded ? '▸' : '▾')
    : h('span', { class: 'id-fold id-fold-none', 'aria-hidden': 'true' });
  const links = idea.data.links.filter(l => l.collection === 'wiki').map(l => nameFor(wiki, l.id)).join(', ');
  const handle = flat ? null : h('button', {
    type: 'button', class: 'id-handle', 'aria-label': `Move ${idea.data.title || 'idea'}`,
    title: 'Drag: drop between ideas, or onto an idea to put it under that one. Tap for more',
  }, '⋮⋮');
  const itemEl = h('div', { class: 'id-item', dataset: { idea: idea.id } },
      handle,
      foldBtn,
      h('div', { class: 'id-row' },
        h('span', { class: 'id-row-head' },
          h('a', { class: 'id-title tk-open', href: ideaHref(idea.id), text: idea.data.title || '(no title)' }),
          hidden ? h('span', { class: 'tag id-tag-hidden', title: `${plural(hidden, 'idea')} folded away`, text: `+${hidden}` }) : null,
          taskTag(idea, tasks),
          idea.dirty ? h('span', { class: 'tag tag-dirty', text: 'Not pushed' }) : null),
        where || links ? h('span', { class: 'tk-row-sub' },
          where ? h('span', { class: 'tk-where' }, icon('idea', { size: 12 }), where) : null,
          links ? h('span', { class: 'tk-links' }, icon('book', { size: 12 }), links) : null) : null),
      more);
  if (handle) ideaDrag(itemEl, handle, idea, ctx);
  return h('li', { class: 'id-node', dataset: { idea: idea.id } },
    itemEl,
    kids.length && !folded ? h('ul', { class: 'id-tree' }, kids.map(k => ideaItem(k, ctx))) : null);
}

/** The outline of one section's own ideas. */
function outline(list, ctx) {
  return list.length ? h('ul', { class: 'id-tree id-top' }, list.map(i => ideaItem(i, ctx))) : null;
}

/** A section heading with its ideas and its sub-sections below (used inside another screen). */
function sectionBlock(s, ctx, depth = 0) {
  const { model, ui } = ctx;
  const folded = ui.isFolded(`s:${s.id}`);
  const own = model.topIdeas(s.id);
  const subs = model.childrenOf(s.id);
  const n = model.count(s.id);
  const head = h(depth ? 'h3' : 'h2', { class: 'id-shead' },
    n || subs.length ? h('button', {
      type: 'button', class: 'id-fold', 'aria-expanded': String(!folded),
      'aria-label': `${folded ? 'Show' : 'Hide'} ${s.name}`, onclick: () => ui.toggleFold(`s:${s.id}`),
    }, folded ? '▸' : '▾') : h('span', { class: 'id-fold id-fold-none', 'aria-hidden': 'true' }),
    h('a', { href: sectionHref(s.id), text: s.name }),
    h('span', { class: 'id-scount', text: n ? plural(n, 'idea') : 'empty' }));
  return h('section', { class: 'id-sblock', dataset: { section: s.id } },
    head,
    folded ? null : [
      outline(own, ctx),
      !own.length && !subs.length ? h('p', { class: 'muted small id-sempty', text: 'No ideas here yet.' }) : null,
      subs.length ? h('div', { class: 'id-subs' }, subs.map(x => sectionBlock(x, ctx, depth + 1))) : null,
    ]);
}

/* ---------- Sections panel (like the task folders) ---------- */

function sectionPanel(ctx, key) {
  const { model, ui, drawings } = ctx;
  // In the Drawings view the counts are drawings; otherwise ideas.
  const drawingView = ui.prefs.view === 'draw' && drawings;
  const countOf = k => (drawingView ? drawings.inSection(k, model).length : model.count(k));
  const noun = drawingView ? 'drawing' : 'idea';
  const panel = h('div', { class: 'tk-side-panel', id: 'id-sections' });
  const toggle = h('button', {
    type: 'button', class: 'btn tk-side-toggle', 'aria-expanded': String(!!ui.sectionsOpen), 'aria-controls': 'id-sections',
    onclick: () => {
      ui.sectionsOpen = !ui.sectionsOpen;
      toggle.setAttribute('aria-expanded', String(ui.sectionsOpen));
      panel.classList.toggle('open', ui.sectionsOpen);
    },
  }, icon('idea', { size: 18 }), h('span', { class: 'tk-side-current', text: sectionTitle(model, key) }), h('span', { class: 'tk-caret', 'aria-hidden': 'true', text: '▾' }));
  panel.classList.toggle('open', !!ui.sectionsOpen);

  const link = (k, label, depth = 0) => h('a', {
    class: 'tk-flink', href: sectionHref(k, ui.prefs.view), 'aria-current': k === key ? 'page' : null, dataset: { key: k },
    style: { '--depth': depth },
    onclick: () => { ui.sectionsOpen = false; },
  }, h('span', { class: 'tk-fname', text: label }), h('span', { class: 'tk-fcount', 'aria-label': plural(countOf(k), noun), text: String(countOf(k) || '') }));

  const list = parent => {
    const box = h('div', { class: 'tk-flist' }, model.childrenOf(parent).map((s, i, sibs) => {
      const handle = h('button', {
        type: 'button', class: 'sort-handle tk-fhandle', 'aria-label': `Move ${s.name}`, title: 'Drag to change the order. Tap for more',
        onclick: () => sectionMenu(s, handle, ctx, i, sibs),
      }, '⋮⋮');
      return h('div', { class: 'tk-frow sort-row', dataset: { section: s.id } },
        h('div', { class: 'tk-fline' }, handle, link(s.id, s.name, model.path(s.id).length - 1)),
        model.childrenOf(s.id).length ? list(s.id) : null);
    }));
    sortable(box, { onMove: (from, to) => moveSection(model, parent, from, to) });
    return box;
  };

  clear(panel,
    h('div', { class: 'tk-side-head' },
      h('h2', { text: 'Sections' }),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => newSectionDialog(ctx, null) }, icon('plus', { size: 14 }), 'New section')),
    h('nav', { class: 'tk-fnav', 'aria-label': 'Sections' },
      link('all', 'All ideas'),
      link('none', 'Not sorted'),
      model.sections.size ? list(null) : h('p', { class: 'muted small tk-fempty', text: 'No sections yet. Sections group ideas, like one for mobs and one for blocks.' })),
    model.sections.size ? h('p', { class: 'muted small tk-fhint', text: 'Drag ⋮⋮ to change the order; tap it to rename, move or delete.' }) : null);

  return h('aside', { class: 'tk-side' }, toggle, panel);
}

export const saveSection = (s, change) => store.put('sections', s.id, { ...s.data, name: s.name, parent: s.parent, order: s.order, ...change });

async function moveSection(model, parent, from, to) {
  const sibs = [...model.childrenOf(parent)];
  const [s] = sibs.splice(from, 1);
  sibs.splice(to, 0, s);
  const before = sibs[to - 1]?.order ?? null, after = sibs[to + 1]?.order ?? null;
  const order = orderBetween(before, after);
  try {
    if ((before !== null && !(order > before)) || (after !== null && !(order < after))) {
      for (const [i, x] of sibs.entries()) await saveSection(x, { order: (i + 1) * 10 });
    } else {
      await saveSection(s, { order });
    }
  } catch (err) { errorDialog(err, "The new order couldn't be saved"); }
}

function sectionMenu(s, anchor, ctx, i, sibs) {
  const { model } = ctx;
  openPopup({
    rect: anchor.getBoundingClientRect(),
    title: s.name,
    items: [
      { label: 'New section inside', icon: 'plus', onPick: () => newSectionDialog(ctx, s.id) },
      { label: 'Rename', icon: 'edit', onPick: () => nameDialog({ title: 'Rename section', value: s.name, confirm: 'Save', placeholder: 'For example: Mobs', onSave: name => saveSection(s, { name }) }) },
      { label: 'Move into another section…', icon: 'idea', onPick: () => moveSectionDialog(s, model) },
      i > 0 ? { label: 'Move up', onPick: () => moveSection(model, s.parent, i, i - 1) } : null,
      i < sibs.length - 1 ? { label: 'Move down', onPick: () => moveSection(model, s.parent, i, i + 1) } : null,
      { label: 'Delete section', icon: 'trash', onPick: () => deleteSection(s, ctx) },
    ].filter(Boolean),
  });
}

function newSectionDialog(ctx, parent) {
  const { model, ui } = ctx;
  const inside = sectionSelect(model, parent, { none: 'Top level (not inside a section)', name: 'parent', label: 'Inside' });
  return nameDialog({
    title: 'New section', confirm: 'Make section', placeholder: 'For example: Mobs',
    extra: h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Inside' }), inside),
    onSave: async name => {
      const p = inside.value || null;
      const sibs = model.childrenOf(p);
      const order = sibs.length ? sibs[sibs.length - 1].order + 10 : 10;
      const id = newSectionId();
      await store.put('sections', id, { name, parent: p, order });
      ui.go(sectionPath(id, ui.prefs.view));
    },
  });
}

function moveSectionDialog(s, model) {
  const sel = sectionSelect(model, s.parent, { none: 'Top level (not inside a section)', exclude: model.sectionDescendants(s.id), name: 'parent', label: 'Inside' });
  return openModal({
    title: `Move “${s.name}”`,
    body: [
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Put it inside' }), sel),
      h('p', { class: 'muted small', text: 'Its ideas and the sections inside it move along.' }),
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      {
        id: 'move', label: 'Move', kind: 'primary',
        onClick: async close => {
          const p = sel.value || null;
          if (p !== s.parent) {
            const sibs = model.childrenOf(p);
            await saveSection(s, { parent: p, order: sibs.length ? sibs[sibs.length - 1].order + 10 : 10 });
          }
          close('moved');
        },
      },
    ],
  }).result;
}

async function deleteSection(s, ctx) {
  const { model, ui } = ctx;
  const ideas = model.ideasIn(s.id);                 // its sub-sections' ideas too
  const subs = [...model.sectionDescendants(s.id)].filter(id => id !== s.id);
  let choice = 'empty';
  if (ideas.length || subs.length) {
    const inside = [ideas.length ? plural(ideas.length, 'idea') : '', subs.length ? plural(subs.length, 'section') : ''].filter(Boolean).join(' and ');
    choice = await deleteWithContentsDialog({
      title: `Delete the section “${s.name}”?`,
      body: h('p', { text: `It has ${inside} inside${subs.length ? ' (the sections inside it are deleted with it)' : ''}.` }),
      keepLabel: ideas.length ? `Keep the ${plural(ideas.length, 'idea')}: move ${ideas.length === 1 ? 'it' : 'them'} to Not sorted` : 'Nothing else is deleted',
      keepButton: 'Delete section',
      allButton: ideas.length ? `Delete section and ${plural(ideas.length, 'idea')}` : 'Delete section',
    });
  } else {
    const ok = await confirmDialog({
      title: `Delete the section “${s.name}”?`,
      body: h('p', { text: "It's empty, so nothing else changes." }),
      confirm: 'Delete section', danger: true,
    });
    if (!ok) choice = null;
  }
  if (!choice) return;
  try {
    if (choice === 'all') {
      const used = new Set(ideas.flatMap(i => [...filesOfPage(i.data)]));
      for (const f of await store.files()) {
        if (used.has(f.path) || ideas.some(i => isFileOfPage(f.path, i.id))) await store.removeFile(f.path);
      }
      for (const i of ideas) await store.remove('ideas', i.id);
    } else {
      // Only the top ideas move; the ideas under them come along.
      for (const i of ideas) if (!model.parentOf(i.id)) await store.put('ideas', i.id, storableIdea({ ...i.data, section: null, parent: null }));
    }
    for (const id of [...subs, s.id]) await store.remove('sections', id);
  } catch (err) { errorDialog(err, "The section couldn't be deleted"); return; }
  toast(choice === 'all' && ideas.length
    ? `Section and ${plural(ideas.length, 'idea')} deleted. Push to remove them from GitHub too.`
    : ideas.length ? 'Section deleted; its ideas are in Not sorted now. Push to update GitHub.' : 'Section deleted. Push to remove it from GitHub too.');
  const here = id => ['list', 'map', 'draw'].some(v => location.hash === sectionHref(id, v));
  if (here(s.id) || subs.some(here)) ui.leaveTo(sectionPath(s.parent || 'all', ui.prefs.view));
}

/* ---------- Dragging ideas ---------- */

/**
 * Drag an idea by its ⋮⋮ handle (mouse or finger). Over another idea: its top or bottom edge
 * puts it next to that idea (a line shows where), the middle puts it under that idea (the
 * idea lights up). A section heading or a section in the left panel moves it there.
 * Everything under the dragged idea comes along. A tap without moving opens the ⋯ menu.
 */
function ideaDrag(el, handle, idea, ctx) {
  let dragged = false;
  handle.addEventListener('click', () => { if (dragged) { dragged = false; return; } ideaMenu(idea, handle, ctx); });
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const node = el.closest('.id-node');
    const startX = e.clientX, startY = e.clientY;
    let ghost = null, line = null, lit = null, drop = null, lastX = startX, lastY = startY, raf = 0, dx = 0, dy = 0;
    handle.setPointerCapture?.(e.pointerId);

    const light = x => { if (lit !== x) { lit?.classList.remove('is-drop-into'); lit = x; lit?.classList.add('is-drop-into'); } };
    function where() {
      const under = document.elementFromPoint(lastX, lastY);
      const item = under?.closest('.id-item');
      if (item && !node.contains(item)) {
        const r = item.getBoundingClientRect();
        const y = (lastY - r.top) / r.height;
        const id = item.dataset.idea;
        if (y < 0.28) return { to: { kind: 'before', id }, line: { x: r.left, y: r.top - 4, w: r.width } };
        if (y > 0.72 && !item.closest('.id-node').querySelector(':scope > .id-tree')) return { to: { kind: 'after', id }, line: { x: r.left, y: r.bottom + 2, w: r.width } };
        return { to: { kind: 'into', id }, lit: item };   // the middle (or the bottom of an open idea): under it
      }
      const head = under?.closest('.id-shead');
      const block = head?.closest('.id-sblock');
      if (block?.dataset.section) return { to: { kind: 'section', key: block.dataset.section === 'none' ? null : block.dataset.section }, lit: head };
      const link = under?.closest('.tk-flink');
      if (link && link.dataset.key && link.dataset.key !== 'all') return { to: { kind: 'section', key: link.dataset.key === 'none' ? null : link.dataset.key }, lit: link };
      return null;
    }
    const place = () => {
      ghost.style.transform = `translate(${lastX - dx}px, ${lastY - dy}px)`;
      const w = where();
      drop = w?.to || null;
      light(w?.lit || null);
      if (w?.line) {
        line.hidden = false;
        Object.assign(line.style, { left: `${w.line.x}px`, top: `${w.line.y}px`, width: `${w.line.w}px` });
      } else line.hidden = true;
    };
    const autoScroll = () => {
      const edge = 60;
      const vy = lastY < edge + 60 ? -(edge + 60 - lastY) / 4 : lastY > innerHeight - edge ? (lastY - (innerHeight - edge)) / 4 : 0;
      if (vy) { window.scrollBy(0, vy); place(); }
      raf = requestAnimationFrame(autoScroll);
    };
    const move = ev => {
      lastX = ev.clientX; lastY = ev.clientY;
      if (!ghost) {
        if (Math.hypot(lastX - startX, lastY - startY) < 6) return;
        const r = el.getBoundingClientRect();
        dx = startX - r.left; dy = startY - r.top;
        ghost = el.cloneNode(true);
        ghost.classList.add('id-ghost');
        ghost.style.width = `${Math.min(r.width, 420)}px`;
        line = h('div', { class: 'id-drop-line', hidden: true });
        document.body.append(ghost, line);
        node.classList.add('dragging');
        document.body.classList.add('is-dragging');
        raf = requestAnimationFrame(autoScroll);
      }
      ev.preventDefault();
      place();
    };
    const end = async ev => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      cancelAnimationFrame(raf);
      if (!ghost) return;
      dragged = true;
      setTimeout(() => { dragged = false; }, 0);
      ghost.remove(); line.remove();
      light(null);
      node.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      if (ev.type === 'pointercancel' || !drop) return;
      try {
        if (drop.kind === 'into') ctx.ui.unfold(drop.id);
        await moveIdeaTo(ctx.model, idea, drop);
      } catch (err) { errorDialog(err, "The idea couldn't be moved"); }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

/* ---------- The main screen ---------- */

function homeView(el, ctx, key, mode = 'list') {
  const { model, wiki, ui } = ctx;
  if (ui.prefs.view !== mode) { ui.prefs.view = mode; ui.savePrefs(); }
  if (key !== 'all' && key !== 'none' && !model.section(key)) {
    clear(el, topNav(ui, '', { href: '#/ideas', label: 'Ideas' }),
      h('div', { class: 'notice' }, h('p', { text: "This section doesn't exist (anymore)." })));
    return;
  }
  const title = sectionTitle(model, key);
  document.title = `${title} · Ideas · ${APP_TITLE}`;

  /* Quick capture */
  const addInput = h('input', {
    class: 'input tk-add-input', type: 'text', autocomplete: 'off', enterkeyhint: 'done', maxLength: 200,
    placeholder: 'Add an idea, then press Enter', 'aria-label': 'New idea', dataset: { focusKey: 'idea-add' },
  });
  async function add() {
    const t = addInput.value.trim();
    if (!t) { addInput.focus(); return; }
    addInput.value = '';
    try {
      await createIdea({ title: t, section: key === 'all' || key === 'none' ? null : key });
    } catch (err) { errorDialog(err, "The idea couldn't be saved"); }
  }
  addInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  /* Search */
  const search = h('input', {
    type: 'search', class: 'input tk-search', placeholder: 'Search', 'aria-label': 'Search ideas', value: ui.query || '',
    autocomplete: 'off', enterkeyhint: 'search', dataset: { focusKey: 'idea-search' },
  });
  search.addEventListener('input', () => { ui.query = search.value; drawContent(); });

  /* The ideas */
  const content = h('div', { class: 'id-content' });
  const all = model.ideasIn(key);
  const where = i => {
    const s = model.sectionOf(i);
    const sec = s ? model.path(s).map(x => x.name).join(' › ') : 'Not sorted';
    const up = model.ideaPath(i.id).map(x => x.data.title || '(no title)');
    return [sec, ...up].join(' › ');
  };
  function drawContent() {
    const q = (ui.query || '').trim();
    if (q) {
      const found = searchIdeas(all, model, wiki, q);
      clear(content, found.length
        ? [h('p', { class: 'muted small tk-count', text: `${plural(found.length, 'idea')} found.` }),
           h('ul', { class: 'id-tree id-top id-flat' }, found.map(i => ideaItem(i, ctx, { where: where(i), flat: true })))]
        : h('p', { class: 'muted tk-empty', text: 'No ideas match the search.' }));
      return;
    }
    if (key === 'all') {
      const tops = model.childrenOf(null);
      const loose = model.topIdeas(null);
      clear(content,
        !all.length && !tops.length ? h('p', { class: 'muted tk-empty', text: 'No ideas yet. Type one above and press Enter.' }) : null,
        tops.map(s => sectionBlock(s, ctx)),
        loose.length ? h('section', { class: 'id-sblock', dataset: { section: 'none' } },
          h('h2', { class: 'id-shead' }, h('span', { class: 'id-fold id-fold-none', 'aria-hidden': 'true' }), h('a', { href: sectionHref('none'), text: 'Not sorted' }),
            h('span', { class: 'id-scount', text: plural(model.count('none'), 'idea') })),
          outline(loose, ctx)) : null);
      return;
    }
    const own = model.topIdeas(key === 'none' ? null : key);
    const subs = key === 'none' ? [] : model.childrenOf(key);
    clear(content,
      outline(own, ctx),
      !own.length ? h('p', { class: 'muted tk-empty', text: subs.length ? 'No ideas straight in this section yet. Type one above and press Enter.' : 'Nothing here yet. Type an idea above and press Enter.' }) : null,
      subs.length ? h('div', { class: 'id-subs id-subs-top' }, subs.map(s => sectionBlock(s, ctx))) : null);
  }
  /* List, mind map or drawings */
  const viewBtn = (v, label, ic) => h('a', {
    class: 'seg-btn', role: 'button', 'aria-pressed': String(mode === v), href: sectionHref(key, v), dataset: { view: v },
    onclick: e => { e.preventDefault(); if (mode !== v) ui.switchTo(sectionPath(key, v)); },
  }, icon(ic, { size: 14 }), h('span', { class: 'seg-label', text: label }));
  const addRow = h('div', { class: 'tk-add' }, addInput,
    h('button', { type: 'button', class: 'btn btn-primary tk-add-btn', onclick: add, 'aria-label': 'Add' }, icon('plus', { size: 18 }), h('span', { class: 'tk-add-label', text: 'Add' })));
  let screen = null;
  if (mode === 'map') {
    screen = mapScreen(ctx, key, addRow);   // the add box goes with the map (it stays in full screen)
    clear(content, screen ? screen.el : h('p', { class: 'muted tk-empty', text: 'Nothing here yet. Type an idea above and press Enter.' }));
  } else if (mode === 'draw') {
    clear(content, galleryContent(ctx, key));
  } else {
    drawContent();
  }
  const here = key === 'all' || key === 'none' ? null : key;
  const openTabs = mode === 'draw' ? openDrawingTabs() : null;
  const stillOpen = openTabs ? openTabs.open.filter(id => ctx.drawings.get(id)) : [];
  const newDrawingRow = mode === 'draw' ? h('div', { class: 'dg-head' },
    h('button', { type: 'button', class: 'btn btn-primary', onclick: () => newDrawingDialog(ctx, { section: here }) },
      icon('plus', { size: 16 }), 'New drawing'),
    h('button', { type: 'button', class: 'btn', onclick: () => addReferenceFromDevice(ctx, { section: here }) },
      icon('image', { size: 16 }), 'Add a reference picture'),
    stillOpen.length ? h('a', {
      class: 'btn dg-open-tabs', href: `#/ideas/draw/${encodeURIComponent(stillOpen.includes(openTabs.active) ? openTabs.active : stillOpen[0])}`,
    }, icon('brush', { size: 16 }), `Open drawings (${stillOpen.length})`) : null) : null;

  const n = mode === 'draw' ? ctx.drawings.inSection(key, model).length : model.count(key);
  clear(el, h('div', { class: 'tk-layout id-layout' },
    sectionPanel(ctx, key),
    h('div', { class: 'tk-main' },
      key !== 'all' && key !== 'none'
        ? topNav(ui, model.section(key).parent ? sectionPath(model.section(key).parent, mode) : sectionPath('all', mode), { href: sectionHref('all', mode), label: 'Ideas' },
          ...model.path(key).slice(0, -1).map(s => ({ href: sectionHref(s.id, mode), label: s.name })), { label: title })
        : null,
      h('div', { class: 'tab-head tk-head' }, h('h1', { text: title }), h('span', { class: 'muted', text: plural(n, mode === 'draw' ? 'drawing' : 'idea') }),
        h('div', { class: 'seg head-action id-views', role: 'group', 'aria-label': 'View' }, viewBtn('list', 'List', 'tasks'), viewBtn('map', 'Map', 'mindmap'), viewBtn('draw', 'Drawings', 'brush'))),
      screen || mode === 'draw' ? newDrawingRow : addRow,
      mode === 'list' ? h('div', { class: 'tk-filters' }, search) : null,
      content)));
  screen?.mounted();
  return screen ? () => screen.cleanup() : null;
}
