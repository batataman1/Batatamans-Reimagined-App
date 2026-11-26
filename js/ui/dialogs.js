// Modal dialogs, confirmations, progress and toasts.

import { h } from '../core/util.js';
import { icon } from './icons.js';

/**
 * Open a modal. Resolves with the id of the action pressed, or null if dismissed.
 * actions: [{ id, label, kind: 'primary' | 'danger' | 'quiet' }]
 */
export function openModal({ title, body, actions = [], dismissible = true, className = '', onOpen } = {}) {
  let resolveFn;
  const result = new Promise(r => { resolveFn = r; });
  const dialog = h('dialog', { class: `modal ${className}`.trim(), 'aria-label': title });

  let done = false;
  const close = value => {
    if (done) return;
    done = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    resolveFn(value ?? null);
  };
  // If the browser closes it (e.g. Escape pressed twice), clean up the same way.
  dialog.addEventListener('close', () => close(null));

  const head = h('header', { class: 'modal-head' },
    h('h2', { text: title }),
    dismissible ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(null) }, icon('close', { size: 20 })) : null,
  );
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const footer = actions.length
    ? h('footer', { class: 'modal-actions' }, actions.map(a =>
        h('button', {
          type: 'button',
          class: `btn ${a.kind ? `btn-${a.kind}` : ''}`.trim(),
          'data-action': a.id,
          onclick: () => (a.onClick ? a.onClick(close) : close(a.id)),
        }, a.label)))
    : null;

  dialog.append(h('div', { class: 'modal-card' }, head, bodyEl, footer));
  dialog.addEventListener('cancel', e => { e.preventDefault(); if (dismissible) close(null); });
  dialog.addEventListener('click', e => { if (e.target === dialog && dismissible) close(null); });
  document.body.append(dialog);
  dialog.showModal();
  onOpen?.(dialog);
  return { dialog, body: bodyEl, close, result, setActionsDisabled };

  function setActionsDisabled(disabled) {
    dialog.querySelectorAll('.modal-actions button').forEach(b => { b.disabled = disabled; });
  }
}

export function confirmDialog({ title, body, confirm = 'OK', cancel = 'Cancel', danger = false }) {
  return openModal({
    title, body,
    actions: [{ id: 'cancel', label: cancel, kind: 'quiet' }, { id: 'ok', label: confirm, kind: danger ? 'danger' : 'primary' }],
  }).result.then(v => v === 'ok');
}

/** choices: [{ id, label, kind }]. Resolves with the chosen id or null. */
export function choiceDialog({ title, body, choices, cancel = 'Cancel' }) {
  return openModal({
    title, body,
    actions: [{ id: 'cancel', label: cancel, kind: 'quiet' }, ...choices],
  }).result.then(v => (v === 'cancel' ? null : v));
}

export function messageDialog({ title, body, ok = 'OK' }) {
  return openModal({ title, body, actions: [{ id: 'ok', label: ok, kind: 'primary' }] }).result;
}

export function errorDialog(err, title = "That didn't work") {
  console.error(err);
  return messageDialog({ title, body: h('p', { text: err?.message || String(err) }) });
}

/** A blocking progress dialog for Push and Pull. */
export function progressDialog(title) {
  const text = h('p', { class: 'progress-text', text: 'Starting…' });
  const m = openModal({
    title, dismissible: false, className: 'modal-progress',
    body: h('div', { class: 'progress' }, h('span', { class: 'progress-bar', 'aria-hidden': 'true' }), text),
  });
  return {
    set(t) { text.textContent = t; },
    close() { m.close(null); },
  };
}

/* ---------- Toasts ---------- */

let toastHost = null;

export function toast(message, { kind = 'info', action, duration = 4200 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast toast-${kind}` },
    h('span', { text: message }),
    action ? h('button', {
      type: 'button', class: 'btn btn-quiet btn-small',
      onclick: () => { action.onClick(); remove(); },
    }, action.label) : null,
  );
  toastHost.append(el);
  const timer = action?.sticky ? null : setTimeout(remove, duration);
  function remove() { clearTimeout(timer); el.remove(); }
  return remove;
}
