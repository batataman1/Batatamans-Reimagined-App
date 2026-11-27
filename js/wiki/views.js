// The Wiki tab's screens: start (groups + search), a group, a sub-group, a page.
//
// Addresses (after #/wiki/):
//   (nothing)          start
//   g/mobs             a group
//   g/mobs/neutral     a sub-group's pages
//   p/ostrich          a page
//   e/ostrich          editing a page (wiki/editor.js)
//   unsorted           pages that aren't in a group yet
//   c                  Customize: groups and templates (wiki/customize.js)
//   c/g/mobs           editing a group and its sub-groups (c/g/mobs/neutral: that sub-group highlighted)
//   c/t/mob            editing a template

import { h, clear, plural, timeAgo } from '../core/util.js';
import { store } from '../core/store.js';
import { STATUSES } from '../config/wiki.js';
import { icon } from '../ui/icons.js';
import { pageName, humanizeId } from './model.js';
import { renderText, renderBody, plainText, pageLink } from './text.js';
import { topNav, fileImage, safeIcon } from './parts.js';
import { editorView, newPageDialog } from './editor.js';
import { customizeView, groupEditorView, templateEditorView } from './customize.js';
import { isPicturePath } from './images.js';
import { pageMenu } from './actions.js';
import { getTasks, byPriority } from '../tasks/model.js';
import { linkedTaskItem } from '../tasks/views.js';
import { newTaskDialog } from '../tasks/actions.js';

const APP_TITLE = "Batataman's Reimagined";

export function parseWikiPath(path) {
  const [kind, a, b] = String(path || '').split('/').map(x => decodeURIComponent(x));
  if (kind === 'g' && a && b) return { view: 'sub', group: a, sub: b };
  if (kind === 'g' && a) return { view: 'group', group: a };
  if (kind === 'p' && a) return { view: 'page', id: a };
  if (kind === 'e' && a) return { view: 'edit', id: a };
  if (kind === 'unsorted') return { view: 'unsorted' };
  if (kind === 'c') {
    const [, what, id, sub] = String(path || '').split('/').map(x => decodeURIComponent(x));
    if (what === 'g' && id) return { view: 'cgroup', group: id, sub: sub || null };
    if (what === 't' && id) return { view: 'ctemplate', id };
    return { view: 'custom' };
  }
  return { view: 'home' };
}

/**
 * Draw the screen for this address into el. ui keeps state between redraws (the search text)
 * and moves around (back, go). Returns a function to call when leaving the screen, if it needs one.
 */
export function renderWikiView(el, path, wiki, ui) {
  const route = parseWikiPath(path);
  document.title = APP_TITLE;
  switch (route.view) {
    case 'group': return groupView(el, wiki, ui, route.group);
    case 'sub': return subView(el, wiki, ui, route.group, route.sub);
    case 'page': return pageView(el, wiki, ui, route.id);
    case 'edit': return wiki.get(route.id) ? editorView(el, wiki, ui, route.id) : missingPageView(el, wiki, ui, route.id);
    case 'unsorted': return unsortedView(el, wiki, ui);
    case 'custom': return customizeView(el, wiki, ui);
    case 'cgroup': return groupEditorView(el, wiki, ui, route.group, route.sub);
    case 'ctemplate': return templateEditorView(el, wiki, ui, route.id);
    default: return homeView(el, wiki, ui);
  }
}

/* ---------- Small pieces ---------- */

function tags(page, wiki) {
  const out = [];
  if (page.data.status && STATUSES[page.data.status]) {
    out.push(h('span', { class: `tag tag-${page.data.status}`, text: STATUSES[page.data.status] }));
  }
  if (page.data.vanilla) {
    const tpl = wiki.templateOf(page);
    out.push(h('span', { class: 'tag tag-vanilla', text: `Vanilla ${tpl ? tpl.name.toLowerCase() : 'thing'} changed by the mod` }));
  }
  if (page.dirty) out.push(h('span', { class: 'tag tag-dirty', text: 'Not pushed' }));
  return out;
}

function short(text, max = 130) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** The page's picture, or its sub-group's icon until it has one. */
function thumb(page, wiki) {
  if (page.data.picture) return fileImage(page.data.picture, '', { className: 'thumb', placeholder: '', size: 18 });
  const place = wiki.placeOf(page);
  return h('span', { class: 'pic thumb' }, h('span', { class: 'pic-empty' }, safeIcon(place?.sub.icon || place?.group.icon || 'book', 24)));
}

