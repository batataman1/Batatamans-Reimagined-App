// Customize (part 2b step 3): the wiki's groups, sub-groups and templates.
//
//   #/wiki/c            the lists: groups (drag ⋮⋮ to change their order) and templates
//   #/wiki/c/g/<id>     a group: name, icon, hidden, and its sub-groups (name, icon, template,
//                       order, hidden, add, delete). c/g/<id>/<sub> highlights that sub-group.
//   #/wiki/c/t/<id>     a template: name and fields (name, Text or Picture, order, add, remove)
//
// The group and template screens save by themselves, like the page editor. "Undo all changes"
// puts things back the way they were when the screen opened. Nothing here changes a page:
// pages keep whatever is written in them, even in fields their template no longer has.

import { h, clear, plural, humanizeKey } from '../core/util.js';
import { store } from '../core/store.js';
import { TEMPLATES } from '../config/wiki.js';
import { PICKABLE_ICONS } from '../config/icons.js';
import { icon } from '../ui/icons.js';
import { openModal, confirmDialog, messageDialog, errorDialog, toast } from '../ui/dialogs.js';
import { sortable } from '../ui/drag.js';
import { cleanFields } from './model.js';
import { topNav, safeIcon } from './parts.js';
import { openPopup, closePopup } from './popup.js';
import {
  groupDraft, builtinGroupDraft, builtinGroup, groupRecord, saveGroup,
  templateDraft, templateRecord, saveTemplate, freshId, freshKey, orderBetween,
} from './custom.js';

const APP_TITLE = "Batataman's Reimagined";

/* ---------- Shared bits ---------- */

const section = (title, ...content) => h('section', { class: 'ed-section' }, typeof title === 'string' ? h('h2', { text: title }) : title, content);

const formField = (label, control, hint) => h('label', { class: 'field' },
  h('span', { class: 'field-label', text: label }), control,
  hint ? h('span', { class: 'field-hint', text: hint }) : null);

/** Built-in templates in their usual order, then yours by name. */
function sortedTemplates(wiki) {
  const ids = Object.keys(TEMPLATES);
  return Object.values(wiki.templates).sort((a, b) =>
    (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1)
    || (a.builtin ? ids.indexOf(a.id) - ids.indexOf(b.id) : a.name.localeCompare(b.name)));
}

function templateSelect(wiki, value, label = 'Template') {
  const all = sortedTemplates(wiki);
  const mine = all.filter(t => t.custom);
  const sel = h('select', { class: 'input', 'aria-label': label },
    all.filter(t => t.builtin).map(t => h('option', { value: t.id, text: t.name })),
    mine.length ? h('optgroup', { label: 'Made by you' }, mine.map(t => h('option', { value: t.id, text: t.name }))) : null,
    value && !wiki.templates[value] ? h('option', { value, text: `${value} (missing)` }) : null);
  sel.value = value || 'item';
  return sel;
}

/** Ask for an icon. Resolves with its name, or null if the window was closed. */
export function pickIcon({ current, title = 'Choose an icon' }) {
  let m = null;
  const grid = h('div', { class: 'icon-grid', role: 'group', 'aria-label': title },
    PICKABLE_ICONS.map(([name, label]) => h('button', {
      type: 'button', class: 'icon-choice', title: label, 'aria-label': label,
      'aria-pressed': String(name === current), dataset: { icon: name },
      onclick: () => m.close(name),
    }, icon(name, { size: 28 }))));
  m = openModal({
    title, body: grid, className: 'modal-icons',
    onOpen: d => d.querySelector('.icon-choice[aria-pressed="true"]')?.focus(),
  });
  return m.result;
}

/** A button showing an icon; tapping it opens the icon picker. */
function iconButton(current, what, onPick) {
  return h('button', {
    type: 'button', class: 'icon-pick', title: 'Change the icon', 'aria-label': `Icon of ${what}. Change it`,
    dataset: { icon: current },
    onclick: async () => {
      const name = await pickIcon({ current, title: `Icon for ${what}` });
      if (name && name !== current) onPick(name);
    },
  }, safeIcon(current, 24));
}

const tag = (text, cls = '') => h('span', { class: `tag ${cls}`.trim(), text });

function groupTags(g) {
  return [
    g.hidden ? tag('Hidden', 'tag-hidden') : null,
    g.builtin && g.changed ? tag('Changed', 'tag-changed') : null,
    g.builtin ? null : tag('Made by you', 'tag-mine'),
  ];
}

function notFound(el, ui, what) {
  clear(el,
    topNav(ui, 'c', { href: '#/wiki', label: 'Wiki' }, { href: '#/wiki/c', label: 'Customize' }),
    h('div', { class: 'notice' }, h('p', { text: `${what} doesn't exist (anymore).` })));
}

