/** Service worker registration (vite-plugin-pwa, autoUpdate) with an update toast, plus storage persistence. */
/// <reference types="vite-plugin-pwa/client" />
import { registerSW } from 'virtual:pwa-register';
import { toast } from './ui';
import { readJSON, writeJSON } from './settings';

export function initPwa(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return; // devOptions.enabled is false in vite.config.ts
  registerSW({
    immediate: true,
    // autoUpdate mode: the new worker is already in control; we choose when to reload.
    onNeedReload() {
      toast('Update available', { id: 'sw', duration: 0, action: { label: 'Reload', onClick: () => window.location.reload() } });
    },
    onOfflineReady() {
      toast('Unfog is ready to work offline', { id: 'sw', kind: 'success' });
    },
    onRegisterError(e) {
      console.warn('[pwa] service worker registration failed', e);
    },
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
