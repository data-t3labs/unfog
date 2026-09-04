import { describe, expect, it } from 'vitest';
import {
  DROPBOX_PKCE_KEY,
  DROPBOX_TOKENS_KEY,
  DropboxClient,
  DropboxError,
  apiArg,
  authorizeUrl,
  beginDropboxAuth,
  completeDropboxAuth,
  dropboxAppKey,
  parseRedirect,
  pkceChallenge,
  pkceVerifier,
  stripRedirectParams,
  toSyncError,
  type DropboxTokens,
  type FetchFn,
} from './dropbox';
import { SyncError } from './scheduler';
import { memoryKV } from './state';

/** A fetch double: routes by URL substring; records every call. */
function fakeFetch(routes: Record<string, (init: RequestInit, url: string) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: FetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [k, h] of Object.entries(routes)) if (url.includes(k)) return h(init, url);
    return new Response('{"error_summary":"no route"}', { status: 404 });
  };
  return { fn, calls };
}

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const body = (init: RequestInit) => (typeof init.body === 'string' ? init.body : '');
const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

const TOKENS: DropboxTokens = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 2_000_000_000_000, accountId: 'dbid:x' };

describe('PKCE helpers', () => {
  it('verifier uses the RFC 7636 unreserved set and the challenge matches the RFC test vector', async () => {
    const v = pkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    expect(pkceVerifier(43)).toHaveLength(43);
    expect(pkceVerifier()).not.toBe(v);
    // RFC 7636 appendix B
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('authorizeUrl carries every parameter Dropbox needs for an offline PKCE sign-in', () => {
    const u = new URL(authorizeUrl({ appKey: 'k1', redirectUri: 'https://x.test/unfog/', challenge: 'CH', state: 'ST' }));
    expect(u.origin + u.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: 'k1',
      response_type: 'code',
      code_challenge: 'CH',
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      redirect_uri: 'https://x.test/unfog/',
      state: 'ST',
      scope: 'files.metadata.read files.content.read account_info.read',
    });
  });

  it('parses and strips the redirect parameters', () => {
    expect(parseRedirect('https://x.test/unfog/')).toBeNull();
    expect(parseRedirect('https://x.test/unfog/?mock=1')).toBeNull();
    expect(parseRedirect('not a url')).toBeNull();
    expect(parseRedirect('https://x.test/unfog/?code=abc&state=st')).toEqual({ code: 'abc', state: 'st' });
    expect(parseRedirect('https://x.test/unfog/?error=access_denied&error_description=The+user+said+no')).toEqual({ error: 'access_denied', errorDescription: 'The user said no' });
    expect(stripRedirectParams('https://x.test/unfog/?mock=1&code=abc&state=st&error=e&error_description=d')).toBe('https://x.test/unfog/?mock=1');
  });

  it('dropboxAppKey: the global override wins; empty means not set up', () => {
    const g = globalThis as { __unfogDropboxAppKey?: unknown };
    delete g.__unfogDropboxAppKey;
    const base = dropboxAppKey();
    g.__unfogDropboxAppKey = '  k-override ';
    expect(dropboxAppKey()).toBe('k-override');
    g.__unfogDropboxAppKey = 42;
    expect(dropboxAppKey()).toBe(base);
    delete g.__unfogDropboxAppKey;
  });

  it('apiArg escapes non-ASCII for the Dropbox-API-Arg header', () => {
    expect(apiArg({ path: '/Apps/Fog of World/Sync/23e4lltkkoke' })).toBe('{"path":"/Apps/Fog of World/Sync/23e4lltkkoke"}');
    expect(apiArg({ path: '/Café/é' })).toBe('{"path":"/Caf\\u00e9/\\u00e9"}');
  });
});

describe('sign-in round trip', () => {
  it('begin stores the verifier + state; complete verifies the state, exchanges the code with the verifier and stores the tokens', async () => {
    const store = memoryKV();
    const url = await beginDropboxAuth({ appKey: 'k1', redirectUri: 'https://x.test/unfog/', store });
    const pending = store.read<{ verifier: string; state: string; redirectUri: string }>(DROPBOX_PKCE_KEY, null as never);
    expect(pending.verifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    const u = new URL(url);
    expect(u.searchParams.get('state')).toBe(pending.state);
    expect(u.searchParams.get('code_challenge')).toBe(await pkceChallenge(pending.verifier));

    const ff = fakeFetch({
      '/oauth2/token': (init) => {
        const p = new URLSearchParams(body(init));
        expect(p.get('grant_type')).toBe('authorization_code');
        expect(p.get('code')).toBe('the-code');
        expect(p.get('code_verifier')).toBe(pending.verifier);
        expect(p.get('client_id')).toBe('k1');
        expect(p.get('redirect_uri')).toBe('https://x.test/unfog/');
        expect(p.has('client_secret')).toBe(false);
        expect(header(init, 'Content-Type')).toBe('application/x-www-form-urlencoded');
        return jsonRes({ access_token: 'at', refresh_token: 'rt', expires_in: 14400, token_type: 'bearer', account_id: 'dbid:1', uid: '1' });
      },
    });
    const tokens = await completeDropboxAuth({ url: `https://x.test/unfog/?code=the-code&state=${pending.state}`, appKey: 'k1', store, fetchFn: ff.fn, now: () => 1000 });
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 14400 * 1000, accountId: 'dbid:1' });
    expect(store.read(DROPBOX_TOKENS_KEY, null)).toEqual(tokens);
    expect(store.read(DROPBOX_PKCE_KEY, null)).toBeNull();
    // A plain open (no OAuth params) does nothing.
    expect(await completeDropboxAuth({ url: 'https://x.test/unfog/', appKey: 'k1', store, fetchFn: ff.fn })).toBeNull();
    expect(ff.calls).toHaveLength(1);
  });

  it('refuses a state mismatch, a stale attempt and a cancelled sign-in; a rejected code surfaces the description', async () => {
    const store = memoryKV();
    await beginDropboxAuth({ appKey: 'k1', redirectUri: 'https://x.test/unfog/', store });
    await expect(completeDropboxAuth({ url: 'https://x.test/unfog/?code=c&state=WRONG', appKey: 'k1', store })).rejects.toMatchObject({ tag: 'state_mismatch' });
    expect(store.read(DROPBOX_PKCE_KEY, null)).toBeNull(); // cleared either way
    await beginDropboxAuth({ appKey: 'k1', redirectUri: 'https://x.test/unfog/', store });
    const st = store.read<{ state: string }>(DROPBOX_PKCE_KEY, null as never).state;
    await expect(completeDropboxAuth({ url: `https://x.test/unfog/?code=c&state=${st}`, appKey: 'k1', store, now: () => Date.now() + 3_600_000 })).rejects.toMatchObject({ tag: 'stale' });
    await beginDropboxAuth({ appKey: 'k1', redirectUri: 'https://x.test/unfog/', store });
    await expect(completeDropboxAuth({ url: 'https://x.test/unfog/?error=access_denied', appKey: 'k1', store })).rejects.toThrow(/cancelled/);
    await beginDropboxAuth({ appKey: 'k1', redirectUri: 'https://x.test/unfog/', store });
    const st2 = store.read<{ state: string }>(DROPBOX_PKCE_KEY, null as never).state;
    const ff = fakeFetch({ '/oauth2/token': () => jsonRes({ error: 'invalid_grant', error_description: 'code has expired' }, 400) });
    await expect(completeDropboxAuth({ url: `https://x.test/unfog/?code=c&state=${st2}`, appKey: 'k1', store, fetchFn: ff.fn })).rejects.toThrow(/code has expired/);
    expect(store.read(DROPBOX_TOKENS_KEY, null)).toBeNull();
  });
});

