/**
 * Service worker registration (vite-plugin-pwa, prompt mode) with an update toast, plus storage
 * persistence.
 *
 * Update path: a new worker installs and waits (`onNeedRefresh` → sticky "Update available —
 * Reload"); the page keeps running the old bundle under the old worker, whose precache is intact,
 * so lazy chunks (import worker, Overpass/graph-build inside the route worker) still load. Reload
 * sends SKIP_WAITING; the new worker activates, claims the page (workbox `clientsClaim`) and the
 * `controllerchange` below reloads exactly once. Nothing ever reloads on its own. A tracking
 * session in progress is no reason to refuse (feedback-2: tracking is always on): it is persisted
 * on every fix and saved as a track when the new version boots (src/app/tracking.ts).
 */
/// <reference types="vite-plugin-pwa/client" />
import { registerSW } from 'virtual:pwa-register';
import { toast } from './ui';
import { readJSON, writeJSON } from './settings';

export function initPwa(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return; // devOptions.enabled is false in vite.config.ts

  let hadController = Boolean(navigator.serviceWorker.controller);
  let offered = false; // the toast is up (workbox-window reports a waiting worker through two events)
  let updateControls = false; // the new worker already controls this page (we, or another window, told it to activate)
  let reloadRequested = false; // the user tapped Reload
  let reloading = false;

  const reloadNow = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };
  const showUpdateToast = () => {
    toast('Update available', { id: 'sw', duration: 0, action: { label: 'Reload', onClick: onReloadTap } });
  };
  const onReloadTap = () => {
    reloadRequested = true;
    if (updateControls) reloadNow();
    else void updateSW(true); // SKIP_WAITING → the waiting worker activates + claims → controllerchange → reload
  };

  const updateSW = registerSW({
    immediate: true,
    // A new worker is installed and waiting (also fired for one found while the app sat open).
    onNeedRefresh() {
      if (offered) return;
      offered = true;
      showUpdateToast();
    },
    // The plugin calls this when the new worker takes control; left empty so it never falls back to
    // its own window.location.reload() — the controllerchange listener below decides.
    onNeedReload() {},
    onOfflineReady() {
      toast('Unfog is ready to work offline', { id: 'sw', kind: 'success' });
    },
    onRegisterError(e) {
      console.warn('[pwa] service worker registration failed', e);
    },
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true; // the first worker claiming a fresh page: not an update
      return;
    }
    updateControls = true;
    if (reloadRequested) reloadNow();
    // Otherwise (another window applied the update): keep offering.
    else showUpdateToast();
  });
}

const PERSIST_KEY = 'unfog.persisted';

/** Ask for durable storage once we hold user data (after the first successful import). */
export async function requestPersistentStorage(): Promise<boolean> {
  if (readJSON<boolean>(PERSIST_KEY, false)) return true;
  try {
    const ok = (await navigator.storage?.persist?.()) ?? false;
    if (ok) writeJSON(PERSIST_KEY, true);
    return ok;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e) return null;
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}
