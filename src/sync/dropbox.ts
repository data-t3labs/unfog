/**
 * Dropbox for the browser: OAuth 2 PKCE (no app secret; `token_access_type=offline` gives a
 * refresh token so the sign-in lasts), token storage, and the three file calls the Fog of World
 * source needs — `files/list_folder`, `files/list_folder/continue`, `files/download` — plus
 * `users/get_current_account` for the "Connected as …" line.
 *
 * Verified against the Dropbox HTTP reference + OAuth guide (task report always-recording-1.md):
 *   authorize  GET  https://www.dropbox.com/oauth2/authorize?client_id&response_type=code
 *                   &code_challenge&code_challenge_method=S256&token_access_type=offline
 *                   &redirect_uri&state&scope
 *   token      POST https://api.dropboxapi.com/oauth2/token (form) grant_type=authorization_code
 *                   code, code_verifier, client_id, redirect_uri  → access_token, refresh_token,
 *                   expires_in;  grant_type=refresh_token, refresh_token, client_id → access_token
 *   list       POST https://api.dropboxapi.com/2/files/list_folder {path, recursive, limit}
 *                   → {entries[{.tag:file|folder|deleted, name, path_lower, rev, size,
 *                   server_modified, content_hash}], cursor, has_more}; 409 path/not_found
 *   continue   POST /2/files/list_folder/continue {cursor}; 409 {error:{.tag:"reset"}} → re-list
 *   download   POST https://content.dropboxapi.com/2/files/download, header
 *                   Dropbox-API-Arg: {"path"} (non-ASCII \u-escaped) → bytes; Dropbox-API-Result
 *   errors     401 expired_access_token / invalid_access_token; 429 + Retry-After; 5xx retry
 * The API answers CORS for browser apps; the app must be "Full Dropbox" access (an App-folder app
 * cannot see /Apps/Fog of World) with scopes files.metadata.read, files.content.read,
 * account_info.read.
 *
 * Tokens live under the `unfog.dropbox` key and are never logged or shown.
 */
import type { KeyValue } from './state';
import { localKV } from './state';
import { SyncError } from './scheduler';

export const DROPBOX_TOKENS_KEY = 'unfog.dropbox';
export const DROPBOX_PKCE_KEY = 'unfog.dropbox.pkce';
export const DROPBOX_SCOPES = 'files.metadata.read files.content.read account_info.read';
export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
export const DROPBOX_API = 'https://api.dropboxapi.com/2';
export const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
/** A sign-in that has not returned after this long is stale. */
const PKCE_MAX_AGE_MS = 15 * 60_000;
/** Refresh the access token this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The app key baked in at build time (`VITE_DROPBOX_APP_KEY`, a GitHub Actions variable → the
 * deploy workflow's env). `globalThis.__unfogDropboxAppKey` overrides it for tests and local
 * trials. Empty ⇒ the UI shows "Not set up yet" with the steps; nothing else is attempted.
 */
export function dropboxAppKey(): string {
  const override = (globalThis as { __unfogDropboxAppKey?: unknown }).__unfogDropboxAppKey;
  if (typeof override === 'string' && override.trim()) return override.trim();
  const env = (import.meta.env?.VITE_DROPBOX_APP_KEY as string | undefined) ?? '';
  return env.trim();
}

export interface DropboxTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when `accessToken` stops working. */
  expiresAt: number;
  accountId?: string;
}

export interface PkcePending {
  verifier: string;
  state: string;
  redirectUri: string;
  startedAt: number;
}

// ---------------------------------------------------------------- PKCE helpers

const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 64 chars from the RFC 7636 unreserved set (spec: 43–128). */
export function pkceVerifier(length = 64): string {
  const rnd = new Uint8Array(length);
  crypto.getRandomValues(rnd);
  let out = '';
  for (let i = 0; i < length; i++) out += VERIFIER_CHARS[rnd[i] % VERIFIER_CHARS.length];
  return out;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface AuthorizeParams {
  appKey: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
}

export function authorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    client_id: p.appKey,
    response_type: 'code',
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    redirect_uri: p.redirectUri,
    state: p.state,
    scope: p.scope ?? DROPBOX_SCOPES,
  });
  return `${DROPBOX_AUTHORIZE_URL}?${q.toString()}`;
}

/**
 * Start a sign-in: remember the verifier + state (localStorage — the page may be reloaded, or
 * killed by iOS, before Dropbox sends the user back) and return the URL to navigate to.
 */
export async function beginDropboxAuth(opts: { appKey: string; redirectUri: string; store?: KeyValue }): Promise<string> {
  const store = opts.store ?? localKV;
  const verifier = pkceVerifier();
  const state = pkceVerifier(24);
  const pending: PkcePending = { verifier, state, redirectUri: opts.redirectUri, startedAt: Date.now() };
  store.write(DROPBOX_PKCE_KEY, pending);
  return authorizeUrl({ appKey: opts.appKey, redirectUri: opts.redirectUri, challenge: await pkceChallenge(verifier), state });
}

