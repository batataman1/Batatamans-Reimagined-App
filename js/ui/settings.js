// The settings sheet: Claude tools, theme, GitHub connection, this device, about.

import { h, clear, plural, timeAgo } from '../core/util.js';
import { store } from '../core/store.js';
import { loadConnection, saveConnection, forgetToken } from '../core/sync.js';
import { testConnection } from '../core/github.js';
import { APP_VERSION, DEFAULT_OWNER, DEFAULT_DATA_REPO } from '../config/app.js';
import { getThemeState, setStyle, setColor, setCustomColors, turnOffCustomColors, activeColors, onThemeChange } from './theme.js';
import { STYLES, COLORS, buildTheme } from '../config/themes.js';
import { openModal, confirmDialog, toast } from './dialogs.js';
import { icon } from './icons.js';
import { openImport, copyTasksForClaude } from './claudeui.js';
import { canPromptInstall, isInstalled, promptInstall, onInstallChange } from './install.js';

let openSheet = null;

export function openSettings(section, { openConnection = false } = {}) {
  if (openSheet) openSheet.close();
  const body = h('div', { class: 'settings' });
  const m = openModal({ title: 'Settings', body, className: 'sheet' });
  openSheet = m;
  const cleanups = [];
  m.result.then(() => { cleanups.forEach(fn => fn()); openSheet = null; });

  body.append(
    section_('claude', 'Claude', claudeSection(m)),
    section_('theme', 'Theme', themeSection(cleanups)),
    section_('sync', 'Sync with GitHub', syncSection()),
    section_('device', 'This device', deviceSection(cleanups)),
    section_('about', 'About', h('p', { class: 'muted', text: `Batataman's Reimagined app, version ${APP_VERSION}.` })),
    dangerZone(m),
  );
  if (section) {
    requestAnimationFrame(() => {
      const target = body.querySelector(`#settings-${section}`);
      if (openConnection) target?.openConnection?.();
      target?.scrollIntoView({ block: 'start' });
    });
  }
  return m;
}

function section_(id, title, content) {
  return h('section', { class: 'settings-section', id: `settings-${id}`, 'aria-labelledby': `settings-${id}-h` },
    h('h3', { id: `settings-${id}-h`, text: title }),
    content);
}

/* ---------- Claude ---------- */

function claudeSection(m) {
  return h('div', { class: 'button-row' },
    h('button', { type: 'button', class: 'btn', onclick: () => { m.close(); openImport(); } }, icon('import', { size: 18 }), 'Import from Claude'),
    h('button', { type: 'button', class: 'btn', onclick: () => copyTasksForClaude() }, icon('copy', { size: 18 }), 'Copy tasks for Claude'),
  );
}

/* ---------- Theme ---------- */

function themeSection(cleanups) {
  const wrap = h('div', { class: 'theme-picker' });
  const render = () => {
    const state = getThemeState();
    const custom = !!state.custom?.on;
    const styleName = STYLES.find(x => x.id === state.style)?.name;
    const colorName = COLORS.find(x => x.id === state.color)?.name;
    clear(wrap,
      h('div', { class: 'picker-row' },
        h('span', { class: 'picker-label', id: 'style-label', text: 'Style' }),
        h('div', { class: 'styles', role: 'radiogroup', 'aria-labelledby': 'style-label' },
          STYLES.map(st => {
            const t = buildTheme(st.id, state.color);
            return h('button', {
              type: 'button', class: 'style-btn', role: 'radio',
              'aria-checked': !custom && st.id === state.style ? 'true' : 'false',
              onclick: () => setStyle(st.id),
              style: { '--sw-bg': t.bg, '--sw-panel': t.panel, '--sw-accent': t.accent },
            },
              h('span', { class: 'style-preview', 'aria-hidden': 'true' }, h('span', { class: 'style-dot' })),
              h('span', { text: st.name }));
          }))),
      h('div', { class: 'picker-row' },
        h('span', { class: 'picker-label', id: 'color-label', text: 'Color' }),
        h('div', { class: 'colors', role: 'radiogroup', 'aria-labelledby': 'color-label' },
          COLORS.map(c => {
            const t = buildTheme(state.style, c.id);
            return h('button', {
              type: 'button', class: 'color-btn', role: 'radio', title: c.name, 'aria-label': c.name,
              'aria-checked': !custom && c.id === state.color ? 'true' : 'false',
              onclick: () => setColor(c.id),
              style: { '--sw-bg': t.bg, '--sw-accent': t.accent },
            });
          }))),
      h('p', { class: 'muted small', text: custom
        ? 'Using your custom colors. Pick a style or color to go back to the themes.'
        : `${styleName} ${colorName.toLowerCase()}. The sun and moon button switches between the dark and light style you used last.` }),
      customColors(state));
  };
  render();
  cleanups.push(onThemeChange(render));
  return wrap;
}

