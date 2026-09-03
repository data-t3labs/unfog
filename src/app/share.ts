/** Getting a file off the phone: the iOS share sheet when it takes files, else a download. */
import type { Track } from '../grid/types';
import { gpxFileName, trackToGpx } from '../record/gpx';
import { el, toast } from './ui';

/**
 * iOS share sheet when it takes files (Home Screen app + Safari 15+), else an <a download>.
 * 'cancelled' = the user dismissed the share sheet (AbortError): nothing left the device, so
 * callers must not record a backup/export as done.
 */
export async function shareOrDownload(name: string, content: BlobPart, type: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([content], name, { type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean; share?: (d: ShareData) => Promise<void> };
  if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
      // NotAllowedError (no user activation), TypeError… → fall through to the download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

/** A tracked session as GPX (for Fog of World's Import folder). */
export async function exportTrackGpx(track: Track): Promise<void> {
  if (track.points.length < 2) {
    toast('Nothing to export — this session has fewer than 2 GPS points.');
    return;
  }
  const r = await shareOrDownload(gpxFileName(track), trackToGpx(track), 'application/gpx+xml');
  if (r === 'cancelled') return;
  toast(r === 'shared' ? 'GPX shared' : 'GPX downloaded', { kind: 'success' });
}
