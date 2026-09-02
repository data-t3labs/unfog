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

let toastHost: HTMLElement | null = null;

export interface ToastOptions {
  /** ms; 0 = sticky until dismissed or replaced. Default 3500. */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Only one toast per id at a time (later calls replace). */
  id?: string;
  kind?: 'info' | 'error' | 'success';
}

export function toast(text: string, opts: ToastOptions = {}): () => void {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  if (opts.id) toastHost.querySelector(`[data-toast="${opts.id}"]`)?.remove();
  const node = el(
    'div',
    { class: `toast ${opts.kind ?? 'info'}`, 'data-toast': opts.id ?? '' },
    el('span', { class: 'toast-text', text }),
    opts.action
      ? el('button', { class: 'toast-action', type: 'button', onclick: () => { opts.action!.onClick(); dismiss(); } }, opts.action.label)
      : null,
  );
  toastHost.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  let timer = 0;
  const dismiss = () => {
    window.clearTimeout(timer);
    node.classList.remove('show');
    window.setTimeout(() => node.remove(), 250);
  };
  const duration = opts.duration ?? 3500;
  if (duration > 0) timer = window.setTimeout(dismiss, duration);
  return dismiss;
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