/**
 * Saving by itself, like the page editor: a change waits 400 ms, then save(copy) runs.
 * Returns { changed, flush, stop, status }.
 */
function autosaver(save) {
  let timer = null, pending = false, stopped = false, saving = Promise.resolve(), current = null;
  const status = h('span', { class: 'ed-status', role: 'status', text: 'Changes save by themselves' });
  const flush = () => {
    clearTimeout(timer);
    if (!pending || stopped) return saving;
    pending = false;
    const job = current();
    saving = saving
      .then(job)
      .then(() => { if (!pending) status.textContent = 'Saved on this device'; })
      .catch(err => { status.textContent = 'Not saved'; errorDialog(err, "Your change couldn't be saved"); });
    return saving;
  };
  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  return {
    status,
    /** Something changed; getJob() returns the function that saves it (called at save time). */
    changed(getJob = save) {
      current = getJob;
      pending = true;
      status.textContent = 'Saving…';
      clearTimeout(timer);
      timer = setTimeout(flush, 400);
    },
    flush,
    /** Stop saving (the thing was deleted), after anything already started is done. */
    async stop() { stopped = true; clearTimeout(timer); await saving; },
    detach() {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    },
  };
}

function editBar(title, status, undoAll, done) {
  return h('div', { class: 'ed-bar' },
    h('span', { class: 'ed-bar-title' }, icon('edit', { size: 18 }), h('span', { text: title })),
    status,
    h('span', { class: 'ed-bar-actions' },
      h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: undoAll }, 'Undo all changes'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: done }, 'Done')));
}

/** A row's ⋯ menu (also opened by tapping its ⋮⋮ handle). items without onPick are left out. */
function rowMenu(anchor, title, items) {
  openPopup({ rect: anchor.getBoundingClientRect(), title, items: items.filter(Boolean) });
}

/* ---------- The Customize screen ---------- */

export function customizeView(el, wiki, ui) {
  document.title = `Customize · ${APP_TITLE}`;

  const groups = h('div', { class: 'cz-list' }, wiki.groups.map((g, i) => {
    const handle = h('button', {
      type: 'button', class: 'sort-handle', 'aria-label': `Move ${g.name}`, title: 'Drag to change the order. Tap to move up or down',
      onclick: () => rowMenu(handle, g.name, [
        i > 0 ? { label: 'Move up', onPick: () => moveGroup(wiki, i, i - 1) } : null,
        i < wiki.groups.length - 1 ? { label: 'Move down', onPick: () => moveGroup(wiki, i, i + 1) } : null,
        { label: 'Edit group', icon: 'edit', onPick: () => ui.go(`c/g/${g.id}`) },
      ]),
    }, '⋮⋮');
    return h('div', { class: `cz-row sort-row${g.hidden ? ' is-hidden' : ''}`, dataset: { group: g.id } },
      handle,
      h('a', { class: 'cz-link', href: `#/wiki/c/g/${g.id}` },
        h('span', { class: 'cz-icon' }, safeIcon(g.icon, 24)),
        h('span', { class: 'cz-text' },
          h('span', { class: 'cz-name' }, h('span', { text: g.name }), groupTags(g)),
          h('span', { class: 'cz-sub', text: g.subgroups.length
            ? `${g.subgroups.map(s => s.name).join(' · ')} · ${plural(wiki.allIn(g.id), 'page')}`
            : 'No sub-groups yet' })),
        h('span', { class: 'cz-go', 'aria-hidden': 'true', text: '›' })));
  }));
  sortable(groups, { onMove: (from, to) => moveGroup(wiki, from, to) });

  const templates = h('div', { class: 'cz-list' }, sortedTemplates(wiki).map(t => {
    const users = wiki.usersOf(t.id);
    return h('a', { class: 'cz-row cz-link cz-tpl', href: `#/wiki/c/t/${t.id}`, dataset: { template: t.id } },
      h('span', { class: 'cz-icon' }, safeIcon(users[0]?.sub.icon || 'book', 24)),
      h('span', { class: 'cz-text' },
        h('span', { class: 'cz-name' }, h('span', { text: t.name }),
          t.builtin && t.changed ? tag('Changed', 'tag-changed') : null,
          t.custom ? tag('Made by you', 'tag-mine') : null),
        h('span', { class: 'cz-sub', text: `${plural(t.fields.length, 'field')} · ${users.length
          ? `used by ${users.map(u => u.sub.name).join(', ')}`
          : 'not used by any sub-group'}` })),
      h('span', { class: 'cz-go', 'aria-hidden': 'true', text: '›' }));
  }));

  clear(el,
    topNav(ui, '', { href: '#/wiki', label: 'Wiki' }, { label: 'Customize' }),
    h('div', { class: 'tab-head' }, h('h1', { text: 'Customize the wiki' })),
    h('p', { class: 'muted cz-intro', text: 'Change the groups, sub-groups and templates. Changes save on this device; Push sends them to your other devices. Nothing written on pages is changed here.' }),
    h('section', { class: 'wiki-section' },
      h('div', { class: 'cz-head' }, h('h2', { text: 'Groups' }),
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => newGroupDialog(wiki, ui) }, icon('plus', { size: 16 }), 'Add group')),
      h('p', { class: 'muted small cz-hint', text: 'Drag ⋮⋮ to change the order on the Wiki start. Tap a group to rename it, change its icon, hide it or change its sub-groups.' }),
      groups),
    h('section', { class: 'wiki-section' },
      h('div', { class: 'cz-head' }, h('h2', { text: 'Templates' }),
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => newTemplateDialog(wiki, ui) }, icon('plus', { size: 16 }), 'New template')),
      h('p', { class: 'muted small cz-hint', text: "A sub-group's template decides which fields its pages have in the info box." }),
      templates));
}

