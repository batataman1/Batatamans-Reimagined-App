// Things done to ideas from more than one screen: the section and "comes under" pickers,
// adding an idea under another, moving, deleting, and making a task from an idea.

import { h, clear, plural, uid } from '../core/util.js';
import { store } from '../core/store.js';
import { openModal, confirmDialog, toast, errorDialog } from '../ui/dialogs.js';
import { icon } from '../ui/icons.js';
import { goCrossTab } from '../ui/nav.js';
import { filesOfPage, isFileOfPage } from '../wiki/images.js';
import { nameFor } from '../wiki/text.js';
import { getWiki } from '../wiki/model.js';
import { TYPES, PRIORITIES, DIFFICULTIES, DIFFICULTY_HINTS, getTasks, createTask, newTaskId, updateTask } from '../tasks/model.js';
import { folderSelect } from '../tasks/actions.js';
import { nameDialog } from '../tasks/views.js';
import { createIdea, updateIdea } from './model.js';

/** A dropdown of the sections, indented like the tree. value '' = Not sorted. */
export function sectionSelect(model, value, { none = 'Not sorted', exclude = new Set(), name = 'section', label = 'Section' } = {}) {
  const sel = h('select', { class: 'input', name, 'aria-label': label },
    h('option', { value: '', text: none }),
    model.tree().filter(({ section }) => !exclude.has(section.id)).map(({ section, depth }) =>
      h('option', { value: section.id, text: `${' '.repeat(depth)}${section.name}` })));
  sel.value = value && model.section(value) && !exclude.has(value) ? value : '';
  return sel;
}

/**
 * The ideas of a section, indented like the outline, for "Comes under". value '' = straight
 * under the section. The idea itself and everything under it are left out.
 */
export function underOptions(model, sectionKey, ideaId) {
  const blocked = ideaId ? model.branch(ideaId) : new Set();
  const out = [];
  const walk = (list, depth) => {
    for (const i of list) {
      if (blocked.has(i.id)) continue;
      out.push({ id: i.id, depth, title: i.data.title || '(no title)' });
      walk(model.kidsOf(i.id), depth + 1);
    }
  };
  walk(model.topIdeas(sectionKey), 0);
  return out;
}

export function fillUnderSelect(sel, model, sectionKey, ideaId, value) {
  const s = sectionKey ? model.section(sectionKey)?.name : 'Not sorted';
  clear(sel,
    h('option', { value: '', text: `Straight under ${s || 'the section'}` }),
    underOptions(model, sectionKey, ideaId).map(o => h('option', { value: o.id, text: `${'  '.repeat(o.depth)}${o.title}` })));
  sel.value = value && [...sel.options].some(o => o.value === value) ? value : '';
}

/** "Add an idea under this". */
export function addUnderDialog(model, idea, ui) {
  return nameDialog({
    title: `New idea under “${idea.data.title || 'idea'}”`, label: 'Idea', confirm: 'Add idea',
    placeholder: 'For example: Termites eat wooden doors', maxLength: 200,
    onSave: async title => {
      await createIdea({ title, section: model.sectionOf(idea), parent: idea.id });
      ui.unfold?.(idea.id);
    },
  });
}

/** Move an idea (and everything under it) to another section, at the top level there. */
export function moveIdeaDialog(model, idea) {
  const sel = sectionSelect(model, model.sectionOf(idea));
  const under = model.branch(idea.id).size - 1;
  return openModal({
    title: `Move “${idea.data.title || 'idea'}”`,
    body: [
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Section' }), sel),
      under ? h('p', { class: 'muted small', text: `The ${plural(under, 'idea')} under it move along.` }) : null,
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      {
        id: 'move', label: 'Move', kind: 'primary',
        onClick: async close => {
          const s = sel.value || null;
          if (s !== model.sectionOf(idea) || model.parentOf(idea.id)) await updateIdea(idea.id, { section: s, parent: null });
          close('moved');
        },
      },
    ],
  }).result;
}

export function confirmDeleteIdea(model, idea) {
  const kids = model.kidsOf(idea.id).length;
  return confirmDialog({
    title: `Delete “${idea.data.title || 'this idea'}”?`,
    body: [
      h('p', { text: 'It is removed from this device now, and from GitHub when you push (it stays in the repo\'s history).' }),
      kids ? h('p', { text: `The ${plural(kids, 'idea')} under it ${kids === 1 ? 'moves' : 'move'} up a level; ${kids === 1 ? "it isn't" : "they aren't"} deleted.` }) : null,
    ],
    confirm: 'Delete', danger: true,
  });
}

/** Remove an idea and the pictures in its note. The ideas under it move up a level. */
export async function removeIdea(model, id, data) {
  const idea = model.get(id);
  if (idea) {
    const parent = model.parentOf(id);
    const section = model.sectionOf(idea);
    for (const k of model.kidsOf(id)) await updateIdea(k.id, { parent, section });
  }
  const used = filesOfPage(data);
  for (const f of await store.files()) {
    if (used.has(f.path) || isFileOfPage(f.path, id)) await store.removeFile(f.path);
  }
  await store.remove('ideas', id);
}

/** The note's blocks for a new task, with copies of its pictures (so each keeps its own). */
async function copyBody(body, taskId) {
  const out = [];
  for (const b of Array.isArray(body) ? body : []) {
    if (b?.type === 'image' && b.src) {
      const f = await store.getFile(b.src);
      if (!f?.blob) continue;   // the picture isn't on this device: leave it out
      const ext = (b.src.match(/\.([a-z0-9]+)$/i) || [])[1] || 'png';
      const path = `images/${taskId}-${uid()}.${ext.toLowerCase()}`;
      await store.putFile(path, f.blob);
      out.push({ ...b, src: path });
    } else out.push(structuredClone(b));
  }
  return out;
}