function pageRow(page, wiki, ui, { showPlace = false, snippet } = {}) {
  const place = wiki.placeOf(page);
  const more = h('button', {
    type: 'button', class: 'row-menu', 'aria-label': `More for ${pageName(page)}`, title: 'Edit or delete',
    onclick: () => pageMenu(page, more, ui),
  }, '⋯');
  return h('li', { class: 'page-item' }, h('a', { class: 'page-row', href: `#/wiki/p/${page.id}`, dataset: { page: page.id } },
    thumb(page, wiki),
    h('span', { class: 'page-row-text' },
      h('span', { class: 'page-row-head' }, h('span', { class: 'page-row-name', text: pageName(page) }), tags(page, wiki)),
      showPlace ? h('span', { class: 'page-row-place', text: place ? `${place.group.name} › ${place.sub.name}` : 'Not sorted yet' }) : null,
      h('span', { class: 'page-row-snippet', text: snippet ?? short(plainText(page.data.overview, wiki)) }),
    )), more);
}

const pageList = (pages, wiki, ui, opts) => h('ul', { class: 'page-list' }, pages.map(p => pageRow(p, wiki, ui, opts)));

const newPageButton = (wiki, ui, where = '') => h('button', {
  type: 'button', class: 'btn btn-small', onclick: () => newPageDialog(wiki, ui, { where }),
}, icon('plus', { size: 16 }), 'New page');

/** Buttons on the right of a screen's title. */
const headActions = (...buttons) => h('span', { class: 'head-action head-actions' }, buttons);
const linkButton = (href, iconName, label, title) => h('a', { class: 'btn btn-small', href, title }, icon(iconName, { size: 16 }), label);

/* ---------- Start screen ---------- */

function homeView(el, wiki, ui) {
  const total = wiki.pages.size;
  const input = h('input', {
    type: 'search', class: 'input', placeholder: 'Search the wiki', value: ui.query || '',
    'aria-label': 'Search the wiki', enterkeyhint: 'search', autocomplete: 'off', spellcheck: 'false',
    dataset: { focusKey: 'wiki-search' },
  });
  const results = h('div', { class: 'search-results', 'aria-live': 'polite' });

  const browse = h('div', { class: 'wiki-browse' },
    total ? null : h('div', { class: 'notice' },
      h('p', { text: 'No wiki pages on this device yet.' }),
      h('p', { class: 'muted', text: 'Import the starter pages Claude made (Settings → Import from Claude → Choose a file), or tap Pull if another device already pushed them.' })),
    h('div', { class: 'tiles' }, wiki.visibleGroups.map(g => h('a', { class: 'tile', href: `#/wiki/g/${g.id}` },
      h('span', { class: 'tile-icon' }, safeIcon(g.icon, 28)),
      h('span', { class: 'tile-text' },
        h('span', { class: 'tile-name', text: g.name }),
        h('span', { class: 'tile-sub', text: g.subgroups.filter(s => !s.hidden).map(s => s.name).join(' · ') || 'No sub-groups yet' })),
      h('span', { class: 'tile-count', 'aria-label': plural(wiki.countIn(g.id), 'page'), text: String(wiki.countIn(g.id)) })))),
    wiki.unsorted.length ? h('section', { class: 'wiki-section wiki-unsorted' },
      h('h2', { text: 'Not sorted yet' }),
      h('p', { class: 'muted small', text: "These pages aren't in a group yet. Open one, tap Edit and choose where it goes." }),
      pageList(wiki.unsorted, wiki, ui)) : null,
    total ? h('section', { class: 'wiki-section' },
      h('h2', { text: 'Recently changed' }),
      h('ul', { class: 'page-list compact' }, wiki.recent(6).map(p => pageRow(p, wiki, ui, { showPlace: true, snippet: timeAgo(p.updatedAt) })))) : null,
  );

  const update = () => {
    const q = input.value.trim();
    ui.query = input.value;
    if (!q) { results.hidden = true; browse.hidden = false; clear(results); return; }
    const found = wiki.search(q);
    browse.hidden = true;
    results.hidden = false;
    clear(results,
      h('p', { class: 'muted small', text: found.length ? plural(found.length, 'page') + ' found' : `Nothing found for “${q}”.` }),
      found.length ? h('ul', { class: 'page-list' }, found.slice(0, 50).map(r => pageRow(r.page, wiki, ui, { showPlace: true, snippet: r.snippet || undefined }))) : null);
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const first = results.querySelector('a.page-row');
      if (first) { e.preventDefault(); first.click(); }
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault(); input.value = ''; update();
    }
  });

  clear(el,
    h('div', { class: 'tab-head' }, h('h1', { text: 'Wiki' }), h('span', { class: 'muted', text: plural(total, 'page') }),
      headActions(linkButton('#/wiki/c', 'sliders', 'Customize', 'Change groups, sub-groups and templates'), newPageButton(wiki, ui))),
    h('label', { class: 'search-box' }, icon('search', { size: 18 }), input),
    results, browse);
  update();
}