function customColors(state) {
  const c = state.custom || activeColors(state);
  const field = (label, key) => {
    const input = h('input', { type: 'color', value: c[key], 'aria-label': label });
    return { input, el: h('label', { class: 'color-field' }, input, h('span', { text: label })) };
  };
  const bg = field('Background', 'bg'), panel = field('Panels', 'panel'), accent = field('Accent', 'accent');
  const apply = () => setCustomColors({ bg: bg.input.value, panel: panel.input.value, accent: accent.input.value });
  [bg, panel, accent].forEach(f => f.input.addEventListener('change', apply));
  return h('details', { class: 'custom-colors', open: !!state.custom?.on },
    h('summary', { text: state.custom?.on ? 'Custom colors (in use)' : 'Custom colors' }),
    h('div', { class: 'color-fields' }, bg.el, panel.el, accent.el),
    h('div', { class: 'button-row' },
      h('button', { type: 'button', class: 'btn btn-small', onclick: apply }, 'Use these colors'),
      state.custom?.on ? h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: turnOffCustomColors }, 'Back to the theme') : null,
    ));
}

/* ---------- Sync ---------- */

function syncSection() {
  const wrap = h('div');
  (async () => {
    const conn = await store.getMeta('connection');
    wrap.append(await syncStatus(conn));
  })();
  return wrap;
}

async function syncStatus(conn) {
  if (!conn?.token) {
    return h('div',
      h('p', { class: 'muted', text: 'This device is not connected to GitHub yet.' }),
      h('div', { class: 'button-row' }, h('button', {
        type: 'button', class: 'btn btn-small',
        onclick: () => openSettings('danger', { openConnection: true }),
      }, 'Connect this device')));
  }
  const [pending, lastPull, lastPush] = await Promise.all([
    store.pendingCount(), store.getMeta('lastPull'), store.getMeta('lastPush'),
  ]);
  return h('div', { class: 'sync-status' },
    h('dl', { class: 'facts' },
      h('dt', { text: 'Connected to' }), h('dd', { text: `${conn.owner}/${conn.repo}` }),
      h('dt', { text: 'Last pull' }), h('dd', { text: timeAgo(lastPull) }),
      h('dt', { text: 'Last push' }), h('dd', { text: timeAgo(lastPush) }),
      h('dt', { text: 'Not pushed yet' }), h('dd', { text: pending ? plural(pending, 'change') : 'nothing' }),
    ),
    h('div', { class: 'button-row' },
      h('button', {
        type: 'button', class: 'btn btn-small btn-quiet',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Download everything again?',
            body: h('p', { text: 'The next Pull will download every item from the repo. Anything you changed here and haven\'t pushed is kept, and you\'ll be asked about any item that changed in both places.' }),
            confirm: 'Download everything',
          });
          if (!ok) return;
          await store.setBase(new Map());
          await store.setMeta('lastCommit', null);
          const { doPull } = await import('./syncui.js');
          openSheet?.close();
          doPull();
        },
      }, 'Download everything again'),
    ));
}

