// The app's tabs, in order. Each tab module exports { id, label, icon, mount(el, path) }
// and optionally navigate(path) for moving around inside the tab (the part of the address
// after #/<id>/). mount() may return a cleanup function that runs when you switch away.

import { wikiTab } from './wiki.js';
import { tasksTab } from './tasks.js';
import { ideasTab } from './ideas.js';

export const TABS = [wikiTab, tasksTab, ideasTab];
