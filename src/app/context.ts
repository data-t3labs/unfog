/** What every screen gets from main.ts. Interface only — avoids import cycles. */
import type { Engines } from './engines';
import type { Shell } from './shell';
import type { AppSettings } from './settings';
import type { TrackingController } from './tracking';
import type { UnfogMap } from '../map/map';
import type { LocationManager } from '../map/location';
import type { Recorder } from '../record/session';
import type { LonLat } from '../routing/api';

export interface Destination {
  name: string;
  locality?: string;
  lonlat: LonLat;
  /** Route origin override (default: the user's position, else the map centre). */
  origin?: LonLat;
}

/** The collapsible sections of the Help screen (src/app/help.ts). */
export type HelpSection = 'export' | 'install' | 'tracking' | 'always' | 'location' | 'routes' | 'navigate' | 'settings';

export interface AppContext {
  engines: Engines;
  map: UnfogMap;
  shell: Shell;
  location: LocationManager;
  recorder: Recorder;
  /** "Track my movement": the switch, the passive session and the status pill (src/app/tracking.ts). */
  tracking: TrackingController;
  settings(): AppSettings;
  /** The cell store changed (import, tracking checkpoint, delete): refresh overlays, novelty cache, stat chip. */
  dataChanged(): Promise<void>;
  /** Re-render overlay tiles (settings change) without touching the route cache. */
  overlayChanged(): void;
  /** Start location updates from a user gesture; resolves false when denied/unavailable (a toast is shown). */
  requestLocation(): Promise<boolean>;
  openRoute(dest: Destination): void;
  /** Loop mode ("Explore from here"): round trips from the user's position, else the map centre. */
  openLoop(from?: LonLat): void;
  /** Switch to Help with one section expanded and scrolled into view. */
  openHelp(section: HelpSection): void;
}
