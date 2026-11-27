// Import from Claude (paste, preview, confirm), Copy tasks for Claude and Copy ideas for Claude.

import { h, clear, plural, humanizeKey, shortValue } from '../core/util.js';
import { parseImportText, previewImport, applyImport, COLLECTIONS } from '../core/importer.js';
import { tasksAsText, ideasAsText } from '../core/exporter.js';
import { openModal, confirmDialog, toast } from './dialogs.js';
import { icon } from './icons.js';

const STATUS_LABEL = {
  create: 'New', update: 'Update', same: 'No change', delete: 'Delete', invalid: 'Problem',
};

export function openImport() {
  const m = openModal({ title: 'Import from Claude', body: h('div'), className: 'modal-wide' });
  showPasteStep(m);
  return m.result;
}

function showPasteStep(m, initialText = '') {
  const area = h('textarea', {
    class: 'input code', rows: 9, spellcheck: 'false', value: initialText,
    placeholder: 'Paste the update block Claude gave you in chat.',
    'aria-label': 'Update from Claude',
  });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const file = h('input', {
    type: 'file', accept: '.json,.txt,application/json,text/plain', hidden: true,
    onchange: async () => {
      const f = file.files?.[0];
      if (f) { area.value = await f.text(); preview(); }
    },
  });

  async function preview() {
    error.hidden = true;
    try {
      const update = parseImportText(area.value);
      const items = await previewImport(update);
      showPreviewStep(m, update, items, area.value);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  }

  clear(m.body, 
    h('p', { class: 'muted', text: 'Nothing is saved until you review the changes and confirm.' }),
    area, error, file,
    h('div', { class: 'modal-actions inline' },
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => file.click() }, icon('import', { size: 18 }), 'Choose a file'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: preview }, 'Preview changes'),
    ),
  );
  area.focus();
}

function showPreviewStep(m, update, items, rawText) {
  const counter = h('span', { class: 'muted' });
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: save });

  function refresh() {
    const n = items.filter(i => i.checked).length;
    saveBtn.textContent = n ? `Save ${plural(n, 'change')}` : 'Save';
    saveBtn.disabled = n === 0;
    const dels = items.filter(i => i.checked && i.status === 'delete').length;
    counter.textContent = dels ? `${plural(dels, 'item')} will be deleted.` : '';
  }

  async function save() {
    const dels = items.filter(i => i.checked && i.status === 'delete');
    if (dels.length) {
      const ok = await confirmDialog({
        title: `Delete ${plural(dels.length, 'item')}?`,
        body: [
          h('p', { text: 'These will be removed from this device. When you push, they are removed from the repo too, but stay in its history on GitHub.' }),
          h('ul', { class: 'item-list' }, dels.map(d => h('li', { text: `${COLLECTIONS[d.collection]}: ${d.title}` }))),
        ],
        confirm: 'Delete', danger: true,
      });
      if (!ok) return;
    }
    const res = await applyImport(items);
    m.close('saved');
    const parts = [res.saved && `Saved ${plural(res.saved, 'change')}`, res.deleted && `deleted ${res.deleted}`].filter(Boolean);
    toast(`${parts.join(', ')}. Push to send them to GitHub.`, { kind: 'ok' });
  }

  const list = h('ul', { class: 'import-list' }, items.map(item => {
    const selectable = ['create', 'update', 'delete'].includes(item.status);
    const box = h('input', {
      type: 'checkbox', checked: item.checked, disabled: !selectable,
      'aria-label': `Include ${item.title}`,
      onchange: () => { item.checked = box.checked; refresh(); },
    });
    return h('li', { class: `import-item status-${item.status}` },
      h('label', { class: 'import-row' },
        box,
        h('span', { class: 'import-badge', text: STATUS_LABEL[item.status] }),
        h('span', { class: 'import-title' },
          h('strong', { text: item.title }),
          h('span', { class: 'muted', text: ` ${COLLECTIONS[item.collection] || item.collection || ''}` })),
      ),
      item.problem ? h('p', { class: 'import-problem', text: item.problem }) : null,
      item.status === 'delete' ? h('p', { class: 'import-note', text: 'Tick this only if you want it deleted.' }) : null,
      item.status === 'update' ? diffTable(item.diffs) : null,
      item.status === 'create' ? fieldSummary(item.next) : null,
    );
  }));

  clear(m.body, 
    update.summary ? h('p', { class: 'import-summary', text: update.summary }) : null,
    list,
    h('div', { class: 'modal-actions inline' },
      counter,
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => showPasteStep(m, rawText) }, 'Back'),
      saveBtn,
    ),
  );
  refresh();
}

function diffTable(diffs) {
  const shown = diffs.slice(0, 12);
  return h('table', { class: 'diff' },
    h('tbody', shown.map(d => h('tr',
      h('th', { scope: 'row', text: humanizeKey(d.key) }),
      h('td', { class: 'diff-before', text: shortValue(d.before) }),
      h('td', { class: 'diff-after', text: shortValue(d.after) }),
    ))),
    diffs.length > shown.length ? h('caption', { text: `and ${diffs.length - shown.length} more fields` }) : null,
  );
}

function fieldSummary(data) {
  const keys = Object.keys(data || {}).filter(k => k !== 'name' && k !== 'title');
  if (!keys.length) return null;
  return h('p', { class: 'muted import-note', text: `With: ${keys.map(humanizeKey).join(', ')}` });
}

export async function copyTasksForClaude() {
  const { text, count } = await tasksAsText();
  if (!count) {
    toast('There are no tasks yet.');
    return;
  }
  await copyText(text, `Copied ${plural(count, 'task')}. Paste them into the chat with Claude.`, 'Copy tasks for Claude');
}

export async function copyIdeasForClaude() {
  const { text, count } = await ideasAsText();
  if (!count) {
    toast('There are no ideas yet.');
    return;
  }
  await copyText(text, `Copied ${plural(count, 'idea')}. Paste them into the chat with Claude.`, 'Copy ideas for Claude');
}

async function copyText(text, done, title) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, { kind: 'ok' });
  } catch {
    const area = h('textarea', { class: 'input code', rows: 10, readOnly: true, value: text });
    openModal({
      title,
      body: [h('p', { text: 'Copy this text and paste it into the chat with Claude.' }), area],
      actions: [{ id: 'ok', label: 'Done', kind: 'primary' }],
      onOpen: () => { area.focus(); area.select(); },
    });
  }
}