/** Move a group in the list. Only the moved group is saved, unless every group needs new numbers. */
async function moveGroup(wiki, from, to) {
  const list = [...wiki.groups];
  const [g] = list.splice(from, 1);
  list.splice(to, 0, g);
  const before = list[to - 1]?.order ?? null;
  const after = list[to + 1]?.order ?? null;
  const order = orderBetween(before, after);
  try {
    if ((before !== null && !(order > before)) || (after !== null && !(order < after))) {
      // No room left between them: number every group again (10, 20, 30…).
      for (const [i, x] of list.entries()) {
        const d = groupDraft(x);
        if (d.order !== (i + 1) * 10) await saveGroup({ ...d, order: (i + 1) * 10 });
      }
    } else {
      await saveGroup({ ...groupDraft(g), order });
    }
  } catch (err) {
    errorDialog(err, "The new order couldn't be saved");
  }
}

function newGroupDialog(wiki, ui) {
  const nameInput = h('input', { class: 'input', name: 'name', autocomplete: 'off', placeholder: 'For example: Vehicles', maxLength: 60 });
  let chosen = 'book';
  const iconHost = h('div', { class: 'icon-field' });
  const drawIcon = () => clear(iconHost,
    iconButton(chosen, 'the new group', n => { chosen = n; drawIcon(); }),
    h('span', { class: 'muted small', text: 'Tap to choose another icon.' }));
  drawIcon();
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const fail = text => { error.textContent = text; error.hidden = false; };

  async function create(close) {
    error.hidden = true;
    const n = nameInput.value.trim();
    if (!n) return fail('Give the group a name.');
    if (wiki.groups.some(g => g.name.toLowerCase() === n.toLowerCase())) return fail(`There's already a group called “${n}”.`);
    const id = freshId(n, new Set(wiki.groups.map(g => g.id)), 'group');
    const order = Math.max(0, ...wiki.groups.map(g => g.order)) + 10;
    try {
      await saveGroup({ id, name: n, icon: chosen, order, hidden: false, subgroups: [] });
    } catch (err) { return fail(err.message || String(err)); }
    close('created');
    ui.go(`c/g/${id}`);
  }

  const m = openModal({
    title: 'Add group',
    body: h('div', { class: 'connect-form' },
      formField('Name', nameInput),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Icon' }), iconHost),
      h('p', { class: 'muted small', text: 'Next you can add its sub-groups. Pages go into sub-groups.' }),
      error),
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'create', label: 'Add group', kind: 'primary', onClick: create },
    ],
    onOpen: () => nameInput.focus(),
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(m.close); } });
  return m.result;
}

function newTemplateDialog(wiki, ui) {
  const nameInput = h('input', { class: 'input', name: 'name', autocomplete: 'off', placeholder: 'For example: Vehicle', maxLength: 60 });
  const from = h('select', { class: 'input', name: 'from', 'aria-label': 'Start from' },
    h('option', { value: '', text: 'Blank (no fields yet)' }),
    sortedTemplates(wiki).map(t => h('option', { value: t.id, text: `A copy of ${t.name} (${plural(t.fields.length, 'field')})` })));
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const fail = text => { error.textContent = text; error.hidden = false; };

  async function create(close) {
    error.hidden = true;
    const n = nameInput.value.trim();
    if (!n) return fail('Give the template a name.');
    if (Object.values(wiki.templates).some(t => t.name.toLowerCase() === n.toLowerCase())) return fail(`There's already a template called “${n}”.`);
    const id = freshId(n, new Set(Object.keys(wiki.templates)), 'template');
    const fields = from.value ? structuredClone(wiki.templates[from.value].fields) : [];
    try {
      await store.put('templates', id, templateRecord({ id, name: n, fields }));
    } catch (err) { return fail(err.message || String(err)); }
    close('created');
    ui.go(`c/t/${id}`);
  }

  const m = openModal({
    title: 'New template',
    body: h('div', { class: 'connect-form' },
      formField('Name', nameInput),
      formField('Start from', from, 'You can add, rename and remove fields next.'),
      error),
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'create', label: 'Make template', kind: 'primary', onClick: create },
    ],
    onOpen: () => nameInput.focus(),
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(m.close); } });
  return m.result;
}

