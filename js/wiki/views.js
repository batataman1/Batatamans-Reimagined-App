// The Wiki tab's screens: start (groups + search), a group, a sub-group, a page.
//
// Addresses (after #/wiki/):
//   (nothing)          start
//   g/mobs             a group
//   g/mobs/neutral     a sub-group's pages
//   p/ostrich          a page
//   unsorted           pages that aren't in a group yet

import { h, clear, plural, timeAgo } from '../core/util.js';
import { store } from '../core/store.js';
import { ICONS } from '../config/icons.js';
import { STATUSES } from '../config/wiki.js';
import { icon } from '../ui/icons.js';
import { pageName, humanizeId } from './model.js';
import { renderText, renderBody, plainText, pageLink } from './text.js';

const APP_TITLE = "Batataman's Reimagined";

export function parseWikiPath(path) {
  const [kind, a, b] = String(path || '').split('/').map(x => decodeURIComponent(x));
  if (kind === 'g' && a && b) return { view: 'sub', group: a, sub: b };
  if (kind === 'g' && a) return { view: 'group', group: a };
  if (kind === 'p' && a) return { view: 'page', id: a };
  if (kind === 'unsorted') return { view: 'unsorted' };
  return { view: 'home' };
}

/** Draw the screen for this address into el. ui keeps state between redraws (the search text). */
export function renderWikiView(el, path, wiki, ui) {
  const route = parseWikiPath(path);
  document.title = APP_TITLE;
  switch (route.view) {
    case 'group': return groupView(el, wiki, route.group);
    case 'sub': return subView(el, wiki, route.group, route.sub);
    case 'page': return pageView(el, wiki, route.id);
    case 'unsorted': return unsortedView(el, wiki);
    default: return homeView(el, wiki, ui);
  }
}

/* ---------- Small pieces ---------- */

const safeIcon = (name, size) => icon(ICONS[name] ? name : 'book', { size });

function crumbs(...items) {
  const parts = [];
  items.forEach((it, i) => {
    if (i) parts.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '›' }));
    parts.push(it.href ? h('a', { href: it.href, text: it.label }) : h('span', { text: it.label }));
  });
  return h('nav', { class: 'crumbs', 'aria-label': 'You are here' }, parts);
}

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

/* Pictures are files on this device (synced through files/ in the data repo). */
const urls = new Map();
store.on(d => {
  if (d?.type === 'file' || d?.type === 'sync') {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
  }
});

/** A picture from this device's files, or a placeholder. */
export function fileImage(path, alt, { className = '', placeholder = 'No picture yet', size = 28 } = {}) {
  const box = h('span', { class: `pic ${className}`.trim() });
  const showPlaceholder = text => {
    box.classList.add('is-empty');
    clear(box, h('span', { class: 'pic-empty' }, icon('image', { size }), text ? h('span', { text }) : null));
  };
  if (!path) { showPlaceholder(placeholder); return box; }
  showPlaceholder('');
  (async () => {
    let url = urls.get(path);
    if (!url) {
      const f = await store.getFile(path);
      if (!f?.blob) { showPlaceholder('Picture not on this device yet'); return; }
      url = URL.createObjectURL(f.blob);
      urls.set(path, url);
    }
    box.classList.remove('is-empty');
    clear(box, h('img', { src: url, alt: alt || '', decoding: 'async' }));
  })();
  return box;
}

function thumb(page, wiki) {
  if (page.data.picture) return fileImage(page.data.picture, '', { className: 'thumb', placeholder: '', size: 18 });
  const place = wiki.placeOf(page);
  return h('span', { class: 'pic thumb' }, h('span', { class: 'pic-empty' }, safeIcon(place?.group.icon || 'book', 20)));
}

function pageRow(page, wiki, { showPlace = false, snippet } = {}) {
  const place = wiki.placeOf(page);
  return h('li', h('a', { class: 'page-row', href: `#/wiki/p/${page.id}`, dataset: { page: page.id } },
    thumb(page, wiki),
    h('span', { class: 'page-row-text' },
      h('span', { class: 'page-row-head' }, h('span', { class: 'page-row-name', text: pageName(page) }), tags(page, wiki)),
      showPlace ? h('span', { class: 'page-row-place', text: place ? `${place.group.name} › ${place.sub.name}` : 'Not sorted yet' }) : null,
      h('span', { class: 'page-row-snippet', text: snippet ?? short(plainText(page.data.overview, wiki)) }),
    )));
}

