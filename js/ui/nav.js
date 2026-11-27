// Moving from one tab to another by a link (a task on a wiki page, a wiki page in a task,
// an idea in a task).
// The new screen is marked as reached by a link, so its Back button and the phone's back
// gesture return to where you were, in the other tab.

/** Open an address in another tab as a new history entry. */
export function goCrossTab(hash) {
  history.pushState({ wikiDepth: 1, tasksDepth: 1, ideasDepth: 1 }, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Click handler for links to another tab (plain clicks only; Ctrl/middle click still open normally). */
export function crossTabClick(e) {
  const a = e.currentTarget;
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  goCrossTab(a.getAttribute('href'));
}
