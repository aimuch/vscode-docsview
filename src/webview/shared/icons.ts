// 16px stroke icons, drawn in currentColor (no emoji or text glyphs as UI icons).
const svg = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  sidebar: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>'),
  minus: svg('<path d="M3.5 8h9"/>'),
  plus: svg('<path d="M3.5 8h9M8 3.5v9"/>'),
  left: svg('<path d="M10 4l-4 4 4 4"/>'),
  right: svg('<path d="M6 4l4 4-4 4"/>'),
  up: svg('<path d="M4 10l4-4 4 4"/>'),
  down: svg('<path d="M4 6l4 4 4-4"/>'),
  fitWidth: svg('<path d="M2.5 8h11M5 5.5L2.5 8 5 10.5M11 5.5L13.5 8 11 10.5"/>'),
  search: svg('<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>'),
  sun: svg(
    '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2"/>',
  ),
  moon: svg('<path d="M13 9.2A5.2 5.2 0 0 1 6.8 3a5.3 5.3 0 1 0 6.2 6.2z"/>'),
  monitor: svg('<rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.5h4M8 11v2.5"/>'),
  check: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  chevronDown: svg('<path d="M4 6l4 4 4-4"/>'),
  chevronRight: svg('<path d="M6 4l4 4-4 4"/>'),
};

export type IconName = keyof typeof icons;
