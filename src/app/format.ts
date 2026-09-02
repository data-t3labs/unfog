/** Number/date formatting shared by every screen. Units follow the setting (metric / imperial). */
import type { Units } from './settings';

const MI = 1609.344;
const FT = 0.3048;

export function fmtDistance(m: number, units: Units): string {
  if (!Number.isFinite(m)) return '—';
  if (units === 'imperial') {
    const mi = m / MI;
    if (mi < 0.19) return `${Math.round(m / FT / 10) * 10} ft`;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** fmtDistance without a trailing ".0" ("3 km", "4.5 km", "1.2 mi") — for chips and labels. */
export function fmtDistanceTidy(m: number, units: Units): string {
  return fmtDistance(m, units).replace(/\.0(?=\s)/, '');
}

export function fmtArea(m2: number, units: Units): string {
  if (!Number.isFinite(m2)) return '—';
  if (units === 'imperial') {
    const mi2 = m2 / (MI * MI);
    return `${mi2 < 10 ? mi2.toFixed(mi2 < 1 ? 2 : 1) : Math.round(mi2)} mi²`;
  }
  const km2 = m2 / 1e6;
  return `${km2 < 10 ? km2.toFixed(km2 < 1 ? 2 : 1) : Math.round(km2)} km²`;
}

export function fmtMinutes(min: number): string {
  if (!Number.isFinite(min)) return '—';
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')} min` : `${h} h`;
}

/** mm:ss or h:mm:ss for a live timer. */
export function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function fmtDate(ms: number | undefined | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(ms: number | undefined | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtRelative(ms: number | undefined | null, now = Date.now()): string {
  if (!ms) return 'never';
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return fmtDate(ms);
}

export function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '—';
}

export function fmtBytes(b: number): string {
  if (!Number.isFinite(b)) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function fmtPct(p: number): string {
  return `${Math.round(p)}%`;
}
