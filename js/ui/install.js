// Install-as-app support (home screen on the phone, taskbar on Windows).

let deferred = null;
const listeners = new Set();

export function initInstall() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    listeners.forEach(fn => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach(fn => fn());
  });
}

export const onInstallChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const canPromptInstall = () => !!deferred;
export const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

export async function promptInstall() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  listeners.forEach(fn => fn());
  return outcome === 'accepted';
}
