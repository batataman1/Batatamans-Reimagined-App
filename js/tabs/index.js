// The app's tabs, in order. Each tab module exports { id, label, icon, mount(el, path) }
// and optionally navigate(path) for moving around inside the tab (the part of the address
// after #/<id>/). mount() may return a cleanup function that runs when you switch away.

import { placeholderTab } from './placeholder.js';
import { wikiTab } from './wiki.js';

const wiki = wikiTab;

const tasks = placeholderTab({
  id: 'tasks', label: 'Tasks & Bugs', icon: 'tasks', collections: ['tasks'], comingIn: '2c',
  describe: r => [r.data.type, r.data.priority].filter(Boolean).join(', '),
});

const ideas = placeholderTab({
  id: 'ideas', label: 'Ideas', icon: 'idea', collections: ['ideas', 'sections'], comingIn: '2c to 2e',
});

export const TABS = [wiki, tasks, ideas];
