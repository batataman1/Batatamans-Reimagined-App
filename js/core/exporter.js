// "Copy tasks for Claude": a plain-text list Claude can read to suggest what to close.
// Claude never deletes anything; it only suggests, and changes come back through Import.

import { store } from './store.js';

const TYPE = { task: 'Task', bug: 'Bug' };
const PRIORITY = { critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' };
const STATUS = { todo: 'To do', doing: 'In progress', done: 'Done' };
const ORDER = { critical: 0, high: 1, normal: 2, low: 3 };

export async function tasksAsText() {
  const rows = await store.list('tasks');
  rows.sort((a, b) =>
    (ORDER[a.data.priority] ?? 9) - (ORDER[b.data.priority] ?? 9) ||
    String(a.data.title).localeCompare(String(b.data.title)));
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`Batataman's Reimagined app: tasks and bugs (${rows.length}, copied ${date})`, ''];
  for (const { id, data: t } of rows) {
    const links = (t.links || []).map(l => `${l.collection}/${l.id}`).join(', ');
    lines.push([
      `- ${id}`,
      TYPE[t.type] || 'Task',
      PRIORITY[t.priority] || 'Normal',
      STATUS[t.status] || 'To do',
      t.title || '(untitled)',
      links ? `links: ${links}` : '',
    ].filter(Boolean).join(' | '));
  }
  return { text: lines.join('\n'), count: rows.length };
}
