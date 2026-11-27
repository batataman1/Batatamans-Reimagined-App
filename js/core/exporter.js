// "Copy tasks for Claude": a plain-text list Claude can read to suggest what to close.
// "Copy ideas for Claude": the ideas as an outline, to talk them through in the chat.
// Claude never deletes anything; it only suggests, and changes come back through Import.

import { store } from './store.js';
import { getTasks } from '../tasks/model.js';
import { getIdeas, LINE_STYLES } from '../ideas/model.js';
import { getWiki } from '../wiki/model.js';
import { plainText } from '../wiki/text.js';

const TYPE = { task: 'Task', bug: 'Bug' };
const PRIORITY = { critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' };
const STATUS = { todo: 'To do', doing: 'In progress', done: 'Done' };
const DIFFICULTY = { quick: 'Quick', small: 'Small', medium: 'Medium', big: 'Big' };
const ORDER = { critical: 0, high: 1, normal: 2, low: 3 };

export async function tasksAsText() {
  const rows = await store.list('tasks');
  const model = await getTasks();
  const folderPath = t => {
    const f = model.get(t.id) ? model.folderOf(model.get(t.id)) : null;
    return f ? model.path(f).map(x => x.name).join('/') : '';
  };
  rows.sort((a, b) =>
    (ORDER[a.data.priority] ?? 9) - (ORDER[b.data.priority] ?? 9) ||
    String(a.data.title).localeCompare(String(b.data.title)));
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`Batataman's Reimagined app: tasks and bugs (${rows.length}, copied ${date})`, ''];
  for (const { id, data: t } of rows) {
    const links = (t.links || []).map(l => `${l.collection}/${l.id}`).join(', ');
    const folder = folderPath({ id });
    lines.push([
      `- ${id}`,
      TYPE[t.type] || 'Task',
      PRIORITY[t.priority] || 'Normal',
      STATUS[t.status] || 'To do',
      t.title || '(untitled)',
      DIFFICULTY[t.difficulty] ? `difficulty: ${DIFFICULTY[t.difficulty]}` : '',
      folder ? `folder: ${folder}` : '',
      links ? `links: ${links}` : '',
    ].filter(Boolean).join(' | '));
  }
  return { text: lines.join('\n'), count: rows.length };
}

/* ---------- Copy ideas for Claude ---------- */

const NOTE_MAX = 300;

/** A plain-text outline of the ideas, section by section, for talking them through with Claude. */
export async function ideasAsText() {
  const [model, tasks, wiki] = await Promise.all([getIdeas(), getTasks(), getWiki()]);
  const note = i => {
    const t = i.data.body.map(b => (b?.type === 'image' ? '[picture]' : b?.type === 'divider' ? '' : plainText(b?.text || '', wiki)))
      .filter(Boolean).join(' / ').replace(/\s+/g, ' ').trim();
    return t.length > NOTE_MAX ? `${t.slice(0, NOTE_MAX - 1)}…` : t;
  };
  const line = (i, depth) => {
    const pad = '  '.repeat(depth);
    const links = i.data.links.map(l => `${l.collection}/${l.id}`).join(', ');
    const made = tasks.linkedTo('ideas', i.id).map(t => `${t.id} (${STATUS[t.data.status] || 'To do'})`).join(', ');
    const conns = i.data.connections.filter(c => model.get(c.id)).map(c => (c.style === 'dashed' ? c.id : `${c.id} (${LINE_STYLES[c.style].name.toLowerCase()})`)).join(', ');
    const out = [[`${pad}- ${i.id}`, i.data.title || '(untitled)', made ? `tasks: ${made}` : '', links ? `links: ${links}` : '', conns ? `connected to: ${conns}` : ''].filter(Boolean).join(' | ')];
    const n = note(i);
    if (n) out.push(`${pad}  note: ${n}`);
    for (const k of model.kidsOf(i.id)) out.push(...line(k, depth + 1));
    return out;
  };
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`Batataman's Reimagined app: ideas (${model.ideas.size}, copied ${date})`];
  const block = (heading, list) => {
    lines.push('', `## ${heading}`);
    if (!list.length) lines.push('(no ideas yet)');
    for (const i of list) lines.push(...line(i, 0));
  };
  for (const { section } of model.tree()) block(`${model.path(section.id).map(s => s.name).join(' / ')} (${section.id})`, model.topIdeas(section.id));
  const loose = model.topIdeas(null);
  if (loose.length) block('Not sorted', loose);
  return { text: lines.join('\n'), count: model.ideas.size };
}
