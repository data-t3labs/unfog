/**
 * Geofabrik extract downloads for the continent build (coverage v2).
 *   - region list per continent (Geofabrik ids: `us/<state>`, Canadian provinces bare, `mexico`, …)
 *   - `fetchExtract`: resumable `curl -C -`, `.md5` verification (node:crypto), size + timing
 * Files land in `<dir>/<id with / → ->-latest.osm.pbf` next to `.md5` and an `.ok` marker.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const GEOFABRIK = 'https://download.geofabrik.de/';

const CANADA = ['alberta', 'british-columbia', 'manitoba', 'new-brunswick', 'newfoundland-and-labrador', 'northwest-territories', 'nova-scotia', 'nunavut', 'ontario', 'prince-edward-island', 'quebec', 'saskatchewan', 'yukon'];
const US = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'district-of-columbia', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new-hampshire', 'new-jersey', 'new-mexico', 'new-york', 'north-carolina', 'north-dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'puerto-rico', 'rhode-island', 'south-carolina', 'south-dakota', 'tennessee', 'texas', 'us-virgin-islands', 'utah', 'vermont', 'virginia', 'washington', 'west-virginia', 'wisconsin', 'wyoming'];

/** Extract ids per continent, in build order (pilot regions first). */
export const CONTINENTS: Record<string, string[]> = {
  'north-america': [
    'us/washington', 'us/new-york', 'british-columbia', 'us/oregon', 'us/new-jersey', 'us/idaho',
    ...US.filter((s) => !['washington', 'new-york', 'oregon', 'new-jersey', 'idaho'].includes(s)).map((s) => `us/${s}`),
    ...CANADA.filter((p) => p !== 'british-columbia'),
    'mexico', 'greenland',
  ],
};

export interface ExtractSpec {
  id: string;
  /** id with `/` → `-`: the region slug used for directories and the CLI's --region. */
  slug: string;
  url: string;
  file: string;
}

export function extractSpec(id: string, continent = 'north-america'): ExtractSpec {
  const slug = id.replace(/\//g, '-');
  const path = id.startsWith('us/') ? `${continent}/${id}` : CANADA.includes(id) ? `${continent}/canada/${id}` : `${continent}/${id}`;
  return { id, slug, url: `${GEOFABRIK}${path}-latest.osm.pbf`, file: `${slug}-latest.osm.pbf` };
}

export interface FetchResult {
  bytes: number;
  md5: string | null;
  /** true = matches Geofabrik's .md5; false = mismatch (file re-downloaded once); null = no .md5 available. */
  verified: boolean | null;
  downloadS: number;
  skipped: boolean;
}

const run = (cmd: string, args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) => resolve(code ?? 1));
  });

export function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('md5');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Expected hash from a Geofabrik `.md5` file ("<hash>  <name>"), or null. */
export function expectedMd5(md5File: string): string | null {
  if (!existsSync(md5File)) return null;
  const m = /^([0-9a-f]{32})\b/i.exec(readFileSync(md5File, 'utf8').trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Download one extract with resume + md5 check. An existing `.ok` marker (written after a verified
 * download, also by the bulk shell fetch) skips the download but still verifies when asked.
 */
export async function fetchExtract(spec: ExtractSpec, dir: string, opts: { log?: (m: string) => void; verify?: boolean; curl?: string } = {}): Promise<FetchResult> {
  const log = opts.log ?? (() => {});
  const file = join(dir, spec.file), md5Path = file + '.md5', ok = file + '.ok';
  let downloadS = 0, skipped = false;
  const download = async () => {
    const t0 = Date.now();
    log(`  fetching ${spec.url}`);
    const code = await run(opts.curl ?? 'curl', ['-L', '-C', '-', '-sS', '--retry', '5', '--retry-delay', '5', '-o', file, spec.url]);
    if (code !== 0) throw new Error(`curl exited ${code} for ${spec.url}`);
    await run(opts.curl ?? 'curl', ['-L', '-sS', '--retry', '3', '-o', md5Path, spec.url + '.md5']);
    downloadS += (Date.now() - t0) / 1000;
  };
  if (existsSync(ok) && existsSync(file)) skipped = true;
  else await download();
  let verified: boolean | null = null, md5: string | null = null;
  if (opts.verify !== false) {
    const want = expectedMd5(md5Path);
    if (want) {
      md5 = await md5File(file);
      verified = md5 === want;
      if (!verified && skipped) { // stale/corrupt cached file: refetch once
        log(`  md5 mismatch for cached ${spec.file}; re-downloading`);
        skipped = false;
        await download();
        md5 = await md5File(file);
        verified = md5 === (expectedMd5(md5Path) ?? want);
      }
      if (!verified) throw new Error(`md5 mismatch for ${spec.file}: got ${md5}, expected ${want}`);
    }
  }
  if (!existsSync(ok)) writeFileSync(ok, '');
  return { bytes: statSync(file).size, md5, verified, downloadS, skipped };
}
