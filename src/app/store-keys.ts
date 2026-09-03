/** localStorage keys shared by screens (values are JSON via settings.readJSON/writeJSON). */
export const LAST_IMPORT_KEY = 'unfog.lastImport'; // { at: number; summary: string }
export const LAST_BACKUP_KEY = 'unfog.lastBackup'; // { at: number }
export const REGION_DL_KEY = 'unfog.regions'; // Record<regionId, { at: number; tiles: number; bytes: number }>
export const INSTALL_DISMISS_KEY = 'unfog.installDismissed'; // number (timestamp)
export const ROUTE_PREFS_KEY = 'unfog.routePrefs'; // { detour: number; loopKm: number }
export const BACKUP_NAG_KEY = 'unfog.backupNagAt'; // number (timestamp of the last nag)
export const TRACKING_OFFER_KEY = 'unfog.trackingOffered'; // number (timestamp: the first-run "Track my movement?" card was answered)

export interface LastImport {
  at: number;
  summary: string;
}
export interface LastBackup {
  at: number;
}
export type RegionDownloads = Record<string, { at: number; tiles: number; bytes: number }>;