export interface RedirectParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

/** The OAuth parameters in a URL, or null when it carries none (a normal app open). */
export function parseRedirect(url: string): RedirectParams | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const code = u.searchParams.get('code');
  const error = u.searchParams.get('error');
  if (!code && !error) return null;
  const out: RedirectParams = {};
  if (code) out.code = code;
  const state = u.searchParams.get('state');
  if (state) out.state = state;
  if (error) out.error = error;
  const desc = u.searchParams.get('error_description');
  if (desc) out.errorDescription = desc;
  return out;
}

/** The same URL without the OAuth parameters (for history.replaceState after the exchange). */
export function stripRedirectParams(url: string): string {
  const u = new URL(url);
  for (const k of ['code', 'state', 'error', 'error_description']) u.searchParams.delete(k);
  return u.toString();
}

// ---------------------------------------------------------------- errors

export class DropboxError extends Error {
  override name = 'DropboxError';
  constructor(
    message: string,
    public readonly status: number,
    /** `error[".tag"]` (top level) when the body was a Dropbox error, e.g. "path", "reset", "expired_access_token". */
    public readonly tag: string | null,
    /** `error.<tag>[".tag"]` one level down, e.g. "not_found" under "path". */
    public readonly subTag: string | null,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  get notFound(): boolean {
    return this.tag === 'path' && this.subTag === 'not_found';
  }
  get reset(): boolean {
    return this.tag === 'reset';
  }
  get authFailed(): boolean {
    return this.status === 401;
  }
  get expiredToken(): boolean {
    return this.status === 401 && this.tag === 'expired_access_token';
  }
}

interface DropboxErrorBody {
  error_summary?: string;
  error?: { '.tag'?: string; [k: string]: unknown } | string;
}

function tagsOf(body: DropboxErrorBody | null): { tag: string | null; subTag: string | null; summary: string } {
  const err = body?.error;
  if (!err || typeof err === 'string') return { tag: null, subTag: null, summary: body?.error_summary ?? (typeof err === 'string' ? err : '') };
  const tag = typeof err['.tag'] === 'string' ? err['.tag'] : null;
  let subTag: string | null = null;
  if (tag) {
    const inner = err[tag];
    if (inner && typeof inner === 'object' && typeof (inner as { '.tag'?: unknown })['.tag'] === 'string') subTag = (inner as { '.tag': string })['.tag'];
  }
  return { tag, subTag, summary: body?.error_summary ?? '' };
}

async function errorFrom(res: Response, what: string): Promise<DropboxError> {
  let body: DropboxErrorBody | null = null;
  let text = '';
  try {
    text = await res.text();
    body = text ? (JSON.parse(text) as DropboxErrorBody) : null;
  } catch {
    body = null;
  }
  const { tag, subTag, summary } = tagsOf(body);
  const retryAfter = Number(res.headers.get('Retry-After'));
  if (res.status === 429) {
    const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
    return new DropboxError(`Dropbox is rate limiting (${what}) — retrying later`, 429, tag ?? 'too_many_requests', subTag, true, ms);
  }
  if (res.status >= 500) return new DropboxError(`Dropbox is having trouble (HTTP ${res.status} on ${what})`, res.status, tag, subTag, true);
  if (res.status === 401) return new DropboxError(tag === 'expired_access_token' ? 'Dropbox access token expired' : 'Dropbox sign-in is no longer valid — Disconnect, then Connect again', 401, tag ?? 'invalid_access_token', subTag, false);
  if (res.status === 409 && tag === 'path' && subTag === 'not_found') return new DropboxError('Folder not found in Dropbox', 409, tag, subTag, false);
  if (res.status === 409 && tag === 'reset') return new DropboxError('Dropbox cursor reset', 409, tag, subTag, false);
  const detail = summary || text.slice(0, 120) || res.statusText;
  return new DropboxError(`Dropbox ${what} failed (HTTP ${res.status}${detail ? `: ${detail}` : ''})`, res.status, tag, subTag, false);
}

function networkError(what: string, e: unknown): DropboxError {
  const msg = (e as Error)?.message ?? String(e);
  return new DropboxError(`No connection to Dropbox (${what}: ${msg})`, 0, null, null, true);
}

/** Map a DropboxError (or anything else) to the scheduler's SyncError. */
export function toSyncError(e: unknown): SyncError {
  if (e instanceof SyncError) return e;
  if (e instanceof DropboxError) return new SyncError(e.message, e.retryable, e.retryAfterMs);
  return new SyncError((e as Error)?.message ?? String(e), false);
}

// ---------------------------------------------------------------- token endpoint

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  account_id?: string;
  token_type?: string;
  scope?: string;
}

