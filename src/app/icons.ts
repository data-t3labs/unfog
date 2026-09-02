/** Inline SVG icons (stroke = currentColor). Ported from the approved mockup where one existed. */

const s = (body: string, size = 24, extra = '') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const icons = {
  search: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  locate: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10l18-7Z"/></svg>`,
  map: s('<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/>'),
  stats: s('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'),
  data: s('<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
  help: s('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5V14M12 17h.01"/>'),
  close: s('<path d="M6 6l12 12M18 6 6 18"/>', 20),
  back: s('<path d="m15 5-7 7 7 7"/>', 22),
  chevron: s('<path d="m9 5 7 7-7 7"/>', 18),
  pin: s('<path d="M12 21s-7-7.2-7-12a7 7 0 0 1 14 0c0 4.8-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/>', 20),
  target: s('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/>', 20),
  share: s('<path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>', 22),
  walk: s('<circle cx="13" cy="4" r="1.6"/><path d="m9 21 2.5-6.5L9.5 12l1-5 3.5 1 2.5 3 2 1M11.5 14.5 15 17l1 4M9.5 12 7 14l-1 4"/>', 18),
  bike: s('<circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="m12 17-3-7h5l3 5M9 10l1.5-3h3M15 5h2"/>', 18),
  drive: s('<path d="M5 16v2M19 16v2M3 12l2-5h14l2 5v4H3v-4Z"/><path d="M7 12h10M6.5 15h1M16.5 15h1"/>', 18),
  check: s('<path d="m5 12 5 5 9-10"/>', 20),
  trash: s('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 18),
  download: s('<path d="M12 4v11m0 0 4-4m-4 4-4-4M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>', 18),
  upload: s('<path d="M12 15V4m0 0 4 4m-4-4-4 4M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>', 18),
  stop: `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1" y="1" width="12" height="12" rx="2.5" fill="currentColor"/></svg>`,
  layers: s('<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>', 20),
  settings: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>', 20),
  /** iOS share glyph (box with arrow) for the install card. */
  iosShare: `<svg width="22" height="26" viewBox="0 0 22 26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 16V2M6.5 6.5 11 2l4.5 4.5"/><path d="M7 10H4.5A1.5 1.5 0 0 0 3 11.5v11A1.5 1.5 0 0 0 4.5 24h13a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 17.5 10H15"/></svg>`,
  /** iOS "add" square glyph for the install card. */
  iosAdd: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`,
  /** Destination pin marker (orange, white stroke) — from the mockup. */
  pinMarker: `<svg width="30" height="40" viewBox="0 0 30 40" aria-hidden="true"><path d="M15 39C15 39 2 22 2 14a13 13 0 0 1 26 0c0 8-13 25-13 25Z" fill="#ff8a3d" stroke="#fff" stroke-width="2.5"/><circle cx="15" cy="14" r="5" fill="#fff"/></svg>`,
};

export type IconName = keyof typeof icons;
