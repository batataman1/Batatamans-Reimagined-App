// Things you can do to a whole page from more than one screen (the editor and the lists).

import { h } from '../core/util.js';
import { store } from '../core/store.js';
import { confirmDialog, toast } from '../ui/dialogs.js';
import { openPopup } from './popup.js';
import { pageName } from './model.js';
import { filesOfPage, isFileOfPage } from './images.js';

/** Ask before deleting a page. Resolves true if the user agreed. */
export function confirmDeletePage(name) {
  return confirmDialog({
    title: `Delete “${name}”?`,
    body: [
      h('p', { text: 'The page and its pictures are removed from this device now, and from GitHub when you push. They stay in the repo\'s history on GitHub.' }),
      h('p', { class: 'muted', text: 'Links to it from other pages will show dashed.' }),
    ],
    confirm: 'Delete page', danger: true,
  });
}

/** Remove a page and every picture that belongs to it. */
export async function removePageAndFiles(id, data) {
  const used = filesOfPage(data);
  for (const f of await store.files()) {
    if (used.has(f.path) || isFileOfPage(f.path, id)) await store.removeFile(f.path);
  }
  await store.remove('wiki', id);
}

/** The ⋯ menu on a page in a list: Edit or Delete, without opening the page first. */
export function pageMenu(page, anchor, ui) {
  openPopup({
    rect: anchor.getBoundingClientRect(),
    title: pageName(page),
    items: [
      { label: 'Edit', icon: 'edit', onPick: () => ui.go(`e/${page.id}`) },
      {
        label: 'Delete page', icon: 'trash',
        onPick: async () => {
          if (!(await confirmDeletePage(pageName(page)))) return;
          await removePageAndFiles(page.id, page.data);
          toast('Page deleted. Push to remove it from GitHub too.');
        },
      },
    ],
  });
}