/* ---------- A group and its sub-groups ---------- */

export function groupEditorView(el, wiki, ui, groupId, focusSub) {
  const g = wiki.group(groupId);
  if (!g) return notFound(el, ui, 'This group');
  const original = groupDraft(g);
  let draft = groupDraft(g);
  const builtin = builtinGroupDraft(groupId);         // null for a group you made
  const builtinSubs = new Set((builtinGroup(groupId)?.subgroups || []).map(s => s.id));
  const count = subId => wiki.pagesIn(groupId, subId).length;
  let gone = false;

  const saver = autosaver(() => { const d = structuredClone(draft); return () => saveGroup(d, { source: 'editor' }); });
  const changed = () => saver.changed();
  document.title = `Editing ${g.name} · ${APP_TITLE}`;

  async function done() {
    await saver.flush();
    ui.finishCustom('c');
  }

  async function undoAll() {
    const ok = await confirmDialog({
      title: 'Undo all changes?',
      body: h('p', { text: 'The group and its sub-groups go back to how they were when you opened this screen.' }),
      confirm: 'Undo all changes',
    });
    if (!ok) return;
    draft = structuredClone(original);
    changed();
    render();
  }

  /* Basics */

  const basicsHost = h('div', { class: 'cz-basics' });
  function drawBasics() {
    clear(basicsHost,
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Icon' }),
        h('div', { class: 'icon-field' },
          iconButton(draft.icon, 'this group', n => { draft.icon = n; changed(); drawBasics(); }),
          h('span', { class: 'muted small', text: 'Shown on the Wiki start.' }))),
      h('label', { class: 'ed-check' },
        h('input', { type: 'checkbox', name: 'hidden', checked: draft.hidden, onchange: e => { draft.hidden = e.target.checked; changed(); } }),
        h('span', { text: 'Hide this group on the Wiki start' })),
      h('p', { class: 'muted small cz-check-hint', text: 'Its pages stay where they are and still open from links and search.' }));
  }

  /* Sub-groups */

  const subsTitle = h('h2');
  const subsHost = h('div', { class: 'cz-subs' });

  function drawSubs() {
    subsTitle.textContent = `Sub-groups (${draft.subgroups.length})`;
    const list = h('div', { class: 'cz-sublist' }, draft.subgroups.map((s, i) => subRow(s, i)));
    sortable(list, {
      onMove: (from, to) => {
        const [x] = draft.subgroups.splice(from, 1);
        draft.subgroups.splice(to, 0, x);
        changed();
        drawSubs();
      },
    });
    clear(subsHost,
      h('p', { class: 'muted small cz-hint', text: "Drag ⋮⋮ to change the order. A sub-group's template decides which fields its pages have." }),
      draft.subgroups.length ? list : h('p', { class: 'muted', text: 'No sub-groups yet. Pages go into sub-groups, so add at least one.' }),
      h('button', { type: 'button', class: 'btn btn-small', onclick: addSub }, icon('plus', { size: 16 }), 'Add sub-group'));
  }

  function moveSub(i, j) {
    const list = draft.subgroups;
    [list[i], list[j]] = [list[j], list[i]];
    changed();
    drawSubs();
  }

  function subMenu(s, i, anchor) {
    const mine = !builtinSubs.has(s.id);
    rowMenu(anchor, s.name || 'Sub-group', [
      i > 0 ? { label: 'Move up', onPick: () => moveSub(i, i - 1) } : null,
      i < draft.subgroups.length - 1 ? { label: 'Move down', onPick: () => moveSub(i, i + 1) } : null,
      { label: s.hidden ? 'Show again' : 'Hide', icon: 'eye', onPick: () => { s.hidden = !s.hidden; changed(); drawSubs(); } },
      wiki.templates[s.template] ? { label: `Edit the ${wiki.templates[s.template].name} template`, icon: 'sliders', onPick: () => ui.go(`c/t/${s.template}`) } : null,
      mine ? { label: 'Delete sub-group', icon: 'trash', onPick: () => deleteSub(s) } : null,
    ]);
  }

  async function deleteSub(s) {
    const n = count(s.id);
    if (n) {
      await messageDialog({
        title: `${s.name} still has pages`,
        body: [
          h('p', { text: `Move its ${plural(n, 'page')} to another sub-group first (open the page, Edit, Goes in), then delete it.` }),
          h('p', { class: 'muted', text: 'Or hide it instead: its pages stay where they are.' }),
        ],
      });
      return;
    }
    const ok = await confirmDialog({
      title: `Delete “${s.name}”?`,
      body: h('p', { text: 'It has no pages, so nothing else changes.' }),
      confirm: 'Delete sub-group', danger: true,
    });
    if (!ok) return;
    draft.subgroups = draft.subgroups.filter(x => x !== s);
    changed();
    drawSubs();
  }

  function subRow(s, i) {
    const n = count(s.id);
    const tpl = templateSelect(wiki, s.template, `Template of ${s.name}`);
    tpl.addEventListener('change', async () => {
      const next = tpl.value;
      const name = wiki.templates[next]?.name || next;
      if (n) {
        const ok = await confirmDialog({
          title: `Use the ${name} template for ${s.name}?`,
          body: [
            h('p', { text: `The ${plural(n, 'page')} in ${s.name} will show the ${name} template's fields in the info box.` }),
            h('p', { class: 'muted', text: "Anything already written on those pages stays. Fields the new template doesn't have still show on the page, marked as from a different template in the editor." }),
          ],
          confirm: 'Change template',
        });
        if (!ok) { tpl.value = s.template; return; }
      }
      s.template = next;
      changed();
    });
    const handle = h('button', {
      type: 'button', class: 'sort-handle', 'aria-label': `Move ${s.name}`, title: 'Drag to move. Tap for more',
      onclick: () => subMenu(s, i, handle),
    }, '⋮⋮');
    const more = h('button', {
      type: 'button', class: 'icon-btn cz-more', 'aria-label': `More for ${s.name}`, title: 'Hide, delete, move, edit template',
      onclick: () => subMenu(s, i, more),
    }, '⋯');
    return h('div', {
      class: `cz-subrow sort-row${s.hidden ? ' is-hidden' : ''}${focusSub === s.id ? ' is-focus' : ''}`,
      dataset: { sub: s.id },
    },
      handle,
      iconButton(s.icon, s.name || 'this sub-group', name => { s.icon = name; changed(); drawSubs(); }),
      h('input', {
        class: 'input cz-subname', value: s.name, placeholder: 'Sub-group name', 'aria-label': `Name of sub-group ${i + 1}`, maxLength: 60,
        oninput: e => { s.name = e.target.value; changed(); },
      }),
      h('span', { class: 'cz-subtpl' }, tpl),
      h('span', { class: 'cz-subinfo' },
        h('a', { class: 'small', href: `#/wiki/g/${groupId}/${s.id}`, text: plural(n, 'page'), title: 'Open this sub-group' }),
        s.hidden ? tag('Hidden', 'tag-hidden') : null),
      more);
  }

  async function addSub() {
    const s = await newSubgroupDialog(wiki, draft);
    if (!s) return;
    draft.subgroups.push(s);
    changed();
    drawSubs();
  }

  /* Reset or delete */

  const dangerHost = h('section', { class: 'ed-section ed-danger' });
  function drawDanger() {
    if (builtin) {
      clear(dangerHost,
        h('button', { type: 'button', class: 'btn btn-small btn-danger-outline', onclick: resetGroup }, 'Reset to built-in'),
        h('p', { class: 'muted small', text: 'Puts the name, icon, place in the list and sub-groups back to how they came with the app.' }));
    } else {
      clear(dangerHost,
        h('button', { type: 'button', class: 'btn btn-small btn-danger-outline', onclick: deleteGroup }, icon('trash', { size: 16 }), 'Delete this group'),
        h('p', { class: 'muted small', text: 'Only possible when none of its sub-groups have pages.' }));
    }
  }

  async function resetGroup() {
    if (!groupRecord(draft)) { toast('This group is already the way it came.'); return; }
    const stuck = draft.subgroups.filter(s => !builtinSubs.has(s.id) && count(s.id));
    if (stuck.length) {
      await messageDialog({
        title: 'Some of your sub-groups have pages',
        body: h('p', { text: `${stuck.map(s => `${s.name} (${plural(count(s.id), 'page')})`).join(', ')} would be removed by a reset. Move those pages to another sub-group first.` }),
      });
      return;
    }
    const ok = await confirmDialog({
      title: `Reset ${draft.name || g.name}?`,
      body: [
        h('p', { text: 'The name, icon, place in the list, hidden or not, and the sub-groups go back to how they came with the app.' }),
        h('p', { class: 'muted', text: 'Pages are not changed. Undo all changes brings your version back while this screen is open.' }),
      ],
      confirm: 'Reset to built-in', danger: true,
    });
    if (!ok) return;
    draft = structuredClone(builtin);
    changed();
    render();
  }

  async function deleteGroup() {
    const n = draft.subgroups.reduce((sum, s) => sum + count(s.id), 0);
    if (n) {
      await messageDialog({
        title: `${draft.name || g.name} still has pages`,
        body: h('p', { text: `Move its ${plural(n, 'page')} to another group first (open the page, Edit, Goes in), then delete it. Or hide the group instead.` }),
      });
      return;
    }
    const ok = await confirmDialog({
      title: `Delete “${draft.name || g.name}”?`,
      body: h('p', { text: 'The group and its sub-groups are removed from this device now, and from GitHub when you push.' }),
      confirm: 'Delete group', danger: true,
    });
    if (!ok) return;
    gone = true;
    await saver.stop();
    try {
      await store.remove('groups', groupId);
    } catch (err) { errorDialog(err, "The group couldn't be deleted"); return; }
    toast('Group deleted. Push to remove it from GitHub too.');
    ui.leaveTo('c');
  }

  /* The screen */

  function render() {
    clear(el,
      topNav(ui, 'c', { href: '#/wiki', label: 'Wiki' }, { href: '#/wiki/c', label: 'Customize' }, { href: `#/wiki/g/${groupId}`, label: draft.name || g.name }),
      editBar('Editing group', saver.status, undoAll, done),
      h('input', {
        class: 'input ed-name', name: 'group-name', value: draft.name, placeholder: 'Group name', 'aria-label': 'Group name', maxLength: 60,
        oninput: e => { draft.name = e.target.value; changed(); },
      }),
      section('Basics', basicsHost),
      section(subsTitle, subsHost),
      dangerHost);
    drawBasics();
    drawSubs();
    drawDanger();
  }

  render();
  if (focusSub) {
    // After the tab has scrolled to the top: show the sub-group you came from.
    setTimeout(() => el.querySelector(`.cz-subrow[data-sub="${CSS.escape(focusSub)}"]`)?.scrollIntoView({ block: 'nearest' }), 60);
  }

  return async () => {
    saver.detach();
    closePopup();
    if (!gone) await saver.flush();
  };
}

