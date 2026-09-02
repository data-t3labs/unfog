/**
 * Service worker registration (vite-plugin-pwa, prompt mode) with an update toast, plus storage
 * persistence.
 *
 * Update path: a new worker installs and waits (`onNeedRefresh` → sticky "Update available —
 * Reload"); the page keeps running the old bundle under the old worker, whose precache is intact,
 * so lazy chunks (import worker, Overpass/graph-build inside the route worker) still load. Reload
 * sends SKIP_WAITING; the new worker activates, claims the page (workbox `clientsClaim`) and the
 * `controllerchange` below reloads exactly once. Nothing ever reloads on its own, and never while a
 * walk is being recorded.
 */
/// <reference types="vite-plugin-pwa/client" />
import { registerSW } from 'virtual:pwa-register';
import { toast } from './ui';
import { readJSON, writeJSON } from './settings';

export interface PwaHandle {
  /** Set by main.ts once the Recorder exists: while it returns true an update is offered, never applied. */
  isRecording: () => boolean;
}

export function initPwa(): PwaHandle {
  const handle: PwaHandle = { isRecording: () => false };
  if (!('serviceWorker' in navigator)) return handle;
  if (import.meta.env.DEV) return handle; // devOptions.enabled is false in vite.config.ts

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
    if (handle.isRecording()) {
      // Never mid-walk: say so and keep the offer up (the action click dismisses the sticky toast).
      toast('Stop the recording first — the update will wait');
      showUpdateToast();
      return;
    }
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
    if (reloadRequested && !handle.isRecording()) reloadNow();
    // Otherwise (another window applied the update, or a walk is being recorded): keep offering.
    else showUpdateToast();
  });
  return handle;
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
