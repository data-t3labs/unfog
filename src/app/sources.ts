/**
 * Data → Sources: the two "always recording" cards (src/sync). Fog of World via Dropbox
 * (Connect / last pull / cells added / Disconnect) and Overland (receiver URL + token, Test,
 * last pull, the day tracks it produced). Each card says exactly what is missing when it is not
 * set up yet — the Dropbox app key or the receiver — instead of showing a button that cannot
 * work. Mounted by src/app/data.ts; reads the sync singleton (src/sync/setup.ts).
 */
import type { TrackSummary } from '../grid/api';
import type { AppContext } from './context';
import { fmtDateTime, fmtDistance, fmtInt, fmtRelative } from './format';
import { icons } from './icons';
import { DEFAULT_FOW_SYNC_FOLDER } from '../sync/fow-dropbox';
import { OVERLAND_SOURCE, maskToken } from '../sync/overland';
import type { SourceStatus } from '../sync/scheduler';
import { getSync, type Sync } from '../sync/setup';
import { append, clear, confirmSheet, el, svg, toast } from './ui';

export interface SourcesSection {
  el: HTMLElement;
  refresh(): Promise<void>;
}

/** Where Dropbox sends the user back — shown in the setup steps so the app console entry matches exactly. */
function redirectUri(): string {
  try {
    return new URL(import.meta.env.BASE_URL ?? '/', location.origin).toString();
  } catch {
    return '/';
  }
}

function stepsList(items: Array<string | HTMLElement>): HTMLElement {
  return el('ol', { class: 'steps small' }, items.map((i) => el('li', typeof i === 'string' ? { text: i } : {}, typeof i === 'string' ? null : i)));
}

function pullLine(st: SourceStatus, lastAt: number | null, describe: () => string | null): HTMLElement {
  if (st.running) return el('div', { class: 'st spinner-row' }, el('span', { class: 'spinner' }), ' ', st.progress || 'Pulling…');
  if (st.lastError) return el('div', { class: 'error small', text: `Last pull failed: ${st.lastError}${st.nextRetryAt ? ' — will try again' : ''}` });
  const d = describe();
  if (!lastAt || !d) return el('div', { class: 'st', text: 'Not pulled yet' });
  return el('div', { class: 'st', text: `Last pull ${fmtRelative(lastAt)} · ${d}` });
}