async function tokenRequest(fetchFn: FetchFn, params: Record<string, string>, what: string, now: () => number): Promise<DropboxTokens> {
  let res: Response;
  try {
    res = await fetchFn(DROPBOX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    throw networkError(what, e);
  }
  if (!res.ok) {
    // The token endpoint answers 400 {"error": "invalid_grant", "error_description": "..."}.
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string; error_description?: string };
      detail = body.error_description ?? body.error ?? '';
    } catch {
      /* not JSON */
    }
    if (res.status >= 500 || res.status === 429) throw new DropboxError(`Dropbox sign-in service unavailable (HTTP ${res.status})`, res.status, null, null, true);
    throw new DropboxError(`Dropbox ${what} failed${detail ? `: ${detail}` : ''}`, res.status, 'invalid_grant', null, false);
  }
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) throw new DropboxError(`Dropbox ${what}: no access token in the reply`, res.status, null, null, false);
  const tokens: DropboxTokens = { accessToken: body.access_token, expiresAt: now() + (body.expires_in ?? 14_400) * 1000 };
  if (body.refresh_token) tokens.refreshToken = body.refresh_token;
  if (body.account_id) tokens.accountId = body.account_id;
  return tokens;
}

export function exchangeCode(opts: { appKey: string; code: string; verifier: string; redirectUri: string; fetchFn?: FetchFn; now?: () => number }): Promise<DropboxTokens> {
  return tokenRequest(
    opts.fetchFn ?? fetch,
    { grant_type: 'authorization_code', code: opts.code, code_verifier: opts.verifier, client_id: opts.appKey, redirect_uri: opts.redirectUri },
    'sign-in',
    opts.now ?? (() => Date.now()),
  );
}

export function refreshAccessToken(opts: { appKey: string; refreshToken: string; fetchFn?: FetchFn; now?: () => number }): Promise<DropboxTokens> {
  return tokenRequest(opts.fetchFn ?? fetch, { grant_type: 'refresh_token', refresh_token: opts.refreshToken, client_id: opts.appKey }, 'token refresh', opts.now ?? (() => Date.now()));
}

/**
 * Finish a sign-in from the URL Dropbox redirected to. Returns the tokens (also stored), null
 * when the URL carries no OAuth parameters, and throws a DropboxError when the sign-in failed
 * (user refused, state mismatch, stale attempt). The pending record is cleared either way.
 */
export async function completeDropboxAuth(opts: { url: string; appKey: string; store?: KeyValue; fetchFn?: FetchFn; now?: () => number }): Promise<DropboxTokens | null> {
  const params = parseRedirect(opts.url);
  if (!params) return null;
  const store = opts.store ?? localKV;
  const now = opts.now ?? (() => Date.now());
  const pending = store.read<PkcePending | null>(DROPBOX_PKCE_KEY, null);
  store.remove(DROPBOX_PKCE_KEY);
  if (params.error) throw new DropboxError(params.error === 'access_denied' ? 'Dropbox sign-in was cancelled' : `Dropbox sign-in failed: ${params.errorDescription ?? params.error}`, 0, params.error, null, false);
  if (!pending || now() - pending.startedAt > PKCE_MAX_AGE_MS) throw new DropboxError('Dropbox sign-in could not be completed (the attempt is stale) — tap Connect again', 0, 'stale', null, false);
  if (!params.state || params.state !== pending.state) throw new DropboxError('Dropbox sign-in could not be verified — tap Connect again', 0, 'state_mismatch', null, false);
  const tokens = await exchangeCode({ appKey: opts.appKey, code: params.code as string, verifier: pending.verifier, redirectUri: pending.redirectUri, fetchFn: opts.fetchFn, now });
  store.write(DROPBOX_TOKENS_KEY, tokens);
  return tokens;
}

// ---------------------------------------------------------------- API client

export interface DropboxEntry {
  tag: 'file' | 'folder' | 'deleted';
  name: string;
  pathLower: string;
  pathDisplay: string;
  rev?: string;
  size?: number;
  serverModified?: string;
  contentHash?: string;
}

export interface ListFolderResult {
  entries: DropboxEntry[];
  cursor: string;
  hasMore: boolean;
}

export interface DropboxAccount {
  accountId: string;
  email?: string;
  displayName?: string;
}

interface RawEntry {
  '.tag': string;
  name: string;
  path_lower?: string;
  path_display?: string;
  rev?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
}

