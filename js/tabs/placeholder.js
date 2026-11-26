// Temporary tab content until each tab's real part is built.
// Shows what's already saved on this device, so Import, Push and Pull can be checked now.

import { h, clear, plural } from '../core/util.js';
import { store } from '../core/store.js';

export function placeholderTab({ id, label, icon, collections, comingIn, describe }) {
  return {
    id, label, icon,
    mount(el) {
      const list = h('div', { class: 'saved-list' });
      const render = async () => {
        const groups = await Promise.all(collections.map(async c => ({ c, rows: await store.list(c) })));
        const rows = groups.flatMap(g => g.rows);
        rows.sort((a, b) => String(a.data.name || a.data.title || a.id).localeCompare(String(b.data.name || b.data.title || b.id)));
        clear(list, 
          rows.length
            ? h('ul', { class: 'saved-items' }, rows.map(r => h('li',
                h('span', { class: 'saved-name', text: r.data.name || r.data.title || r.id }),
                describe ? h('span', { class: 'muted', text: describe(r) }) : null,
                r.dirty ? h('span', { class: 'chip', text: 'Not pushed' }) : null,
              )))
            : h('p', { class: 'muted', text: 'Nothing saved here yet.' }),
        );
        list.dataset.count = rows.length;
        countEl.textContent = rows.length ? plural(rows.length, 'item') + ' on this device' : '';
      };
      const countEl = h('span', { class: 'muted' });
      clear(el, 
        h('div', { class: 'tab-head' }, h('h1', { text: label }), countEl),
        h('div', { class: 'notice' },
          h('p', { text: `The full ${label} tab arrives in part ${comingIn}. Anything you import or pull already shows up below.` })),
        list,
      );
      render();
      const off = store.on(render);
      return () => off();
    },
  };
}
