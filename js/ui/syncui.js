// The Pull and Push buttons: the conversations with the user around syncing.

import { h, plural } from '../core/util.js';
import { clientFromSettings, planSync, applyIncoming, pushPending } from '../core/sync.js';
import { choiceDialog, confirmDialog, errorDialog, progressDialog, toast } from './dialogs.js';
import { openSettings } from './settings.js';
import { reviewChanges } from './review.js';

let busy = false;

function itemList(items, max = 8) {
  const shown = items.slice(0, max);
  return h('ul', { class: 'item-list' },
    shown.map(i => h('li', { text: i.label })),
    items.length > max ? h('li', { class: 'muted', text: `and ${items.length - max} more` }) : null,
  );
}

async function getClient() {
  const c = await clientFromSettings();
  if (!c) {
    toast('Connect this device to GitHub first.');
    openSettings('sync');
    return null;
  }
  return c;
}

/** Ask what to do about items changed both here and in the repo. Returns true (keep mine), false (use repo) or null. */
async function askAboutOverlaps(plan) {
  const choice = await choiceDialog({
    title: 'Some items changed in both places',
    body: [
      h('p', { text: `${plural(plan.overlaps.length, 'item')} changed on this device and on another device since your last Pull:` }),
      itemList(plan.overlaps),
      h('p', { class: 'muted', text: 'Everything else from the repo will be downloaded either way.' }),
    ],
    choices: [
      { id: 'repo', label: "Use the repo's versions", kind: 'quiet' },
      { id: 'mine', label: "Keep this device's versions", kind: 'primary' },
    ],
  });
  if (choice === null) return null;
  return choice === 'mine';
}

export async function doPull() {
  if (busy) return;
  const c = await getClient();
  if (!c) return;
  busy = true;
  let prog = progressDialog('Pulling from GitHub');
  try {
    prog.set('Checking the data repo');
    const plan = await planSync(c.gh);
    if (!plan.incoming.length) {
      prog.close();
      toast('Already up to date.');
      return;
    }
    let keepMine = false;
    if (plan.overlaps.length) {
      prog.close();
      const answer = await askAboutOverlaps(plan);
      if (answer === null) { toast('Pull cancelled. Nothing changed.'); return; }
      keepMine = answer;
      prog = progressDialog('Pulling from GitHub');
    }
    const res = await applyIncoming(c.gh, plan, { keepMine, onProgress: t => prog.set(t) });
    prog.close();
    toast(res.keptMine
      ? `Pulled ${plural(res.downloaded, 'change')}. Kept your versions of ${plural(res.keptMine, 'item')}; Push to send them.`
      : `Pulled ${plural(res.downloaded, 'change')}.`, { kind: 'ok' });
  } catch (e) {
    prog.close();
    errorDialog(e, "Pull didn't finish");
  } finally {
    busy = false;
  }
}

export async function doPush() {
  if (busy) return;
  const c = await getClient();
  if (!c) return;
  busy = true;
  let prog = progressDialog('Pushing to GitHub');
  try {
    prog.set('Checking the data repo');
    let plan = await planSync(c.gh);
    if (!plan.pending.length) {
      prog.close();
      toast(plan.incoming.length
        ? 'Nothing to push from this device, but the repo has newer changes. Tap Pull to get them.'
        : 'Nothing to push. Everything on this device is already on GitHub.');
      return;
    }

    if (plan.incoming.length) {
      prog.close();
      const ok = await resolveBeforePush(c, plan);
      if (!ok) return;
      prog = progressDialog('Pushing to GitHub');
      prog.set('Checking the data repo');
      plan = await planSync(c.gh);
      if (plan.incoming.length) throw new Error('The repo changed again while you were choosing. Tap Push again.');
      if (!plan.pending.length) { prog.close(); toast('Nothing left to push.'); return; }
    }

    // Let the user check what's about to be sent, and leave things out.
    prog.close();
    const chosen = await reviewChanges(c.gh);
    if (chosen === false) return;
    if (chosen === null) { toast('Push cancelled. Nothing changed.'); return; }
    if (!chosen.size) { toast('Nothing to push.'); return; }
    prog = progressDialog('Pushing to GitHub');
    prog.set('Checking the data repo');
    plan = await planSync(c.gh);
    if (plan.incoming.length) throw new Error('Another device pushed while you were checking your changes. Tap Push again.');
    const selected = plan.pending.filter(p => chosen.has(p.repoPath));
    if (!selected.length) { prog.close(); toast('Nothing to push.'); return; }

    const res = await pushPending(c.gh, { ...plan, pending: selected }, { device: c.connection.device || 'This device', onProgress: t => prog.set(t) });
    prog.close();
    const total = res.changed + res.removed;
    const left = plan.pending.length - selected.length;
    toast((total ? `Pushed ${plural(total, 'change')} to GitHub.` : 'GitHub already had these changes.')
      + (left ? ` ${plural(left, 'change')} left on this device for later.` : ''), { kind: 'ok' });
  } catch (e) {
    prog.close();
    errorDialog(e, "Push didn't finish");
  } finally {
    busy = false;
  }
}

/** The repo changed since this device last pulled. Warn, and only continue if the user agrees. */
async function resolveBeforePush(c, plan) {
  const overlaps = plan.overlaps;
  if (!overlaps.length) {
    const choice = await choiceDialog({
      title: 'The repo has newer changes',
      body: [
        h('p', { text: `Another device pushed ${plural(plan.incoming.length, 'change')} since this device last pulled. None of them are items you changed here, so nothing will be overwritten.` }),
        itemList(plan.incoming),
      ],
      choices: [{ id: 'pullpush', label: 'Pull them, then push', kind: 'primary' }],
    });
    if (choice !== 'pullpush') { toast('Push cancelled. Nothing changed.'); return false; }
    await runPull(c, plan, true);
    return true;
  }

  const choice = await choiceDialog({
    title: 'The repo changed since your last Pull',
    body: [
      h('p', { text: `Another device pushed ${plural(plan.incoming.length, 'change')}. ${plural(overlaps.length, 'item')} also changed on this device:` }),
      itemList(overlaps),
      h('p', { class: 'muted', text: 'Pull first to choose what to keep, or keep this device\'s versions and replace the repo\'s versions of these items.' }),
    ],
    choices: [
      { id: 'pull', label: 'Pull first', kind: 'quiet' },
      { id: 'mine', label: 'Keep mine and push', kind: 'danger' },
    ],
  });
  if (choice === null) { toast('Push cancelled. Nothing changed.'); return false; }
  if (choice === 'pull') {
    const keepMine = await askAboutOverlaps(plan);
    if (keepMine === null) { toast('Pull cancelled. Nothing changed.'); return false; }
    await runPull(c, plan, keepMine);
    toast('Pulled. Check the changes, then tap Push.', { kind: 'ok' });
    return false;
  }
  const sure = await confirmDialog({
    title: 'Replace these items in the repo?',
    body: [
      h('p', { text: "The repo's versions of these items will be replaced with this device's versions. Their old versions stay in the repo's history on GitHub." }),
      itemList(overlaps),
    ],
    confirm: 'Replace and push',
    danger: true,
  });
  if (!sure) { toast('Push cancelled. Nothing changed.'); return false; }
  await runPull(c, plan, true);
  return true;
}

async function runPull(c, plan, keepMine) {
  const prog = progressDialog('Pulling from GitHub');
  try {
    await applyIncoming(c.gh, plan, { keepMine, onProgress: t => prog.set(t) });
  } finally {
    prog.close();
  }
}