/* ---------- A group ---------- */

function groupView(el, wiki, ui, groupId) {
  const g = wiki.group(groupId);
  if (!g) return notFound(el, ui, 'This group');
  document.title = `${g.name} · ${APP_TITLE}`;
  const shown = g.subgroups.filter(s => !s.hidden);
  const hidden = g.subgroups.filter(s => s.hidden);
  clear(el,
    topNav(ui, '', { href: '#/wiki', label: 'Wiki' }),
    h('div', { class: 'tab-head' }, h('h1', { text: g.name }), h('span', { class: 'muted', text: plural(wiki.countIn(g.id), 'page') }),
      headActions(linkButton(`#/wiki/c/g/${g.id}`, 'edit', 'Edit group', 'Name, icon, order and sub-groups'))),
    g.hidden ? hiddenNotice(`This group is hidden on the Wiki start. Its pages still open from links and search.`, `#/wiki/c/g/${g.id}`) : null,
    shown.length ? null : h('p', { class: 'muted', text: g.subgroups.length ? 'Every sub-group here is hidden.' : 'No sub-groups yet. Tap Edit group to add one.' }),
    h('div', { class: 'tiles' }, shown.map(s => {
      const pages = wiki.pagesIn(g.id, s.id);
      const n = pages.length;
      return h('a', { class: 'tile', href: `#/wiki/g/${g.id}/${s.id}` },
        h('span', { class: 'tile-icon' }, safeIcon(s.icon || g.icon, 28)),
        h('span', { class: 'tile-text' },
          h('span', { class: 'tile-name', text: s.name }),
          h('span', { class: 'tile-sub', text: n ? pages.map(pageName).join(' · ') : 'No pages yet' })),
        h('span', { class: `tile-count${n ? '' : ' zero'}`, 'aria-label': plural(n, 'page'), text: String(n) }));
    })),
    hidden.length ? h('p', { class: 'muted small hidden-subs' },
      `Hidden here: ${hidden.map(s => `${s.name} (${plural(wiki.pagesIn(g.id, s.id).length, 'page')})`).join(', ')}. `,
      h('a', { href: `#/wiki/c/g/${g.id}`, text: 'Show them again in Edit group' }), '.') : null);
}

function hiddenNotice(text, href) {
  return h('div', { class: 'notice notice-hidden' },
    h('p', h('strong', { text: 'Hidden. ' }), text, ' ', h('a', { href, text: 'Change this in Customize' }), '.'));
}

/* ---------- A sub-group ---------- */

function subView(el, wiki, ui, groupId, subId) {
  const g = wiki.group(groupId);
  const s = g?.subgroups.find(x => x.id === subId);
  if (!s) return notFound(el, ui, 'This sub-group');
  document.title = `${s.name} · ${g.name} · ${APP_TITLE}`;
  const pages = wiki.pagesIn(g.id, s.id);
  clear(el,
    topNav(ui, `g/${g.id}`, { href: '#/wiki', label: 'Wiki' }, { href: `#/wiki/g/${g.id}`, label: g.name }),
    h('div', { class: 'tab-head' }, h('h1', { text: s.name }),
      h('span', { class: 'muted' }, `${plural(pages.length, 'page')} · `,
        wiki.templates[s.template]
          ? h('a', { href: `#/wiki/c/t/${s.template}`, class: 'tpl-link', title: 'Edit this template', text: `${wiki.templates[s.template].name} template` })
          : 'no template'),
      headActions(linkButton(`#/wiki/c/g/${g.id}/${s.id}`, 'edit', 'Edit', 'Name, icon and template of this sub-group'), newPageButton(wiki, ui, `${g.id}/${s.id}`))),
    g.hidden || s.hidden ? hiddenNotice(`This ${s.hidden ? 'sub-group' : 'group'} is hidden. Its pages still open from links and search.`, `#/wiki/c/g/${g.id}/${s.id}`) : null,
    pages.length ? pageList(pages, wiki, ui) : h('p', { class: 'muted', text: 'No pages here yet.' }));
}