describe('DropboxClient', () => {
  it('list_folder maps entries and the cursor; continue passes the cursor', async () => {
    const store = memoryKV({ [DROPBOX_TOKENS_KEY]: TOKENS });
    const ff = fakeFetch({
      'files/list_folder/continue': (init) => {
        expect(JSON.parse(body(init))).toEqual({ cursor: 'c1' });
        return jsonRes({ entries: [], cursor: 'c2', has_more: false });
      },
      'files/list_folder': (init) => {
        expect(header(init, 'Authorization')).toBe('Bearer at-1');
        expect(JSON.parse(body(init))).toEqual({ path: '/Apps/Fog of World/Sync', recursive: false, include_deleted: false, limit: 2000 });
        return jsonRes({
          entries: [
            { '.tag': 'file', name: '23e4lltkkoke', path_lower: '/apps/fog of world/sync/23e4lltkkoke', path_display: '/Apps/Fog of World/Sync/23e4lltkkoke', id: 'id:1', rev: 'r1', size: 1234, server_modified: '2026-09-01T00:00:00Z', content_hash: 'h' },
            { '.tag': 'folder', name: 'Import', path_lower: '/apps/fog of world/sync/import', path_display: '/Apps/Fog of World/Sync/Import', id: 'id:2' },
            { '.tag': 'deleted', name: 'gone', path_lower: '/apps/fog of world/sync/gone', path_display: '/Apps/Fog of World/Sync/gone' },
            { '.tag': 'weird', name: 'x' },
          ],
          cursor: 'c1',
          has_more: true,
        });
      },
    });
    const c = new DropboxClient({ appKey: 'k1', store, fetchFn: ff.fn, now: () => 1 });
    expect(c.connected()).toBe(true);
    const r = await c.listFolder('/Apps/Fog of World/Sync');
    expect(r).toEqual({
      entries: [
        { tag: 'file', name: '23e4lltkkoke', pathLower: '/apps/fog of world/sync/23e4lltkkoke', pathDisplay: '/Apps/Fog of World/Sync/23e4lltkkoke', rev: 'r1', size: 1234, serverModified: '2026-09-01T00:00:00Z', contentHash: 'h' },
        { tag: 'folder', name: 'Import', pathLower: '/apps/fog of world/sync/import', pathDisplay: '/Apps/Fog of World/Sync/Import' },
        { tag: 'deleted', name: 'gone', pathLower: '/apps/fog of world/sync/gone', pathDisplay: '/Apps/Fog of World/Sync/gone' },
      ],
      cursor: 'c1',
      hasMore: true,
    });
    const r2 = await c.listFolderContinue('c1');
    expect(r2).toEqual({ entries: [], cursor: 'c2', hasMore: false });
  });

  it('download sends Dropbox-API-Arg (escaped) to the content host and returns the bytes', async () => {
    const store = memoryKV({ [DROPBOX_TOKENS_KEY]: TOKENS });
    const ff = fakeFetch({
      'content.dropboxapi.com/2/files/download': (init) => {
        expect(header(init, 'Dropbox-API-Arg')).toBe('{"path":"/apps/fog of world/sync/caf\\u00e9"}');
        expect(header(init, 'Authorization')).toBe('Bearer at-1');
        expect(init.body).toBeUndefined();
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Dropbox-API-Result': '{"name":"café"}' } });
      },
    });
    const c = new DropboxClient({ appKey: 'k1', store, fetchFn: ff.fn, now: () => 1 });
    expect(await c.download('/apps/fog of world/sync/café')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('classifies errors: path/not_found, reset, 429 + Retry-After (retryable), 5xx (retryable), network (retryable), other 4xx', async () => {
    const store = memoryKV({ [DROPBOX_TOKENS_KEY]: TOKENS });
    let mode = 'not_found';
    const ff = fakeFetch({
      'files/list_folder': () => {
        switch (mode) {
          case 'not_found':
            return jsonRes({ error_summary: 'path/not_found/', error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, 409);
          case 'reset':
            return jsonRes({ error_summary: 'reset/', error: { '.tag': 'reset' } }, 409);
          case '429':
            return jsonRes({ error_summary: 'too_many_requests/', error: { '.tag': 'too_many_requests' } }, 429, { 'Retry-After': '7' });
          case '503':
            return new Response('upstream', { status: 503 });
          case 'network':
            throw new TypeError('Failed to fetch');
          default:
            return jsonRes({ error_summary: 'other/', error: { '.tag': 'other' } }, 400);
        }
      },
    });
    const c = new DropboxClient({ appKey: 'k1', store, fetchFn: ff.fn, now: () => 1 });
    const err = async (): Promise<DropboxError> => {
      try {
        await c.listFolder('/x');
      } catch (e) {
        return e as DropboxError;
      }
      throw new Error('did not throw');
    };
    let e = await err();
    expect(e).toBeInstanceOf(DropboxError);
    expect(e).toMatchObject({ status: 409, tag: 'path', subTag: 'not_found', retryable: false });
    expect(e.notFound).toBe(true);
    mode = 'reset';
    e = await err();
    expect(e.reset).toBe(true);
    mode = '429';
    e = await err();
    expect(e).toMatchObject({ status: 429, retryable: true, retryAfterMs: 7000 });
    expect(toSyncError(e)).toMatchObject({ retryable: true, retryAfterMs: 7000 });
    mode = '503';
    e = await err();
    expect(e).toMatchObject({ status: 503, retryable: true });
    mode = 'network';
    e = await err();
    expect(e).toMatchObject({ status: 0, retryable: true });
    expect(e.message).toMatch(/No connection to Dropbox/);
    mode = 'other';
    e = await err();
    expect(e).toMatchObject({ status: 400, tag: 'other', retryable: false });
    expect(toSyncError(new Error('plain'))).toBeInstanceOf(SyncError);
    expect(toSyncError(new Error('plain')).retryable).toBe(false);
  });

  it('refreshes an expired access token once (401 expired_access_token → refresh → retry), stores the new token, and refreshes early when close to expiry', async () => {
    const store = memoryKV({ [DROPBOX_TOKENS_KEY]: TOKENS });
    let refreshes = 0;
    let lists = 0;
    const ff = fakeFetch({
      '/oauth2/token': (init) => {
        refreshes++;
        const p = new URLSearchParams(body(init));
        expect(p.get('grant_type')).toBe('refresh_token');
        expect(p.get('refresh_token')).toBe('rt-1');
        expect(p.get('client_id')).toBe('k1');
        return jsonRes({ access_token: `at-${refreshes + 1}`, expires_in: 14400, token_type: 'bearer' });
      },
      'files/list_folder': (init) => {
        lists++;
        if (header(init, 'Authorization') === 'Bearer at-1') return jsonRes({ error_summary: 'expired_access_token/', error: { '.tag': 'expired_access_token' } }, 401);
        return jsonRes({ entries: [], cursor: 'c', has_more: false });
      },
    });
    let now = 1_000;
    const c = new DropboxClient({ appKey: 'k1', store, fetchFn: ff.fn, now: () => now });
    await c.listFolder('/x');
    expect(refreshes).toBe(1);
    expect(lists).toBe(2);
    expect(store.read<DropboxTokens>(DROPBOX_TOKENS_KEY, null as never)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-1', accountId: 'dbid:x', expiresAt: 1000 + 14400 * 1000 });
    // Within a minute of expiry: refreshed before the call, no 401 round trip.
    now = 1000 + 14400 * 1000 - 30_000;
    await c.listFolder('/x');
    expect(refreshes).toBe(2);
    expect(lists).toBe(3);
    expect(store.read<DropboxTokens>(DROPBOX_TOKENS_KEY, null as never).accessToken).toBe('at-3');
  });

  it('without a refresh token an expired sign-in is a non-retryable auth error; disconnect forgets everything', async () => {
    const store = memoryKV({ [DROPBOX_TOKENS_KEY]: { accessToken: 'only', expiresAt: 500 } });
    const ff = fakeFetch({});
    const c = new DropboxClient({ appKey: 'k1', store, fetchFn: ff.fn, now: () => 1000 });
    await expect(c.listFolder('/x')).rejects.toMatchObject({ status: 401, retryable: false });
    expect(ff.calls).toHaveLength(0);
    c.disconnect();
    expect(c.connected()).toBe(false);
    await expect(c.listFolder('/x')).rejects.toMatchObject({ tag: 'not_connected' });
  });

  it('currentAccount reads users/get_current_account', async () => {
    const store = memoryKV({ [DROPBOX_TOKENS_KEY]: TOKENS });
    const ff = fakeFetch({ 'users/get_current_account': () => jsonRes({ account_id: 'dbid:x', email: 'j@example.com', name: { display_name: 'Jacob' } }) });
    const c = new DropboxClient({ appKey: 'k1', store, fetchFn: ff.fn, now: () => 1 });
    expect(await c.currentAccount()).toEqual({ accountId: 'dbid:x', email: 'j@example.com', displayName: 'Jacob' });
  });
});