/** Ask for a new sub-group's name, icon and template. Resolves with it, or null. */
function newSubgroupDialog(wiki, draft) {
  const nameInput = h('input', { class: 'input', name: 'name', autocomplete: 'off', placeholder: 'For example: Aquatic', maxLength: 60 });
  // The template most sub-groups here use, as a starting guess.
  const used = new Map();
  for (const s of draft.subgroups) used.set(s.template, (used.get(s.template) || 0) + 1);
  const guess = [...used.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'item';
  const tpl = templateSelect(wiki, guess);
  tpl.name = 'template';
  let chosen = draft.icon || 'book';
  const iconHost = h('div', { class: 'icon-field' });
  const drawIcon = () => clear(iconHost,
    iconButton(chosen, 'the new sub-group', n => { chosen = n; drawIcon(); }),
    h('span', { class: 'muted small', text: 'Tap to choose another icon.' }));
  drawIcon();
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const fail = text => { error.textContent = text; error.hidden = false; };
  let result = null;

  function create(close) {
    error.hidden = true;
    const n = nameInput.value.trim();
    if (!n) return fail('Give the sub-group a name.');
    if (draft.subgroups.some(s => s.name.trim().toLowerCase() === n.toLowerCase())) return fail(`There's already a sub-group called “${n}” here.`);
    const id = freshId(n, new Set(draft.subgroups.map(s => s.id)), 'sub');
    result = { id, name: n, template: tpl.value, icon: chosen, hidden: false };
    close('created');
  }

  const m = openModal({
    title: `Add a sub-group to ${draft.name || 'this group'}`,
    body: h('div', { class: 'connect-form' },
      formField('Name', nameInput),
      formField('Template', tpl, 'Which fields its pages have in the info box.'),
      h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Icon' }), iconHost),
      error),
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'create', label: 'Add sub-group', kind: 'primary', onClick: create },
    ],
    onOpen: () => nameInput.focus(),
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(m.close); } });
  return m.result.then(() => result);
}