/* ---------- Danger zone ---------- */

function dangerZone(m) {
  const formHost = h('div', { class: 'danger-form', hidden: true });
  const changeBtn = h('button', {
    type: 'button', class: 'btn btn-small btn-danger-outline', 'aria-expanded': 'false',
    onclick: () => {
      const open = formHost.hidden;
      formHost.hidden = !open;
      changeBtn.setAttribute('aria-expanded', String(open));
      changeBtn.textContent = open ? 'Cancel' : 'Change connection';
      if (open && !formHost.firstChild) {
        formHost.append(
          h('p', { class: 'status-warn', text: 'A wrong username, repo or token stops this device from syncing until you fix it. Your data on this device and on GitHub is not affected.' }),
          connectForm({ onSaved: () => { m.close(); openSettings('sync'); } }));
      }
      if (open) formHost.querySelector('input[name=token]')?.focus();
    },
  }, 'Change connection');

  const removeBtn = h('button', {
    type: 'button', class: 'btn btn-small btn-danger-outline',
    onclick: async () => {
      const ok = await confirmDialog({
        title: 'Remove the token from this device?',
        body: h('p', { text: 'Your data stays on this device and on GitHub. To sync again, paste a token. If the token leaked, also delete it on GitHub.' }),
        confirm: 'Remove token', danger: true,
      });
      if (!ok) return;
      await forgetToken();
      toast('Token removed from this device.');
      openSettings('sync');
    },
  }, 'Remove token');

  const row = (title, text, button) => h('div', { class: 'danger-row' },
    h('div', h('strong', { text: title }), h('p', { class: 'muted small', text })),
    button);

  const zone = h('section', { class: 'danger-zone', id: 'settings-danger', 'aria-labelledby': 'settings-danger-h' },
    h('h3', { id: 'settings-danger-h', text: 'Danger zone' }),
    h('div', { class: 'danger-box' },
      row('GitHub connection', 'The username, data repo and access token this device uses to sync.', changeBtn),
      formHost,
      row('Remove token from this device', 'Stops syncing on this device until you paste a token again.', removeBtn)));
  zone.openConnection = () => { if (formHost.hidden) changeBtn.click(); };
  return zone;
}

