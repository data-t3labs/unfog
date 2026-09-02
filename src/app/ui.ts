/** Tiny DOM helpers, toasts and confirm sheets — no framework. */

type Child = Node | string | null | undefined | false | Child[];

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: Event) => void) | undefined> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') {
        node.className = String(v);
      } else if (k === 'html') {
        node.innerHTML = String(v);
      } else if (k === 'text') {
        node.textContent = String(v);
      } else if (v === true) {
        node.setAttribute(k, '');
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  append(node, children);
  return node;
}

export function append(node: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

/** Wrap an SVG string in a span so it can be used as a child. */
export function svg(markup: string, cls = 'ic'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = cls;
  span.innerHTML = markup;
  return span;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------------------------------------------------------------- toasts
//
// One toast at a time, queued — never stacked. The host floats just above the bottom chrome
// (`--bottom-h`: tab bar + stat chip / sheet, kept up to date by the shell) so it never covers
// a button, and moves to the top while a modal sheet is up so it stays clear of the modal's
// buttons. A sticky toast (duration 0, e.g. "Update available") steps aside for a transient one
// and comes back after it.

let toastHost: HTMLElement | null = null;

export interface ToastOptions {
  /** ms; 0 = sticky until dismissed or replaced. Default 3500. */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Only one toast per id at a time (later calls replace). */
  id?: string;
  kind?: 'info' | 'error' | 'success';
}

const TOAST_DEFAULT_MS = 3500;
const TOAST_FADE_MS = 220;
const TOAST_MAX_QUEUE = 5;

interface Pending {
  text: string;
  opts: ToastOptions;
  node: HTMLElement | null;
  timer: number;
  done: boolean;
}

const queue: Pending[] = [];
let current: Pending | null = null;
let fading = false;

function host(): HTMLElement {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

const isSticky = (p: Pending) => (p.opts.duration ?? TOAST_DEFAULT_MS) === 0;

/** Show (or queue) a toast; returns a function that removes it whether showing or pending. */
export function toast(text: string, opts: ToastOptions = {}): () => void {
  if (opts.id) {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].opts.id === opts.id) queue.splice(i, 1);
    if (current?.opts.id === opts.id) finish(current);
  } else if (current && !current.done && current.text === text) {
    // The same message is on screen already: don't repeat it.
    const cur = current;
    return () => finish(cur);
  } else {
    const dup = queue.find((q) => q.text === text);
    if (dup) return () => finish(dup);
  }
  const p: Pending = { text, opts, node: null, timer: 0, done: false };
  queue.push(p);
  while (queue.length > TOAST_MAX_QUEUE) {
    const i = queue.findIndex((q) => !isSticky(q));
    queue.splice(i < 0 ? 0 : i, 1);
  }
  pump();
  return () => finish(p);
}

function pump(): void {
  if (fading) return;
  if (current) {
    if (isSticky(current) && queue.length) {
      // Step aside for the transient toast; come back once it is gone.
      const s = current;
      hide(s);
      s.done = false;
      s.node = null;
      queue.push(s);
    }
    return;
  }
  // Transient toasts go first; a sticky one waits until nothing transient is pending.
  let i = queue.findIndex((q) => !isSticky(q));
  if (i < 0) i = 0;
  const next = queue.splice(i, 1)[0];
  if (next) show(next);
}

function show(p: Pending): void {
  const h = host();
  h.classList.toggle('top', Boolean(document.querySelector('.backdrop.show')));
  const node = el(
    'div',
    { class: `toast ${p.opts.kind ?? 'info'}`, 'data-toast': p.opts.id ?? '' },
    el('span', { class: 'toast-text', text: p.text }),
    p.opts.action
      ? el('button', { class: 'toast-action', type: 'button', onclick: () => { p.opts.action!.onClick(); finish(p); } }, p.opts.action.label)
      : null,
  );
  p.node = node;
  current = p;
  h.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  const duration = p.opts.duration ?? TOAST_DEFAULT_MS;
  if (duration > 0) p.timer = window.setTimeout(() => finish(p), duration);
}

/** Remove a toast: drop it from the queue, or fade it out and let the next one follow. */
function finish(p: Pending): void {
  if (p.done) return;
  const qi = queue.indexOf(p);
  if (qi >= 0) {
    queue.splice(qi, 1);
    p.done = true;
    return;
  }
  if (current === p) hide(p);
}

function hide(p: Pending): void {
  p.done = true;
  window.clearTimeout(p.timer);
  const node = p.node;
  current = null;
  fading = true;
  node?.classList.remove('show');
  window.setTimeout(() => {
    node?.remove();
    fading = false;
    pump();
  }, TOAST_FADE_MS);
}

// ---------------------------------------------------------------- confirm sheet

export interface ConfirmOptions {
  title: string;
  body?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export function confirmSheet(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (v: boolean) => {
      backdrop.classList.remove('show');
      window.setTimeout(() => backdrop.remove(), 220);
      resolve(v);
    };
    const backdrop = el(
      'div',
      { class: 'backdrop', onclick: (e) => { if (e.target === backdrop) finish(false); } },
      el(
        'div',
        { class: 'sheet modal', role: 'dialog', 'aria-modal': 'true' },
        el('div', { class: 'grab' }),
        el('h2', { text: opts.title }),
        opts.body ? el('p', { class: 'muted', text: opts.body }) : null,
        el(
          'div',
          { class: 'btn-row' },
          el('button', { class: 'btn ghost', type: 'button', onclick: () => finish(false) }, opts.cancelLabel ?? 'Cancel'),
          el('button', { class: `btn ${opts.danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => finish(true) }, opts.okLabel ?? 'OK'),
        ),
      ),
    );
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('show'));
  });
}

/** A modal sheet with arbitrary content; returns a close function. */
export function openSheet(content: HTMLElement, opts: { onClose?: () => void; dismissible?: boolean } = {}): () => void {
  const close = () => {
    if (!backdrop.isConnected) return;
    backdrop.classList.remove('show');
    window.setTimeout(() => backdrop.remove(), 220);
    opts.onClose?.();
  };
  const backdrop = el(
    'div',
    { class: 'backdrop', onclick: (e) => { if (e.target === backdrop && opts.dismissible !== false) close(); } },
    content,
  );
  content.classList.add('sheet', 'modal');
  if (!content.querySelector('.grab')) content.prepend(el('div', { class: 'grab' }));
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));
  return close;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t = 0;
  return (...a: A) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}