const pageList = (pages, wiki, opts) => h('ul', { class: 'page-list' }, pages.map(p => pageRow(p, wiki, opts)));

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
    h('div', { class: 'tiles' }, wiki.groups.map(g => h('a', { class: 'tile', href: `#/wiki/g/${g.id}` },
      h('span', { class: 'tile-icon' }, safeIcon(g.icon, 28)),
      h('span', { class: 'tile-text' },
        h('span', { class: 'tile-name', text: g.name }),
        h('span', { class: 'tile-sub', text: g.subgroups.map(s => s.name).join(' · ') })),
      h('span', { class: 'tile-count', 'aria-label': plural(wiki.countIn(g.id), 'page'), text: String(wiki.countIn(g.id)) })))),
    wiki.unsorted.length ? h('section', { class: 'wiki-section wiki-unsorted' },
      h('h2', { text: 'Not sorted yet' }),
      h('p', { class: 'muted small', text: "These pages aren't in a group. Moving pages arrives with editing." }),
      pageList(wiki.unsorted, wiki)) : null,
    total ? h('section', { class: 'wiki-section' },
      h('h2', { text: 'Recently changed' }),
      h('ul', { class: 'page-list compact' }, wiki.recent(6).map(p => pageRow(p, wiki, { showPlace: true, snippet: timeAgo(p.updatedAt) })))) : null,
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
      found.length ? h('ul', { class: 'page-list' }, found.slice(0, 50).map(r => pageRow(r.page, wiki, { showPlace: true, snippet: r.snippet || undefined }))) : null);
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
    h('div', { class: 'tab-head' }, h('h1', { text: 'Wiki' }), h('span', { class: 'muted', text: plural(total, 'page') })),
    h('label', { class: 'search-box' }, icon('search', { size: 18 }), input),
    results, browse);
  update();
}

/* ---------- A group ---------- */

function groupView(el, wiki, groupId) {
  const g = wiki.group(groupId);
  if (!g) return notFound(el, 'This group');
  document.title = `${g.name} · ${APP_TITLE}`;
  clear(el,
    crumbs({ href: '#/wiki', label: 'Wiki' }),
    h('div', { class: 'tab-head' }, h('h1', { text: g.name }), h('span', { class: 'muted', text: plural(wiki.countIn(g.id), 'page') })),
    h('div', { class: 'tiles' }, g.subgroups.map(s => {
      const n = wiki.countIn(g.id, s.id);
      return h('a', { class: 'tile', href: `#/wiki/g/${g.id}/${s.id}` },
        h('span', { class: 'tile-text' },
          h('span', { class: 'tile-name', text: s.name }),
          h('span', { class: 'tile-sub', text: `${wiki.templates[s.template]?.name || 'No'} template` })),
        h('span', { class: `tile-count${n ? '' : ' zero'}`, 'aria-label': plural(n, 'page'), text: String(n) }));
    })));
}

/* ---------- A sub-group ---------- */

function subView(el, wiki, groupId, subId) {
  const g = wiki.group(groupId);
  const s = g?.subgroups.find(x => x.id === subId);
  if (!s) return notFound(el, 'This sub-group');
  document.title = `${s.name} · ${g.name} · ${APP_TITLE}`;
  const pages = wiki.pagesIn(g.id, s.id);
  clear(el,
    crumbs({ href: '#/wiki', label: 'Wiki' }, { href: `#/wiki/g/${g.id}`, label: g.name }),
    h('div', { class: 'tab-head' }, h('h1', { text: s.name }),
      h('span', { class: 'muted', text: `${plural(pages.length, 'page')} · ${wiki.templates[s.template]?.name || 'No'} template` })),
    pages.length ? pageList(pages, wiki) : h('p', { class: 'muted', text: 'No pages here yet.' }));
}

function unsortedView(el, wiki) {
  clear(el,
    crumbs({ href: '#/wiki', label: 'Wiki' }),
    h('div', { class: 'tab-head' }, h('h1', { text: 'Not sorted yet' })),
    wiki.unsorted.length ? pageList(wiki.unsorted, wiki) : h('p', { class: 'muted', text: 'Every page is in a group.' }));
}

function notFound(el, what) {
  clear(el,
    crumbs({ href: '#/wiki', label: 'Wiki' }),
    h('div', { class: 'notice' }, h('p', { text: `${what} doesn't exist (anymore).` })));
}

/* ---------- A page ---------- */