/** The Connect to GitHub form. Also shown on the welcome card. */
export function connectForm({ onSaved, compact = false } = {}) {
  const form = h('form', { class: `connect-form ${compact ? 'compact' : ''}`.trim(), autocomplete: 'off' });
  const owner = h('input', { class: 'input', name: 'owner', required: true, autocapitalize: 'off', spellcheck: 'false' });
  const repo = h('input', { class: 'input', name: 'repo', required: true, autocapitalize: 'off', spellcheck: 'false' });
  const token = h('input', { class: 'input', name: 'token', type: 'password', required: true, autocapitalize: 'off', spellcheck: 'false', placeholder: 'github_pat_…', autocomplete: 'off' });
  const device = h('input', { class: 'input', name: 'device', required: true, maxLength: 40 });
  const status = h('div', { class: 'connect-status', role: 'status' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Test and save');
  const reveal = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': 'Show token', 'aria-pressed': 'false',
    onclick: () => {
      const showing = token.type === 'text';
      token.type = showing ? 'password' : 'text';
      reveal.setAttribute('aria-pressed', String(!showing));
    },
  }, icon('eye', { size: 20 }));

  (async () => {
    const c = (await store.getMeta('connection')) || {};
    owner.value = c.owner || DEFAULT_OWNER;
    repo.value = c.repo || DEFAULT_DATA_REPO;
    token.value = c.token || '';
    device.value = c.device || guessDeviceName();
  })();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const values = {
      owner: owner.value.trim(), repo: repo.value.trim(),
      token: token.value.trim(), device: device.value.trim() || guessDeviceName(),
    };
    if (!values.token) { showStatus('error', 'Paste your token first.'); token.focus(); return; }
    if (!/^(github_pat_|ghp_)/.test(values.token)) {
      showStatus('warn', "That doesn't look like a GitHub token (they start with github_pat_). Testing anyway…");
    } else {
      showStatus('info', 'Testing the connection…');
    }
    submit.disabled = true;
    try {
      const res = await testConnection(values);
      await saveConnection({ ...values, branch: res.branch });
      const lines = ['Connected. This device can read and write the data repo.'];
      if (!res.isPrivate) {
        showStatus('warn', `${lines[0]} Warning: this repo is public, so anyone can read your data. On GitHub, open the repo's Settings and change its visibility to Private.`);
      } else {
        showStatus('ok', lines[0]);
      }
      toast('Connected to GitHub. Tap Pull to get your data.', { kind: 'ok' });
      onSaved?.();
    } catch (err) {
      showStatus('error', err.message);
    } finally {
      submit.disabled = false;
    }
  });

  function showStatus(kind, text) {
    clear(status, h('p', { class: `status-${kind}`, text }));
  }

  const field = (label, input, hint, extra) => h('label', { class: 'field' },
    h('span', { class: 'field-label', text: label }),
    extra ? h('span', { class: 'input-with-button' }, input, extra) : input,
    hint ? h('span', { class: 'field-hint', text: hint }) : null);

  form.append(
    h('div', { class: 'field-grid' },
      field('GitHub username', owner),
      field('Data repo', repo),
    ),
    field('Access token', token, 'Saved only on this device. Get it from GitHub → Settings → Developer settings → Fine-grained tokens.', reveal),
    field('Name for this device', device, 'Shown in the repo history, like "PC", "Laptop" or "Phone".'),
    status,
    h('div', { class: 'button-row' }, submit),
  );
  return form;
}

function guessDeviceName() {
  return /Android|iPhone|Mobile/i.test(navigator.userAgent) ? 'Phone' : 'PC';
}

/* ---------- This device ---------- */

function deviceSection(cleanups) {
  const wrap = h('div', { class: 'device-section' });
  const render = async () => {
    const installed = isInstalled();
    const installEl = installed
      ? h('p', { text: 'Installed as an app on this device.' })
      : canPromptInstall()
        ? h('div', { class: 'button-row' }, h('button', { type: 'button', class: 'btn', onclick: promptInstall }, 'Install app'))
        : h('p', { class: 'muted', text: 'To install: on your phone, open Chrome\'s ⋮ menu and tap Add to Home screen. On a PC, click the install icon at the right end of the address bar in Chrome or Edge.' });

    let storageEl = null;
    if (navigator.storage?.persisted) {
      const persisted = await navigator.storage.persisted();
      const est = await navigator.storage.estimate?.().catch(() => null);
      const used = est?.usage ? `${(est.usage / 1024 / 1024).toFixed(1)} MB used on this device.` : '';
      storageEl = persisted
        ? h('p', { text: `The browser will keep this app's data. ${used}`.trim() })
        : h('div',
            h('p', { class: 'muted', text: `The browser may clear this app's data if the device runs low on space. Push regularly so GitHub has a copy. ${used}`.trim() }),
            h('div', { class: 'button-row' }, h('button', {
              type: 'button', class: 'btn btn-small',
              onclick: async () => {
                const ok = await navigator.storage.persist();
                toast(ok ? 'The browser will keep this app\'s data.' : 'The browser said no for now. Installing the app usually fixes this.');
                render();
              },
            }, 'Ask the browser to keep my data')));
    }
    const counts = await store.counts();
    const total = Object.values(counts.byCollection).reduce((a, b) => a + b, 0);
    clear(wrap, 
      installEl,
      storageEl,
      h('p', { class: 'muted', text: `Saved here: ${plural(total, 'item')}, ${plural(counts.files, 'image')}.` }),
    );
  };
  render();
  cleanups.push(onInstallChange(render));
  return wrap;
}
