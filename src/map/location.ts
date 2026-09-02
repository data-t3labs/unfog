/**
 * One shared geolocation watch for the map (follow), the locate button and the recorder.
 * Started only from a user gesture (iOS shows the prompt on the first request; we never ask on
 * load). Consumers retain/release by tag; the watch runs while any tag is retained and the page
 * is visible.
 */

export interface Fix {
  lon: number;
  lat: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
  timeMs: number;
}

export type LocationError = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

type FixListener = (fix: Fix) => void;
type ErrorListener = (err: LocationError, raw?: GeolocationPositionError) => void;

const OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 };

export class LocationManager {
  private watchId: number | null = null;
  private tags = new Set<string>();
  private fixListeners = new Set<FixListener>();
  private errorListeners = new Set<ErrorListener>();
  last: Fix | null = null;
  lastError: LocationError | null = null;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.sync();
      else this.stopWatch();
    });
  }

  get active(): boolean {
    return this.watchId !== null;
  }

  get supported(): boolean {
    return 'geolocation' in navigator;
  }

  onFix(l: FixListener): () => void {
    this.fixListeners.add(l);
    return () => this.fixListeners.delete(l);
  }

  onError(l: ErrorListener): () => void {
    this.errorListeners.add(l);
    return () => this.errorListeners.delete(l);
  }

  /** Keep the watch running for `tag`. Call from a user gesture the first time. */
  retain(tag: string): void {
    this.tags.add(tag);
    this.sync();
  }

  release(tag: string): void {
    this.tags.delete(tag);
    this.sync();
  }

  isRetained(tag: string): boolean {
    return this.tags.has(tag);
  }

  private sync(): void {
    if (this.tags.size && document.visibilityState === 'visible') this.startWatch();
    else this.stopWatch();
  }

  private startWatch(): void {
    if (this.watchId !== null) return;
    if (!this.supported) {
      this.emitError('unsupported');
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handle(pos),
      (err) => this.handleError(err),
      OPTIONS,
    );
  }

  private stopWatch(): void {
    if (this.watchId === null) return;
    navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  private handle(pos: GeolocationPosition): void {
    const c = pos.coords;
    const fix: Fix = {
      lon: c.longitude,
      lat: c.latitude,
      accuracy: c.accuracy,
      speed: c.speed ?? null,
      heading: c.heading ?? null,
      timeMs: pos.timestamp || Date.now(),
    };
    this.last = fix;
    this.lastError = null;
    for (const l of this.fixListeners) l(fix);
  }

  private handleError(err: GeolocationPositionError): void {
    const kind: LocationError = err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable';
    this.lastError = kind;
    if (kind === 'denied') {
      this.stopWatch();
      this.tags.clear();
    }
    this.emitError(kind, err);
  }

  private emitError(kind: LocationError, raw?: GeolocationPositionError): void {
    for (const l of this.errorListeners) l(kind, raw);
  }

  /**
   * A single fix: the last one if fresh, else a one-shot request. Rejects with a LocationError
   * string. Call from a user gesture when permission may not have been granted yet.
   */
  getOnce(timeoutMs = 10_000, maxAgeMs = 15_000): Promise<Fix> {
    if (this.last && Date.now() - this.last.timeMs < maxAgeMs) return Promise.resolve(this.last);
    if (!this.supported) return Promise.reject<Fix>('unsupported' as LocationError);
    return new Promise<Fix>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.handle(pos);
          resolve(this.last as Fix);
        },
        (err) => {
          this.handleError(err);
          reject(this.lastError);
        },
        { enableHighAccuracy: true, maximumAge: maxAgeMs, timeout: timeoutMs },
      );
    });
  }
}

export function describeLocationError(kind: LocationError): string {
  switch (kind) {
    case 'denied':
      return 'Location access is off for this app. See Help › Location not working.';
    case 'timeout':
      return 'Still waiting for a GPS fix — try near a window or outside.';
    case 'unsupported':
      return 'This browser has no location support.';
    default:
      return 'Location unavailable right now.';
  }
}