function unsortedView(el, wiki, ui) {
  clear(el,
    topNav(ui, '', { href: '#/wiki', label: 'Wiki' }),
    h('div', { class: 'tab-head' }, h('h1', { text: 'Not sorted yet' })),
    wiki.unsorted.length ? pageList(wiki.unsorted, wiki, ui) : h('p', { class: 'muted', text: 'Every page is in a group.' }));
}

function notFound(el, ui, what) {
  clear(el,
    topNav(ui, '', { href: '#/wiki', label: 'Wiki' }),
    h('div', { class: 'notice' }, h('p', { text: `${what} doesn't exist (anymore).` })));
}

/* ---------- A page ---------- */

function pageView(el, wiki, ui, id) {
  const page = wiki.get(id);
  if (!page) return missingPageView(el, wiki, ui, id);
  const d = page.data;
  const name = pageName(page);
  const place = wiki.placeOf(page);
  const tpl = wiki.templateOf(page);
  document.title = `${name} · ${APP_TITLE}`;

  const where = place
    ? [{ href: `#/wiki/g/${place.group.id}`, label: place.group.name }, { href: `#/wiki/g/${place.group.id}/${place.sub.id}`, label: place.sub.name }]
    : [{ href: '#/wiki/unsorted', label: 'Not sorted yet' }];

  const section = (title, ...content) => h('section', { class: 'wiki-section' }, h('h2', { text: title }), content);

  const variants = Array.isArray(d.variants) ? d.variants.filter(v => v && (v.name || v.note)) : [];
  const related = Array.isArray(d.related) ? d.related.filter(Boolean) : [];
  const linkedFrom = wiki.linkedFrom(page.id);
  const body = Array.isArray(d.body) ? d.body : [];

  clear(el, h('article', { class: 'wiki-page', 'aria-labelledby': 'wiki-page-title' },
    h('header', { class: 'wiki-page-head' },
      topNav(ui, place ? `g/${place.group.id}/${place.sub.id}` : 'unsorted', { href: '#/wiki', label: 'Wiki' }, ...where),
      h('div', { class: 'wiki-title-row' }, h('h1', { id: 'wiki-page-title', text: name }), tags(page, wiki),
        h('a', { class: 'btn btn-small head-action', href: `#/wiki/e/${page.id}` }, icon('edit', { size: 16 }), 'Edit'))),
    d.overview ? h('div', { class: 'wiki-overview text' }, renderText(d.overview, wiki)) : h('div', { class: 'wiki-overview' }),
    infobox(page, wiki, tpl, place),
    h('div', { class: 'wiki-main' },
      variants.length ? section(`Variants (${variants.length})`,
        h('ul', { class: 'variants' }, variants.map(v => h('li',
          h('strong', { class: 'variant-name' }, renderText(v.name || '', wiki)),
          v.note ? h('span', { class: 'variant-note text' }, renderText(v.note, wiki)) : null)))) : null,
      body.length ? h('div', { class: 'wiki-body text' }, renderBody(body, wiki, {
        image: (src, alt) => fileImage(src, alt, { className: 'body-pic', placeholder: 'Image missing' }),
        // Ticking a checkbox while reading saves it right away.
        onToggle: async (i, checked) => {
          const fresh = await store.get('wiki', page.id);
          if (!fresh?.data?.body?.[i]) return;
          const next = structuredClone(fresh.data);
          next.body[i].checked = checked;
          await store.put('wiki', page.id, next);
        },
      })) : null,
      d.notes ? section('Notes', h('div', { class: 'text' }, renderText(d.notes, wiki))) : null,
      section('Related pages', related.length
        ? h('div', { class: 'link-chips' }, related.map(r => pageLink(wiki, r)))
        : h('p', { class: 'muted small', text: 'None yet.' })),
      section('Linked from', linkedFrom.length
        ? h('div', { class: 'link-chips' }, linkedFrom.map(p => pageLink(wiki, p.id)))
        : h('p', { class: 'muted small', text: 'No other page links here yet.' })),
      tasksBox(page),
      h('p', { class: 'wiki-updated muted small', text: `Last changed ${timeAgo(page.updatedAt)}.` }),
    )));
}