function toEntry(e: RawEntry): DropboxEntry | null {
  if (e['.tag'] !== 'file' && e['.tag'] !== 'folder' && e['.tag'] !== 'deleted') return null;
  const out: DropboxEntry = { tag: e['.tag'], name: e.name, pathLower: e.path_lower ?? '', pathDisplay: e.path_display ?? e.name };
  if (e.rev !== undefined) out.rev = e.rev;
  if (e.size !== undefined) out.size = e.size;
  if (e.server_modified !== undefined) out.serverModified = e.server_modified;
  if (e.content_hash !== undefined) out.contentHash = e.content_hash;
  return out;
}

/** JSON for the Dropbox-API-Arg header: HTTP headers are ASCII, so non-ASCII is \u-escaped. */
export function apiArg(arg: unknown): string {
  return JSON.stringify(arg).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export interface DropboxClientOptions {
  appKey: string;
  store?: KeyValue;
  fetchFn?: FetchFn;
  now?: () => number;
}

export class DropboxClient {
  private readonly store: KeyValue;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly appKey: string;
  private refreshing: Promise<DropboxTokens> | null = null;

  constructor(opts: DropboxClientOptions) {
    this.appKey = opts.appKey;
    this.store = opts.store ?? localKV;
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
  }

  tokens(): DropboxTokens | null {
    const t = this.store.read<DropboxTokens | null>(DROPBOX_TOKENS_KEY, null);
    return t && typeof t.accessToken === 'string' ? t : null;
  }

  connected(): boolean {
    return this.tokens() !== null;
  }

  disconnect(): void {
    this.store.remove(DROPBOX_TOKENS_KEY);
    this.store.remove(DROPBOX_PKCE_KEY);
  }

  /** A usable access token: refreshed when within a minute of expiry (single-flight). */
  private async accessToken(force = false): Promise<string> {
    const t = this.tokens();
    if (!t) throw new DropboxError('Not connected to Dropbox', 401, 'not_connected', null, false);
    if (!force && this.now() < t.expiresAt - REFRESH_MARGIN_MS) return t.accessToken;
    if (!t.refreshToken) {
      if (force || this.now() >= t.expiresAt) throw new DropboxError('Dropbox sign-in expired — Disconnect, then Connect again', 401, 'expired_access_token', null, false);
      return t.accessToken;
    }
    if (!this.refreshing) {
      this.refreshing = refreshAccessToken({ appKey: this.appKey, refreshToken: t.refreshToken, fetchFn: this.fetchFn, now: this.now })
        .then((fresh) => {
          const merged: DropboxTokens = { ...t, accessToken: fresh.accessToken, expiresAt: fresh.expiresAt };
          if (fresh.refreshToken) merged.refreshToken = fresh.refreshToken;
          this.store.write(DROPBOX_TOKENS_KEY, merged);
          return merged;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return (await this.refreshing).accessToken;
  }

  /** One RPC/content call with a 401-expired → refresh → retry-once loop. */
  private async call(url: string, init: (token: string) => RequestInit, what: string): Promise<Response> {
    let token = await this.accessToken();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, init(token));
      } catch (e) {
        throw networkError(what, e);
      }
      if (res.ok) return res;
      const err = await errorFrom(res, what);
      if (err.expiredToken && attempt === 0 && this.tokens()?.refreshToken) {
        token = await this.accessToken(true);
        continue;
      }
      throw err;
    }
  }

  private rpc<T>(endpoint: string, body: unknown): Promise<T> {
    return this.call(
      `${DROPBOX_API}/${endpoint}`,
      (token) => ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      endpoint,
    ).then((res) => res.json() as Promise<T>);
  }

  async listFolder(path: string, limit = 2000): Promise<ListFolderResult> {
    const r = await this.rpc<{ entries: RawEntry[]; cursor: string; has_more: boolean }>('files/list_folder', { path, recursive: false, include_deleted: false, limit });
    return { entries: r.entries.map(toEntry).filter((e): e is DropboxEntry => e !== null), cursor: r.cursor, hasMore: Boolean(r.has_more) };
  }

  async listFolderContinue(cursor: string): Promise<ListFolderResult> {
    const r = await this.rpc<{ entries: RawEntry[]; cursor: string; has_more: boolean }>('files/list_folder/continue', { cursor });
    return { entries: r.entries.map(toEntry).filter((e): e is DropboxEntry => e !== null), cursor: r.cursor, hasMore: Boolean(r.has_more) };
  }

  async download(path: string): Promise<Uint8Array> {
    const res = await this.call(
      `${DROPBOX_CONTENT}/files/download`,
      (token) => ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': apiArg({ path }) } }),
      'files/download',
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  async currentAccount(): Promise<DropboxAccount> {
    const r = await this.rpc<{ account_id: string; email?: string; name?: { display_name?: string } }>('users/get_current_account', null);
    const out: DropboxAccount = { accountId: r.account_id };
    if (r.email) out.email = r.email;
    if (r.name?.display_name) out.displayName = r.name.display_name;
    return out;
  }
}