export function createSourcesSection(ctx: AppContext, sync: Sync | null = getSync()): SourcesSection {
  const fowCard = el('div', { class: 'source-card', 'data-source': 'fow-dropbox' });
  const overlandCard = el('div', { class: 'source-card', 'data-source': 'overland' });
  const root = el(
    'div',
    { id: 'sources', class: 'sources' },
    el('h3', { text: 'Sources' }),
    el(
      'p',
      { class: 'muted' },
      'iOS only lets Unfog record while it is open. These two record for you all day; Unfog pulls what is new every time it opens (and every 15 minutes while open). ',
      el('button', { class: 'text-link', type: 'button', onclick: () => ctx.openHelp('always') }, 'How this works'),
    ),
    fowCard,
    overlandCard,
  );

  if (!sync) {
    fowCard.appendChild(el('p', { class: 'muted small', text: 'Sources are not available in this build.' }));
    return { el: root, async refresh() {} };
  }
  const { scheduler, fow, overland } = sync;
  let overlandEditing = false;

  // ---------------------------------------------------------------- Fog of World via Dropbox
  function renderFow(): void {
    clear(fowCard);
    const st = scheduler.status(fow.id);
    const s = fow.state();
    fowCard.appendChild(el('div', { class: 'name', text: 'Fog of World via Dropbox' }));
    if (!fow.configured()) {
      fowCard.append(
        el('div', { class: 'status warn', text: 'Not set up yet' }),
        el('p', { class: 'muted small', text: 'This needs a one-time Dropbox app key from the person running Unfog. Until then, keep importing Sync.zip with Import files above — the map lines up exactly either way.' }),
        el(
          'details',
          { class: 'setup-steps' },
          el('summary', { text: 'Steps for the person running Unfog' }),
          stepsList([
            'dropbox.com/developers/apps → Create app → Scoped access → Full Dropbox (an App-folder app cannot see Fog of World’s folder) → any name, e.g. Unfog.',
            'Permissions tab: tick files.metadata.read, files.content.read and account_info.read → Submit.',
            `Settings tab → OAuth 2 → Redirect URIs → add exactly ${redirectUri()}`,
            'Copy the App key → GitHub repo → Settings → Secrets and variables → Actions → Variables → New repository variable VITE_DROPBOX_APP_KEY.',
            'Deploy again (push, or Actions → Build and deploy → Run workflow). This card then shows Connect Dropbox.',
          ]),
        ),
      );
      return;
    }
    if (!fow.connected()) {
      const connectBtn = el('button', { class: 'btn primary', type: 'button' }, svg(icons.upload), 'Connect Dropbox');
      connectBtn.addEventListener('click', async () => {
        connectBtn.disabled = true;
        try {
          const url = await fow.connectUrl();
          location.assign(url);
        } catch (e) {
          toast(`Could not start the Dropbox sign-in: ${(e as Error)?.message ?? e}`, { kind: 'error', duration: 6000 });
          connectBtn.disabled = false;
        }
      });
      fowCard.append(
        el('div', { class: 'status', text: 'Not connected' }),
        el('p', { class: 'muted small', text: 'Fog of World keeps recording in the background. Let it sync to Dropbox, and Unfog pulls the changed tiles by itself — no more Sync.zip.' }),
        stepsList([
          'In Fog of World: Settings → Sync → Dropbox → sign in → Sync Now. Leave Auto Sync on.',
          'Tap Connect Dropbox and allow Unfog to read your Dropbox. You come back here when it is done.',
          'That is all. Unfog pulls on every open and every 15 minutes while it is open.',
        ]),
        connectBtn,
        folderRow(s.folder),
      );
      return;
    }
    const who = s.account?.email ?? s.account?.displayName;
    append(fowCard, [
      el('div', { class: 'status ok', text: who ? `Connected · ${who}` : 'Connected' }),
      pullLine(st, s.lastPull?.at ?? null, () => {
        const lp = s.lastPull;
        if (!lp) return null;
        if (lp.files === 0) return 'nothing new';
        return `${fmtInt(lp.files)} tile${lp.files === 1 ? '' : 's'} · ${fmtInt(lp.cellsAdded)} cells added`;
      }),
      s.lastPull?.note ? el('div', { class: 'muted small', text: s.lastPull.note }) : null,
      el('div', { class: 'muted small', text: `${fmtInt(s.totalCellsAdded)} cells from Dropbox so far` }),
    ]);
    const pullBtn = el('button', { class: 'btn small', type: 'button', disabled: st.running }, 'Pull now');
    pullBtn.addEventListener('click', () => void scheduler.kick('manual', fow.id));
    const disconnectBtn = el('button', { class: 'btn small ghost', type: 'button' }, 'Disconnect');
    disconnectBtn.addEventListener('click', async () => {
      if (!(await confirmSheet({ title: 'Disconnect Dropbox?', body: 'Unfog forgets the sign-in. Cells already on the map stay. You can connect again any time.', okLabel: 'Disconnect', danger: true }))) return;
      fow.disconnect();
      toast('Dropbox disconnected');
      renderFow();
    });
    fowCard.append(el('div', { class: 'btn-row left' }, pullBtn, disconnectBtn), folderRow(s.folder));
  }

  function folderRow(folder: string): HTMLElement {
    const input = el('input', { type: 'text', class: 'text-field', value: folder, 'aria-label': 'Sync folder', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    const save = el('button', { class: 'btn small ghost', type: 'button' }, 'Save');
    save.addEventListener('click', () => {
      const next = fow.setFolder(input.value);
      input.value = next.folder;
      toast(`Sync folder set to ${next.folder}`);
      renderFow();
    });
    return el(
      'details',
      { class: 'setup-steps' },
      el('summary', { text: 'Sync folder' }),
      el('p', { class: 'muted small', text: `Where Fog of World writes its Sync folder in your Dropbox. Default: ${DEFAULT_FOW_SYNC_FOLDER} (Dropbox → Apps → Fog of World → Sync).` }),
      el('div', { class: 'field-row' }, input, save),
    );
  }

  // ---------------------------------------------------------------- Overland
  let overlandGen = 0;
  async function renderOverland(): Promise<void> {
    // Progress events arrive faster than listTracks answers: only the newest render may paint.
    const gen = ++overlandGen;
    const configured = overland.configured();
    let tracks: TrackSummary[] = [];
    if (configured) {
      try {
        tracks = (await ctx.engines.grid.listTracks()).filter((t) => t.source === OVERLAND_SOURCE).sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0));
      } catch {
        tracks = [];
      }
    }
    if (gen !== overlandGen) return;
    clear(overlandCard);
    const st = scheduler.status(overland.id);
    const s = overland.state();
    overlandCard.append(
      el('div', { class: 'name', text: 'Overland' }),
      el('p', { class: 'muted small', text: 'Overland is a free iOS app that logs where you go in the background and sends it to a small receiver of your own. Unfog pulls from that receiver every time it opens.' }),
    );
    if (!configured) overlandCard.appendChild(el('div', { class: 'status warn', text: 'Not set up yet' }));
    else {
      let host = s.url;
      try {
        host = new URL(s.url).host;
      } catch {
        /* keep */
      }
      append(overlandCard, [
        el('div', { class: 'status ok', text: `Receiver ${host} · token ${maskToken(s.token)}` }),
        pullLine(st, s.lastPull?.at ?? null, () => {
          const lp = s.lastPull;
          if (!lp) return null;
          if (lp.batches === 0) return 'nothing new';
          return `${fmtInt(lp.batches)} batch${lp.batches === 1 ? '' : 'es'} · ${fmtInt(lp.points)} points`;
        }),
        s.lastTest ? el('div', { class: `muted small ${s.lastTest.ok ? '' : 'warn'}`, text: `Test ${fmtRelative(s.lastTest.at)}: ${s.lastTest.message}` }) : null,
        el('div', { class: 'muted small', text: `${fmtInt(s.totalPoints)} points from Overland so far` }),
      ]);
    }

    if (!configured || overlandEditing) {
      const urlInput = el('input', { type: 'url', class: 'text-field', value: s.url, placeholder: 'https://unfog-overland.<name>.workers.dev', 'aria-label': 'Receiver URL', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', inputmode: 'url' });
      const tokenInput = el('input', { type: 'password', class: 'text-field', value: s.token, placeholder: 'token', 'aria-label': 'Token', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: 'off' });
      const saveBtn = el('button', { class: 'btn small primary', type: 'button' }, 'Save');
      saveBtn.addEventListener('click', () => {
        try {
          overland.configure(urlInput.value, tokenInput.value);
          overlandEditing = false;
          toast('Overland receiver saved — tap Test');
          void renderOverland();
        } catch (e) {
          toast((e as Error)?.message ?? String(e), { kind: 'error' });
        }
      });
      const cancel = configured ? el('button', { class: 'btn small ghost', type: 'button', onclick: () => { overlandEditing = false; void renderOverland(); } }, 'Cancel') : null;
      overlandCard.append(
        el('p', { class: 'muted small', text: configured ? 'Change the receiver address or token:' : 'Paste the receiver address and the token you were given, Save, then Test.' }),
        el('label', { class: 'field' }, el('span', { text: 'Receiver URL' }), urlInput),
        el('label', { class: 'field' }, el('span', { text: 'Token' }), tokenInput),
        el('div', { class: 'btn-row left' }, saveBtn, cancel),
      );
    }

    if (configured) {
      const testBtn = el('button', { class: 'btn small', type: 'button' }, 'Test');
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        const r = await overland.test();
        toast(r.message, { kind: r.ok ? 'success' : 'error', duration: 6000 });
        testBtn.disabled = false;
        void renderOverland();
      });
      const pullBtn = el('button', { class: 'btn small', type: 'button', disabled: st.running }, 'Pull now');
      pullBtn.addEventListener('click', () => void scheduler.kick('manual', overland.id));
      const changeBtn = overlandEditing ? null : el('button', { class: 'btn small ghost', type: 'button', onclick: () => { overlandEditing = true; void renderOverland(); } }, 'Change');
      const forgetBtn = el('button', { class: 'btn small ghost', type: 'button' }, 'Forget');
      forgetBtn.addEventListener('click', async () => {
        if (!(await confirmSheet({ title: 'Forget the Overland receiver?', body: 'Unfog forgets the address and token. Points already on the map stay.', okLabel: 'Forget', danger: true }))) return;
        overland.forget();
        overlandEditing = false;
        toast('Overland receiver forgotten');
        void renderOverland();
      });
      overlandCard.appendChild(el('div', { class: 'btn-row left' }, testBtn, pullBtn, changeBtn, forgetBtn));
      // The day tracks Overland produced (latest first).
      if (tracks.length) {
        const list = el('div', { class: 'list' });
        for (const t of tracks.slice(0, 7)) {
          list.appendChild(
            el(
              'div',
              { class: 'row-item' },
              el('div', { class: 't' }, el('div', { class: 'name', text: t.name ?? 'Overland' }), el('div', { class: 'st', text: `${fmtDateTime(t.startMs)} · ${fmtDistance(t.lengthM, ctx.settings().units)} · ${fmtInt(t.points)} point${t.points === 1 ? '' : 's'}` })),
            ),
          );
        }
        overlandCard.appendChild(list);
      }
    }

    overlandCard.append(
      el(
        'details',
        { class: 'setup-steps' },
        el('summary', { text: 'Overland app settings' }),
        stepsList([
          'App Store → "Overland GPS Tracker" (free) → install and allow location Always with Precise on.',
          'Overland → Settings: Server URL = the receiver address above; Access Token = the token.',
          'Tracking Enabled on; Continuous Tracking Mode: Standard (or Both); Send Interval: 5 min; Locations per Batch: 100.',
          'Leave "Consider HTTP 2XX Successful" off — the receiver answers {"result":"ok"} the way Overland expects.',
          'Walk a little, then tap Test here: it should say how many batches the receiver holds.',
          'Leave Track my movement off (Help → Settings) while Overland records for you: the same walk would otherwise count twice in the heat layer.',
        ]),
      ),
      el(
        'details',
        { class: 'setup-steps' },
        el('summary', { text: 'Steps for the person running Unfog (the receiver)' }),
        stepsList([
          'Free Cloudflare account. In the repo: cd workers/overland → npx wrangler login.',
          'npx wrangler kv namespace create OVERLAND_KV → paste the id into wrangler.toml.',
          'Make a token (openssl rand -hex 16) → npx wrangler secret put OVERLAND_TOKENS → paste it.',
          'npx wrangler deploy → note the https://….workers.dev address. Full steps: workers/overland/README.md.',
          'Give the address and the token to the phone; paste them into this card.',
        ]),
      ),
    );
  }

  const unsub = scheduler.onChange((st) => {
    if (st.id === fow.id) renderFow();
    else if (st.id === overland.id) void renderOverland();
  });
  void unsub;

  return {
    el: root,
    async refresh() {
      renderFow();
      await renderOverland();
    },
  };
}