/** The open tasks and bugs that link this page, and a button to add one. */
function tasksBox(page) {
  const name = pageName(page);
  const add = h('button', { type: 'button', class: 'btn btn-small', onclick: () => newTaskDialog({ pageId: page.id, pageName: name }) },
    icon('plus', { size: 14 }), 'New task for this page');
  const body = h('div', { class: 'wiki-tasks-body' });
  getTasks().then(model => {
    const linked = model.linkedTo('wiki', page.id);
    const open = linked.filter(t => t.data.status !== 'done').sort(byPriority);
    const done = linked.length - open.length;
    clear(body,
      open.length ? h('ul', { class: 'tk-list compact' }, open.map(linkedTaskItem)) : h('p', { class: 'muted small', text: 'No open tasks for this page.' }),
      done ? h('p', { class: 'muted small', text: `${plural(done, 'done task')} not shown.` }) : null);
  });
  return h('section', { class: 'wiki-section wiki-tasks' }, h('h2', { text: 'Tasks & bugs' }), body, add);
}

function infobox(page, wiki, tpl, place) {
  const d = page.data;
  const fields = d.fields && typeof d.fields === 'object' ? d.fields : {};
  const known = new Set((tpl?.fields || []).map(f => f.key));
  const rows = (tpl?.fields || []).map(f => ({ label: f.label, value: fields[f.key], kind: f.kind }));
  for (const [key, value] of Object.entries(fields)) {
    if (!known.has(key) && value !== null && value !== '') rows.push({ label: humanizeId(key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()), value, extra: true });
  }
  const hasValue = v => v !== undefined && v !== null && String(v).trim() !== '';
  const anyField = rows.some(r => hasValue(r.value));
  const row = (label, content, cls = '') => [h('dt', { class: cls, text: label }), h('dd', { class: cls }, content)];
  // A picture field (like the crafting recipe) gets the whole width of the box.
  const value = r => {
    if (!hasValue(r.value)) return r.kind === 'image' ? 'No picture yet' : '—';
    if (isPicturePath(r.value)) return fileImage(r.value, r.label, { className: 'infobox-field-pic', placeholder: 'Picture missing', size: 20 });
    return renderText(String(r.value), wiki);
  };
  const cls = r => [hasValue(r.value) ? '' : 'empty', r.kind === 'image' || isPicturePath(r.value) ? 'wide' : ''].filter(Boolean).join(' ');

  return h('aside', { class: 'infobox', 'aria-label': 'Facts' },
    fileImage(d.picture, pageName(page), { className: 'infobox-pic', placeholder: 'No picture yet', size: 36 }),
    h('dl', { class: 'infobox-facts' },
      anyField
        ? rows.map(r => row(r.label, value(r), cls(r)))
        : h('div', { class: 'infobox-none muted small', text: tpl ? 'No details yet.' : 'No template: this page isn\'t in a sub-group yet.' }),
      row('Category', place
        ? [h('a', { href: `#/wiki/g/${place.group.id}`, text: place.group.name }), ' › ', h('a', { href: `#/wiki/g/${place.group.id}/${place.sub.id}`, text: place.sub.name })]
        : 'Not sorted yet', 'meta'),
      hasValue(d.versionAdded) ? row('Version added', String(d.versionAdded), 'meta') : null,
    ));
}

function missingPageView(el, wiki, ui, id) {
  const name = humanizeId(id);
  document.title = `${name} · ${APP_TITLE}`;
  const linkedFrom = wiki.linkedFrom(id);
  clear(el, h('article', { class: 'wiki-page missing' },
    h('header', { class: 'wiki-page-head' },
      topNav(ui, '', { href: '#/wiki', label: 'Wiki' }),
      h('div', { class: 'wiki-title-row' }, h('h1', { text: name }), h('span', { class: 'tag tag-missing', text: 'No page yet' }))),
    h('div', { class: 'wiki-main' },
      h('div', { class: 'notice' },
        h('p', { text: `There's no page called “${name}” yet.` }),
        h('div', { class: 'button-row' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => newPageDialog(wiki, ui, { id, name }) },
            icon('plus', { size: 16 }), 'Create this page'))),
      linkedFrom.length ? h('section', { class: 'wiki-section' }, h('h2', { text: 'Linked from' }),
        h('div', { class: 'link-chips' }, linkedFrom.map(p => pageLink(wiki, p.id)))) : null)));
}
