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
  // WPS-style 5-cell hollow table cross for row & column spotlight highlight.
  crosshair: svg(
    '<path d="M5.75 1.5h4.5v4.25h4.25v4.5h-4.25v4.25h-4.5v-4.25H1.5v-4.5h4.25zM5.75 5.75h4.5v4.5h-4.5z"/>',
  ),
  crop: svg('<path d="M4.5 1.8v9.7h9.7M1.8 4.5h9.7v9.7"/>'),
  gear: svg(
    '<circle cx="8" cy="8" r="2"/><path d="M6.65 3.29L6.74 1.52A6.6 6.6 0 0 1 9.26 1.52L9.35 3.29A4.9 4.9 0 0 1 11.4 4.48L12.98 3.67A6.6 6.6 0 0 1 14.24 5.85L12.75 6.81A4.9 4.9 0 0 1 12.75 9.19L14.24 10.15A6.6 6.6 0 0 1 12.98 12.33L11.4 11.52A4.9 4.9 0 0 1 9.35 12.71L9.26 14.48A6.6 6.6 0 0 1 6.74 14.48L6.65 12.71A4.9 4.9 0 0 1 4.6 11.52L3.02 12.33A6.6 6.6 0 0 1 1.76 10.15L3.25 9.19A4.9 4.9 0 0 1 3.25 6.81L1.76 5.85A6.6 6.6 0 0 1 3.02 3.67L4.6 4.48A4.9 4.9 0 0 1 6.65 3.29Z"/>',
  ),
  grip: svg(
    '<circle cx="6" cy="4" r=".75" fill="currentColor" stroke="none"/><circle cx="10" cy="4" r=".75" fill="currentColor" stroke="none"/><circle cx="6" cy="8" r=".75" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r=".75" fill="currentColor" stroke="none"/><circle cx="6" cy="12" r=".75" fill="currentColor" stroke="none"/><circle cx="10" cy="12" r=".75" fill="currentColor" stroke="none"/>',
  ),
  history: svg('<path d="M3 5.5V2.5m0 3h3M3.3 5.5a5.5 5.5 0 1 1-.5 4"/><path d="M8 5v3.2l2.3 1.3"/>'),
  export: svg('<path d="M8 10.5V2.5M5 5.2L8 2.5l3 2.7M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2"/>'),
  rtl: svg('<path d="M7 3h5M9 3v8M11.5 3v8M7 3a2.2 2.2 0 0 0 0 4.4H9M6.5 13l-2.5-2 2.5-2M4 11h8"/>'),
  invert: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/>'),
  comment: svg(
    '<path d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H6.5L3 14.2V11.5h-.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>',
  ),
  commentPlus: svg(
    '<path d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H6.5L3 14.2V11.5h-.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 5.2v4.2M5.9 7.3h4.2"/>',
  ),
  external: svg(
    '<path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5"/><path d="M12.5 9.5v3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3"/>',
  ),
  trash: svg('<path d="M3 4.5h10M6 4.5V3a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2"/>'),
  rotateCCW: svg('<path d="M3.2 6V2.5M3.2 6h3.5"/><path d="M3.5 5.8a5.1 5.1 0 1 1-.5 4.1"/>'),
  rotateCW: svg('<path d="M12.8 6V2.5M12.8 6H9.3"/><path d="M12.5 5.8a5.1 5.1 0 1 0 .5 4.1"/>'),
  flipH: svg('<path d="M8 2v12" stroke-dasharray="1.5 1.8"/><path d="M5.6 4.5L2.2 8l3.4 3.5zM10.4 4.5L13.8 8l-3.4 3.5z"/>'),
  flipV: svg('<path d="M2 8h12" stroke-dasharray="1.5 1.8"/><path d="M4.5 5.6L8 2.2l3.5 3.4zM4.5 10.4L8 13.8l3.5-3.4z"/>'),
  resize: svg('<rect x="2" y="5.5" width="6.5" height="6.5" rx="1"/><path d="M7.5 3h5.5v5.5M13 3L8.5 7.5"/>'),
  freeze: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.4"/><path d="M2 6.3h12M6 2.5v3.8M10 2.5v3.8"/>'),
  freezeCol: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.4"/><path d="M5.8 2.5v11M2 6.5h3.8M2 10h3.8"/>'),
  copyMd: svg('<rect x="1.8" y="3" width="12.4" height="10" rx="1.5"/><path d="M4.2 10V6l2 2.3L8.2 6v4M11.3 6v4M9.9 8.6l1.4 1.4 1.4-1.4"/>'),
  chevronsRight: svg('<path d="M4.5 4.5L8 8l-3.5 3.5M8.8 4.5L12.3 8l-3.5 3.5"/>'),
  play: svg('<polygon points="4.8,2.6 13.6,8 4.8,13.4" fill="currentColor" stroke="none"/>'),
  compare: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M8 2.5v11M5.4 6.5L3.8 8l1.6 1.5M10.6 6.5L12.2 8l-1.6 1.5"/>'),
  markup: svg('<path d="M2.5 13.5l3.8-1L13.1 5.7a1.3 1.3 0 0 0-1.8-1.8L4.5 10.7z"/><path d="M9.8 4.3l1.9 1.9"/>'),
  copy: svg('<rect x="5.2" y="5.2" width="8.3" height="8.3" rx="1.3"/><path d="M3.8 10.8H3a1.2 1.2 0 0 1-1.2-1.2V3A1.2 1.2 0 0 1 3 1.8h6.6A1.2 1.2 0 0 1 10.8 3v.8"/>'),
  replace: svg('<path d="M2.8 5h7.2M7.8 2.8L10.2 5 7.8 7.2M13.2 11H6M8.2 8.8L5.8 11l2.4 2.2"/>'),
  bars: svg('<rect x="2.2" y="3.2" width="9.5" height="2.2" rx=".8" fill="currentColor" stroke="none"/><rect x="2.2" y="6.9" width="6.2" height="2.2" rx=".8" fill="currentColor" stroke="none"/><rect x="2.2" y="10.6" width="11.6" height="2.2" rx=".8" fill="currentColor" stroke="none"/>'),
  notes: svg('<rect x="2.5" y="2.2" width="11" height="11.6" rx="1.4"/><path d="M5 5.6h6M5 8.2h6M5 10.8h3.8"/>'),
  expand: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  highlighter: svg('<path d="M9.8 2.5l3.7 3.7-5.8 5.8H4v-3.7zM2.5 13.8h11"/>'),
  folder: svg('<path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h3l1.4 1.6h5.2A1.2 1.2 0 0 1 14 5.8v6A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8z"/>'),
  file: svg('<path d="M4 2.2h5.2L12.5 5.5v8.3H4a1 1 0 0 1-1-1V3.2a1 1 0 0 1 1-1z"/><path d="M9 2.2v3.5h3.5"/>'),
  laser: svg('<circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="5.5" stroke-dasharray="2 2"/>'),
  undo: svg('<path d="M5.5 4.2L2.5 7l3 2.8"/><path d="M3 7h6.5a3.8 3.8 0 0 1 0 7.6H7"/>'),
  info: svg('<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v4M8 4.8h.01"/>'),
  code: svg('<path d="M5.5 5L2.3 8l3.2 3M10.5 5l3.2 3-3.2 3"/>'),
};

export type IconName = keyof typeof icons;