/* ---------- A template ---------- */

export function templateEditorView(el, wiki, ui, id) {
  const t = wiki.templates[id];
  if (!t) return notFound(el, ui, 'This template');
  const original = templateDraft(id, t);
  let draft = templateDraft(id, t);
  const builtin = TEMPLATES[id] ? templateDraft(id, { name: TEMPLATES[id].name, fields: cleanFields(TEMPLATES[id].fields) }) : null;
  const users = wiki.usersOf(id);
  const pagesUsing = users.reduce((n, u) => n + u.count, 0);
  let gone = false;

  const saver = autosaver(() => { const d = structuredClone(draft); return () => saveTemplate(d, { source: 'editor' }); });
  const changed = () => saver.changed();
  document.title = `Editing the ${t.name} template · ${APP_TITLE}`;

  async function done() {
    await saver.flush();
    ui.finishCustom('c');
  }

  async function undoAll() {
    const ok = await confirmDialog({
      title: 'Undo all changes?',
      body: h('p', { text: 'The template goes back to how it was when you opened this screen.' }),
      confirm: 'Undo all changes',
    });
    if (!ok) return;
    draft = structuredClone(original);
    changed();
    render();
  }

  /* Fields */

  const fieldsTitle = h('h2');
  const fieldsHost = h('div', { class: 'cz-fields' });

  function drawFields() {
    fieldsTitle.textContent = `Fields (${draft.fields.length})`;
    const list = h('div', { class: 'cz-fieldlist' }, draft.fields.map((f, i) => fieldRow(f, i)));
    sortable(list, {
      onMove: (from, to) => {
        const [x] = draft.fields.splice(from, 1);
        draft.fields.splice(to, 0, x);
        changed();
        drawFields();
      },
    });
    clear(fieldsHost,
      h('p', { class: 'muted small cz-hint', text: 'Drag ⋮⋮ to change the order in the info box. Renaming a field keeps what pages have written in it.' }),
      draft.fields.length ? list : h('p', { class: 'muted', text: 'No fields yet.' }),
      h('button', { type: 'button', class: 'btn btn-small', onclick: addField }, icon('plus', { size: 16 }), 'Add field'),
      h('p', { class: 'muted small cz-hint cz-remove-note', text: "Removing a field doesn't delete what pages already have in it: it still shows on those pages, and their editor marks it as from a different template." }));
  }

  function moveField(i, j) {
    [draft.fields[i], draft.fields[j]] = [draft.fields[j], draft.fields[i]];
    changed();
    drawFields();
  }

  function fieldMenu(f, i, anchor) {
    rowMenu(anchor, f.label || humanizeKey(f.key), [
      i > 0 ? { label: 'Move up', onPick: () => moveField(i, i - 1) } : null,
      i < draft.fields.length - 1 ? { label: 'Move down', onPick: () => moveField(i, i + 1) } : null,
      { label: 'Remove field', icon: 'trash', onPick: () => { draft.fields.splice(i, 1); changed(); drawFields(); } },
    ]);
  }

  function fieldRow(f, i) {
    const kind = h('select', { class: 'input', 'aria-label': `Kind of field ${i + 1}` },
      h('option', { value: 'text', text: 'Text' }),
      h('option', { value: 'image', text: 'Picture or GIF' }));
    kind.value = f.kind === 'image' ? 'image' : 'text';
    kind.addEventListener('change', () => {
      if (kind.value === 'image') f.kind = 'image'; else delete f.kind;
      changed();
    });
    const handle = h('button', {
      type: 'button', class: 'sort-handle', 'aria-label': `Move ${f.label || 'field'}`, title: 'Drag to move. Tap for more',
      onclick: () => fieldMenu(f, i, handle),
    }, '⋮⋮');
    const more = h('button', {
      type: 'button', class: 'icon-btn cz-more', 'aria-label': `More for ${f.label || 'field'}`, title: 'Move or remove',
      onclick: () => fieldMenu(f, i, more),
    }, '⋯');
    return h('div', { class: 'cz-fieldrow sort-row', dataset: { key: f.key } },
      handle,
      h('input', {
        class: 'input cz-fieldname', value: f.label, placeholder: humanizeKey(f.key), 'aria-label': `Name of field ${i + 1}`, maxLength: 60,
        oninput: e => { f.label = e.target.value; changed(); },
      }),
      h('span', { class: 'cz-fieldkind' }, kind),
      more);
  }

  async function addField() {
    const f = await newFieldDialog(draft);
    if (!f) return;
    draft.fields.push(f);
    changed();
    drawFields();
  }

  /* Reset or delete */

  const dangerHost = h('section', { class: 'ed-section ed-danger' });
  function drawDanger() {
    if (builtin) {
      clear(dangerHost,
        h('button', { type: 'button', class: 'btn btn-small btn-danger-outline', onclick: resetTemplate }, 'Reset to built-in'),
        h('p', { class: 'muted small', text: 'Puts the name and fields back to how they came with the app. Pages keep what they have written.' }));
    } else {
      clear(dangerHost,
        h('button', { type: 'button', class: 'btn btn-small btn-danger-outline', onclick: deleteTemplate }, icon('trash', { size: 16 }), 'Delete this template'),
        h('p', { class: 'muted small', text: 'Only possible when no sub-group uses it.' }));
    }
  }

  async function resetTemplate() {
    if (!templateRecord(draft)) { toast('This template is already the way it came.'); return; }
    const ok = await confirmDialog({
      title: `Reset the ${draft.name || t.name} template?`,
      body: [
        h('p', { text: 'The name and fields go back to how they came with the app.' }),
        h('p', { class: 'muted', text: 'Pages keep what they have written. Undo all changes brings your version back while this screen is open.' }),
      ],
      confirm: 'Reset to built-in', danger: true,
    });
    if (!ok) return;
    draft = structuredClone(builtin);
    changed();
    render();
  }

  async function deleteTemplate() {
    if (users.length) {
      await messageDialog({
        title: 'This template is in use',
        body: h('p', { text: `${users.map(u => `${u.group.name} › ${u.sub.name}`).join(', ')} use${users.length === 1 ? 's' : ''} it. Choose another template for ${users.length === 1 ? 'it' : 'them'} first (Customize → the group).` }),
      });
      return;
    }
    const ok = await confirmDialog({
      title: `Delete the ${draft.name || t.name} template?`,
      body: h('p', { text: 'No sub-group uses it, so nothing else changes. It is removed from GitHub when you push.' }),
      confirm: 'Delete template', danger: true,
    });
    if (!ok) return;
    gone = true;
    await saver.stop();
    try {
      await store.remove('templates', id);
    } catch (err) { errorDialog(err, "The template couldn't be deleted"); return; }
    toast('Template deleted. Push to remove it from GitHub too.');
    ui.leaveTo('c');
  }

  /* The screen */

  function render() {
    const name = draft.name || t.name;
    clear(el,
      topNav(ui, 'c', { href: '#/wiki', label: 'Wiki' }, { href: '#/wiki/c', label: 'Customize' }, { label: `${name} template` }),
      editBar('Editing template', saver.status, undoAll, done),
      h('input', {
        class: 'input ed-name', name: 'template-name', value: draft.name, placeholder: 'Template name', 'aria-label': 'Template name', maxLength: 60,
        oninput: e => { draft.name = e.target.value; changed(); },
      }),
      section('Used by', users.length
        ? [
            h('div', { class: 'link-chips' }, users.map(u => h('a', { class: 'wlink', href: `#/wiki/g/${u.group.id}/${u.sub.id}`, text: `${u.group.name} › ${u.sub.name} (${u.count})` }))),
            h('p', { class: 'muted small cz-hint', text: `Changes here show on ${plural(pagesUsing, 'page')}.` }),
          ]
        : h('p', { class: 'muted', text: 'No sub-group uses this template yet. Choose it for a sub-group in Customize → a group.' })),
      section(fieldsTitle, fieldsHost),
      dangerHost);
    drawFields();
    drawDanger();
  }

  render();

  return async () => {
    saver.detach();
    closePopup();
    if (!gone) await saver.flush();
  };
}

/** Ask for a new field's name and kind. Resolves with { key, label, kind? }, or null. */
function newFieldDialog(draft) {
  const nameInput = h('input', { class: 'input', name: 'name', autocomplete: 'off', placeholder: 'For example: Max speed', maxLength: 60 });
  const kind = h('select', { class: 'input', name: 'kind', 'aria-label': 'Kind' },
    h('option', { value: 'text', text: 'Text (can have links to pages)' }),
    h('option', { value: 'image', text: 'Picture or GIF (like a crafting recipe)' }));
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  let result = null;

  function create(close) {
    const n = nameInput.value.trim();
    if (!n) { error.textContent = 'Give the field a name.'; error.hidden = false; return; }
    const key = freshKey(n, new Set(draft.fields.map(f => f.key)));
    result = { key, label: n, ...(kind.value === 'image' ? { kind: 'image' } : {}) };
    close('created');
  }

  const m = openModal({
    title: 'Add field',
    body: h('div', { class: 'connect-form' }, formField('Name', nameInput), formField('Kind', kind), error),
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'create', label: 'Add field', kind: 'primary', onClick: create },
    ],
    onOpen: () => nameInput.focus(),
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(m.close); } });
  return m.result.then(() => result);
}
