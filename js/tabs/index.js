// The app's tabs, in order. Each tab module exports { id, label, icon, mount(el) }.
// mount() may return a cleanup function that runs when you switch away.

import { placeholderTab } from './placeholder.js';

const wiki = placeholderTab({
  id: 'wiki', label: 'Wiki', icon: 'book', collections: ['wiki'], comingIn: '2b',
  describe: r => [r.data.category, r.data.status === 'planned' ? 'planned' : ''].filter(Boolean).join(', '),
});

const tasks = placeholderTab({
  id: 'tasks', label: 'Tasks & Bugs', icon: 'tasks', collections: ['tasks'], comingIn: '2c',
  describe: r => [r.data.type, r.data.priority].filter(Boolean).join(', '),
});

const ideas = placeholderTab({
  id: 'ideas', label: 'Ideas', icon: 'idea', collections: ['ideas', 'sections'], comingIn: '2c to 2e',
});

export const TABS = [wiki, tasks, ideas];