/** "Make a task": a new task that links back to the idea (and the idea's wiki pages). */
export async function makeTaskDialog(idea) {
  const [tasks, wiki] = await Promise.all([getTasks(), getWiki()]);
  const d = idea.data;
  const title = h('input', { class: 'input', name: 'title', autocomplete: 'off', maxLength: 200, value: d.title || '' });
  const type = h('select', { class: 'input', name: 'type', 'aria-label': 'Task or bug' },
    Object.entries(TYPES).map(([v, label]) => h('option', { value: v, text: label })));
  const priority = h('select', { class: 'input', name: 'priority', 'aria-label': 'Priority' },
    Object.entries(PRIORITIES).map(([v, label]) => h('option', { value: v, text: label })));
  priority.value = 'normal';
  const difficulty = h('select', { class: 'input', name: 'difficulty', 'aria-label': 'Difficulty' },
    h('option', { value: '', text: 'Not set' }),
    Object.entries(DIFFICULTIES).map(([v, label]) => h('option', { value: v, text: `${label} (${DIFFICULTY_HINTS[v]})` })));
  const folder = folderSelect(tasks, null);
  const hasNote = d.body.length > 0;
  const copyNote = h('input', { type: 'checkbox', name: 'copyNote', checked: true });
  const wikiLinks = d.links.filter(l => l.collection === 'wiki');
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const field = (label, control) => h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), control);

  async function create(close) {
    const t = title.value.trim();
    if (!t) { error.textContent = 'Give the task a title.'; error.hidden = false; return; }
    try {
      const id = newTaskId();
      const body = hasNote && copyNote.checked ? await copyBody(d.body, id) : [];
      await createTask({
        id, title: t, type: type.value, priority: priority.value, difficulty: difficulty.value || null, folder: folder.value || null,
        links: [{ collection: 'ideas', id: idea.id }, ...wikiLinks], body,
      });
      close('created');
      toast(`${TYPES[type.value]} added in Tasks & Bugs, linked to this idea.`, {
        kind: 'ok', action: { label: 'Open it', onClick: () => goCrossTab(`#/tasks/t/${id}`) },
      });
    } catch (err) {
      errorDialog(err, "The task couldn't be made");
    }
  }

  const m = openModal({
    title: 'Make a task from this idea',
    body: h('div', { class: 'connect-form' },
      field('Title', title),
      h('div', { class: 'field-grid' }, field('Task or bug', type), field('Priority', priority)),
      field('Difficulty', difficulty),
      field('Folder', folder),
      hasNote ? h('label', { class: 'ed-check' }, copyNote, h('span', { text: "Copy the idea's note into the task's description" })) : null,
      h('p', { class: 'muted small' }, icon('idea', { size: 12 }),
        ` The task links back to this idea${wikiLinks.length ? `, and to ${wikiLinks.map(l => nameFor(wiki, l.id)).join(', ')}` : ''}.`),
      error),
    actions: [
      { id: 'cancel', label: 'Cancel', kind: 'quiet' },
      { id: 'create', label: 'Make task', kind: 'primary', onClick: create },
    ],
    onOpen: () => { title.focus(); title.select(); },
  });
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(m.close); } });
  return m.result;
}

/** "Link a task you already have": the task gets a link to the idea. */
export async function linkTaskDialog(idea) {
  const tasks = await getTasks();
  const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const input = h('input', { class: 'input', type: 'search', name: 'task', autocomplete: 'off', placeholder: 'Type part of the task title', 'aria-label': 'Find a task' });
  const results = h('ul', { class: 'id-pick-list' });
  const linked = t => t.data.links.some(l => l.collection === 'ideas' && l.id === idea.id);
  let m = null;
  const draw = () => {
    const words = fold(input.value).split(/\s+/).filter(Boolean);
    const found = [...tasks.tasks.values()]
      .filter(t => !linked(t) && words.every(w => fold(t.data.title).includes(w)))
      .sort((a, b) => (a.data.status === 'done') - (b.data.status === 'done') || a.data.title.localeCompare(b.data.title))
      .slice(0, 8);
    clear(results, found.length
      ? found.map(t => h('li', h('button', {
          type: 'button', class: 'id-pick',
          onclick: async () => {
            await updateTask(t.id, { links: [...t.data.links, { collection: 'ideas', id: idea.id }] });
            m.close('linked');
            toast(`Linked “${t.data.title}” to this idea.`, { kind: 'ok' });
          },
        }, icon(t.data.type === 'bug' ? 'bug' : 'tasks', { size: 14 }), h('span', { class: 'id-pick-name', text: t.data.title || '(no title)' }),
          t.data.status === 'done' ? h('span', { class: 'muted small', text: 'Done' }) : null)))
      : h('li', { class: 'muted small', text: tasks.tasks.size ? 'No task like that.' : 'There are no tasks yet.' }));
  };
  input.addEventListener('input', draw);
  draw();
  m = openModal({
    title: 'Link a task you already have',
    body: [h('p', { class: 'muted small', text: 'The task gets a link to this idea and shows here.' }), input, results],
    actions: [{ id: 'cancel', label: 'Cancel', kind: 'quiet' }],
    onOpen: () => input.focus(),
  });
  return m.result;
}
