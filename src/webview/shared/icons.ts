// 16px stroke icons, drawn in currentColor (no emoji or text glyphs as UI icons).
const svg = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  sidebar: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>'),
  sidebarCollapse: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10M10.8 6.2L9 8l1.8 1.8"/>'),
  sidebarExpand: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10M9 6.2L10.8 8 9 9.8"/>'),
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
  more: svg('<circle cx="3.5" cy="8" r=".7"/><circle cx="8" cy="8" r=".7"/><circle cx="12.5" cy="8" r=".7"/>'),
  pencil: svg('<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/>'),
  lock: svg('<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  sortUp: svg('<path d="M5 12V4M2.5 6.5L5 4l2.5 2.5M9 5h4.5M9 8h3.5M9 11h2"/>'),
  sortDown: svg('<path d="M5 4v8M2.5 9.5L5 12l2.5-2.5M9 5h2M9 8h3.5M9 11h4.5"/>'),
  filter: svg('<path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.5v-5.5z"/>'),
  crosshair: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M2.5 9.5h11M6.5 2.5v11M9.5 2.5v11"/>'),
  gear: svg(
    '<circle cx="8" cy="8" r="2"/><path d="M6.65 3.29L6.74 1.52A6.6 6.6 0 0 1 9.26 1.52L9.35 3.29A4.9 4.9 0 0 1 11.4 4.48L12.98 3.67A6.6 6.6 0 0 1 14.24 5.85L12.75 6.81A4.9 4.9 0 0 1 12.75 9.19L14.24 10.15A6.6 6.6 0 0 1 12.98 12.33L11.4 11.52A4.9 4.9 0 0 1 9.35 12.71L9.26 14.48A6.6 6.6 0 0 1 6.74 14.48L6.65 12.71A4.9 4.9 0 0 1 4.6 11.52L3.02 12.33A6.6 6.6 0 0 1 1.76 10.15L3.25 9.19A4.9 4.9 0 0 1 3.25 6.81L1.76 5.85A6.6 6.6 0 0 1 3.02 3.67L4.6 4.48A4.9 4.9 0 0 1 6.65 3.29Z"/>',
  ),
  grip: svg(
    '<circle cx="6" cy="4" r=".6" fill="currentColor"/><circle cx="10" cy="4" r=".6" fill="currentColor"/><circle cx="6" cy="8" r=".6" fill="currentColor"/><circle cx="10" cy="8" r=".6" fill="currentColor"/><circle cx="6" cy="12" r=".6" fill="currentColor"/><circle cx="10" cy="12" r=".6" fill="currentColor"/>',
  ),
  history: svg('<path d="M3 5.5V2.5m0 3h3M3.3 5.5a5.5 5.5 0 1 1-.5 4"/><path d="M8 5v3.2l2.3 1.3"/>'),
  export: svg('<path d="M8 10.5V2.5M5 5.2L8 2.5l3 2.7M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2"/>'),
  rtl: svg('<path d="M7 3h5M9 3v8M11.5 3v8M7 3a2.2 2.2 0 0 0 0 4.4H9M6.5 13l-2.5-2 2.5-2M4 11h8"/>'),
  invert: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/>'),
};

export type IconName = keyof typeof icons;