function pageView(el, wiki, id) {
  const page = wiki.get(id);
  if (!page) return missingPageView(el, wiki, id);
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
      crumbs({ href: '#/wiki', label: 'Wiki' }, ...where),
      h('div', { class: 'wiki-title-row' }, h('h1', { id: 'wiki-page-title', text: name }), tags(page, wiki))),
    d.overview ? h('div', { class: 'wiki-overview text' }, renderText(d.overview, wiki)) : h('div', { class: 'wiki-overview' }),
    infobox(page, wiki, tpl, place),
    h('div', { class: 'wiki-main' },
      variants.length ? section(`Variants (${variants.length})`,
        h('ul', { class: 'variants' }, variants.map(v => h('li',
          h('strong', { class: 'variant-name' }, renderText(v.name || '', wiki)),
          v.note ? h('span', { class: 'variant-note text' }, renderText(v.note, wiki)) : null)))) : null,
      body.length ? h('div', { class: 'wiki-body text' }, renderBody(body, wiki, {
        image: (src, alt) => fileImage(src, alt, { className: 'body-pic', placeholder: 'Image missing' }),
      })) : null,
      d.notes ? section('Notes', h('div', { class: 'text' }, renderText(d.notes, wiki))) : null,
      section('Related pages', related.length
        ? h('div', { class: 'link-chips' }, related.map(r => pageLink(wiki, r)))
        : h('p', { class: 'muted small', text: 'None yet.' })),
      section('Linked from', linkedFrom.length
        ? h('div', { class: 'link-chips' }, linkedFrom.map(p => pageLink(wiki, p.id)))
        : h('p', { class: 'muted small', text: 'No other page links here yet.' })),
      h('p', { class: 'wiki-updated muted small', text: `Last changed ${timeAgo(page.updatedAt)}.` }),
    )));
}

function infobox(page, wiki, tpl, place) {
  const d = page.data;
  const fields = d.fields && typeof d.fields === 'object' ? d.fields : {};
  const known = new Set((tpl?.fields || []).map(f => f.key));
  const rows = (tpl?.fields || []).map(f => ({ label: f.label, value: fields[f.key] }));
  for (const [key, value] of Object.entries(fields)) {
    if (!known.has(key) && value !== null && value !== '') rows.push({ label: humanizeId(key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()), value, extra: true });
  }
  const hasValue = v => v !== undefined && v !== null && String(v).trim() !== '';
  const anyField = rows.some(r => hasValue(r.value));
  const row = (label, content, cls = '') => [h('dt', { class: cls, text: label }), h('dd', { class: cls }, content)];

  return h('aside', { class: 'infobox', 'aria-label': 'Facts' },
    fileImage(d.picture, pageName(page), { className: 'infobox-pic', placeholder: 'No picture yet', size: 36 }),
    h('dl', { class: 'infobox-facts' },
      anyField
        ? rows.map(r => row(r.label, hasValue(r.value) ? renderText(String(r.value), wiki) : '—', hasValue(r.value) ? '' : 'empty'))
        : h('div', { class: 'infobox-none muted small', text: tpl ? 'No details yet.' : 'No template: this page isn\'t in a sub-group yet.' }),
      row('Category', place
        ? [h('a', { href: `#/wiki/g/${place.group.id}`, text: place.group.name }), ' › ', h('a', { href: `#/wiki/g/${place.group.id}/${place.sub.id}`, text: place.sub.name })]
        : 'Not sorted yet', 'meta'),
      hasValue(d.versionAdded) ? row('Version added', String(d.versionAdded), 'meta') : null,
    ));
}

function missingPageView(el, wiki, id) {
  const name = humanizeId(id);
  document.title = `${name} · ${APP_TITLE}`;
  const linkedFrom = wiki.linkedFrom(id);
  clear(el, h('article', { class: 'wiki-page missing' },
    h('header', { class: 'wiki-page-head' },
      crumbs({ href: '#/wiki', label: 'Wiki' }),
      h('div', { class: 'wiki-title-row' }, h('h1', { text: name }), h('span', { class: 'tag tag-missing', text: 'No page yet' }))),
    h('div', { class: 'wiki-main' },
      h('div', { class: 'notice' },
        h('p', { text: `There's no page called “${name}” yet.` }),
        h('p', { class: 'muted', text: 'Creating it from here arrives with editing, in the next update.' })),
      linkedFrom.length ? h('section', { class: 'wiki-section' }, h('h2', { text: 'Linked from' }),
        h('div', { class: 'link-chips' }, linkedFrom.map(p => pageLink(wiki, p.id)))) : null)));
}
