// The Ideas tab's screens (part 2c Ideas, step 1: sections, the list and idea pages).
//
// Addresses (after #/ideas/):
//   (nothing)      all ideas, section by section
//   s/none         ideas without a section ("Not sorted")
//   s/<section>    a section (its sub-sections' ideas shown below its own)
//   i/<idea>       an idea's page (ideas/editor.js)
//
// The list is an outline: an idea that comes under another idea is indented below it, with a
// fold button. Which ideas are folded is remembered on this device (not synced).

import { h, clear, plural } from '../core/util.js';
import { store } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { openModal, confirmDialog, messageDialog, errorDialog, toast } from '../ui/dialogs.js';
import { sortable } from '../ui/drag.js';
import { openPopup } from '../wiki/popup.js';
import { topNav } from '../wiki/parts.js';
import { nameFor } from '../wiki/text.js';
import { orderBetween } from '../wiki/custom.js';
import { nameDialog } from '../tasks/views.js';
import { createIdea, newSectionId, searchIdeas } from './model.js';
import { ideaEditorView } from './editor.js';
import { sectionSelect, addUnderDialog, moveIdeaDialog, confirmDeleteIdea, removeIdea, makeTaskDialog } from './actions.js';

const APP_TITLE = "Batataman's Reimagined";

export function parseIdeasPath(path) {
  const [kind, a] = String(path || '').split('/').map(x => decodeURIComponent(x));
  if (kind === 'i' && a) return { view: 'idea', id: a };
  if (kind === 's' && a) return { view: 'list', section: a };
  return { view: 'list', section: 'all' };
}

export function renderIdeasView(el, path, ctx) {
  const route = parseIdeasPath(path);
  document.title = `Ideas · ${APP_TITLE}`;
  if (route.view === 'idea') return ideaEditorView(el, ctx, route.id);
  return homeView(el, ctx, route.section);
}

/* ---------- Small pieces ---------- */

const sectionHref = key => (key === 'all' ? '#/ideas' : `#/ideas/s/${encodeURIComponent(key)}`);
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
  return h('li', { class: 'id-node', dataset: { idea: idea.id } },
    h('div', { class: 'id-item' },
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
      more),
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
  const { model, ui } = ctx;
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
    class: 'tk-flink', href: sectionHref(k), 'aria-current': k === key ? 'page' : null,
    style: { '--depth': depth },
    onclick: () => { ui.sectionsOpen = false; },
  }, h('span', { class: 'tk-fname', text: label }), h('span', { class: 'tk-fcount', 'aria-label': plural(model.count(k), 'idea'), text: String(model.count(k) || '') }));

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

const saveSection = (s, change) => store.put('sections', s.id, { name: s.name, parent: s.parent, order: s.order, ...change });

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
      ui.go(`s/${id}`);
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
  const n = model.count(s.id);
  const subs = model.childrenOf(s.id).length;
  if (n || subs) {
    await messageDialog({
      title: `${s.name} isn't empty`,
      body: h('p', { text: `It has ${[n ? plural(n, 'idea') : '', subs ? plural(subs, 'section') : ''].filter(Boolean).join(' and ')} inside. Move or delete ${n + subs === 1 ? 'it' : 'them'} first.` }),
    });
    return;
  }
  const ok = await confirmDialog({
    title: `Delete the section “${s.name}”?`,
    body: h('p', { text: "It's empty, so nothing else changes." }),
    confirm: 'Delete section', danger: true,
  });
  if (!ok) return;
  await store.remove('sections', s.id);
  toast('Section deleted. Push to remove it from GitHub too.');
  if (location.hash === sectionHref(s.id)) ui.leaveTo(s.parent ? `s/${s.parent}` : '');
}

/* ---------- The main screen ---------- */

function homeView(el, ctx, key) {
  const { model, wiki, ui } = ctx;
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
        loose.length ? h('section', { class: 'id-sblock' },
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
  drawContent();

  const n = model.count(key);
  clear(el, h('div', { class: 'tk-layout id-layout' },
    sectionPanel(ctx, key),
    h('div', { class: 'tk-main' },
      key !== 'all' && key !== 'none'
        ? topNav(ui, model.section(key).parent ? `s/${model.section(key).parent}` : '', { href: '#/ideas', label: 'Ideas' },
          ...model.path(key).slice(0, -1).map(s => ({ href: sectionHref(s.id), label: s.name })), { label: title })
        : null,
      h('div', { class: 'tab-head tk-head' }, h('h1', { text: title }), h('span', { class: 'muted', text: plural(n, 'idea') })),
      h('div', { class: 'tk-add' }, addInput,
        h('button', { type: 'button', class: 'btn btn-primary tk-add-btn', onclick: add, 'aria-label': 'Add' }, icon('plus', { size: 18 }), h('span', { class: 'tk-add-label', text: 'Add' }))),
      h('div', { class: 'tk-filters' }, search),
      content)));
}
