// Message contract between the extension host and the webviews. Everything here must be
// structured-cloneable (and JSON-serialisable apart from Uint8Array, which the dev
// harness encodes as base64).
import type { StringKey } from './strings';

export type ViewerKind = 'markdown' | 'sheet' | 'docx' | 'pdf' | 'pptx' | 'text' | 'image';

// ---------------------------------------------------------------- spreadsheet model

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  bg?: string;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  fontSize?: number;
  wrap?: boolean;
  /** CSS border shorthand per side, e.g. "1px solid #000". */
  bt?: string;
  br?: string;
  bb?: string;
  bl?: string;
}

export interface CellObject {
  /** Display text. */
  v: string;
  /** Text shown when editing, if it differs from `v` (formulas, formatted numbers). */
  raw?: string;
  /** Index into SheetModel.styles. */
  s?: number;
  /** Cell cannot be edited (e.g. master of a shared formula). */
  ro?: boolean;
  /** Numeric content: right-align by default. */
  n?: boolean;
}

/** A plain string is shorthand for `{ v: string }`; null/undefined is an empty cell. */
export type Cell = string | CellObject | null;

export interface MergeRange {
  r: number;
  c: number;
  rs: number;
  cs: number;
}

export interface SheetModel {
  name: string;
  rowCount: number;
  colCount: number;
  /** Row-major, rows may be shorter than colCount and may be missing at the end. */
  rows: Cell[][];
  /** Column widths in px; missing entries use the default. */
  colWidths?: (number | null)[];
  /** Row heights in px keyed by row index. */
  rowHeights?: Record<number, number>;
  merges?: MergeRange[];
  frozenRows?: number;
  frozenCols?: number;
  styles?: CellStyle[];
}

export interface WorkbookInfo {
  sheets: { name: string }[];
  /** Cell values can be edited. */
  editable: boolean;
  /** Rows/columns can be inserted and deleted (CSV and editable xlsx/xlsm). */
  canStructure: boolean;
  /** Sheets can be added, renamed and deleted (editable xlsx/xlsm). */
  canManageSheets?: boolean;
  /** Backed by a plain-text file (CSV/TSV), enabling the Table/Text switch. */
  hasSource?: boolean;
  /** Informational banner, as a string key so the webview can show it in the current UI language. */
  noticeKey?: StringKey;
}

export interface CellChange {
  r: number;
  c: number;
  text: string;
}

export type StructureOp = 'insertRow' | 'deleteRows' | 'insertCol' | 'deleteCols';

// ---------------------------------------------------------------- markdown

export interface TocEntry {
  level: number;
  text: string;
  id: string;
  line: number;
}

// ---------------------------------------------------------------- appearance

export type ThemeId = 'editor' | 'github' | 'paper' | 'academic';
export type SchemeSetting = 'auto' | 'light' | 'dark';
export type LanguageSetting = 'auto' | 'zh-cn' | 'en';
export type MarkdownWidth = 'fixed' | 'fluid';
export type SplitPosition = 'sourceLeft' | 'previewLeft';

/** User preferences shared by every DocsView editor (stored in VS Code settings). */
export interface Appearance {
  theme: ThemeId;
  scheme: SchemeSetting;
  /** In a dark scheme, show paged documents (PDF/Word) with inverted colours. */
  invertPages: boolean;
  /** Highlight the row and column of the selected cell (sheets) or hovered cell (Markdown tables). */
  highlight: boolean;
  /** Sheets: cells cannot be edited until unlocked. */
  lockEdits: boolean;
  language: LanguageSetting;
  /** Markdown preview content width: centered reading column ('fixed') or adaptive full width ('fluid'). */
  mdWidth: MarkdownWidth;
  /** Side-by-side split arrangement: source on the left or preview on the left. */
  splitPosition: SplitPosition;
  /** Show informational banners at the top of Excel, PPTX and legacy DOC previews. */
  showNotices: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'editor',
  scheme: 'auto',
  invertPages: false,
  highlight: true,
  lockEdits: false,
  language: 'auto',
  mdWidth: 'fixed',
  splitPosition: 'sourceLeft',
  showNotices: true,
};

// ---------------------------------------------------------------- toolbar layout

export type ToolbarItemId =
  | 'nav'
  | 'view'
  | 'pager'
  | 'zoom'
  | 'width'
  | 'bbox'
  | 'cellBar'
  | 'find'
  | 'edit'
  | 'highlight'
  | 'structure'
  | 'actions'
  | 'history'
  | 'rtl'
  | 'theme'
  | 'scheme'
  | 'invertPages'
  | 'language';

export const ALL_TOOLBAR_ITEMS: readonly ToolbarItemId[] = [
  'nav',
  'view',
  'pager',
  'zoom',
  'width',
  'bbox',
  'cellBar',
  'find',
  'edit',
  'highlight',
  'structure',
  'actions',
  'history',
  'rtl',
  'theme',
  'scheme',
  'invertPages',
  'language',
];

export interface ToolbarConfig {
  left: ToolbarItemId[];
  right: ToolbarItemId[];
}

export const DEFAULT_TOOLBAR: ToolbarConfig = {
  left: ['nav', 'view', 'pager', 'zoom', 'bbox', 'cellBar', 'find', 'edit', 'highlight', 'structure'],
  right: [],
};

const VALID_TOOLBAR_SET = new Set<string>(ALL_TOOLBAR_ITEMS);

/** Sanitises user/persisted toolbar layouts: drops unknown or duplicate IDs. */
export function normalizeToolbarConfig(raw: unknown): ToolbarConfig {
  if (!raw || typeof raw !== 'object') {
    return { left: [...DEFAULT_TOOLBAR.left], right: [...DEFAULT_TOOLBAR.right] };
  }
  const obj = raw as { left?: unknown; right?: unknown };
  const seen = new Set<ToolbarItemId>();
  const clean = (arr: unknown, fallback: readonly ToolbarItemId[]): ToolbarItemId[] => {
    const source = Array.isArray(arr) ? arr : fallback;
    const out: ToolbarItemId[] = [];
    for (const item of source) {
      if (typeof item === 'string' && VALID_TOOLBAR_SET.has(item) && !seen.has(item as ToolbarItemId)) {
        seen.add(item as ToolbarItemId);
        out.push(item as ToolbarItemId);
      }
    }
    return out;
  };
  return {
    left: clean(obj.left, DEFAULT_TOOLBAR.left),
    right: clean(obj.right, DEFAULT_TOOLBAR.right),
  };
}

// ---------------------------------------------------------------- messages

export type HostMessage =
  | { type: 'load'; name: string; bytes: Uint8Array }
  | { type: 'text'; name: string; body: string }
  /** `source` is the full Markdown text, for editing a block in place. */
  | { type: 'render'; html: string; toc: TocEntry[]; source: string }
  | { type: 'scrollTo'; line: number }
  | { type: 'workbook'; info: WorkbookInfo; active: number }
  | { type: 'sheet'; index: number; model: SheetModel }
  | { type: 'cells'; index: number; cells: { r: number; c: number; cell: Cell }[] }
  | { type: 'rows'; index: number; rowCount: number; colCount: number; rows: { r: number; cells: Cell[] }[] }
  | { type: 'appearance'; appearance: Appearance }
  | { type: 'toolbar'; toolbar: ToolbarConfig }
  /** Whether the document is also open in a text editor (drives the preview/split switch). */
  | { type: 'viewState'; split: boolean }
  /** File-level state for the settings drawer. `isDefault` is undefined when it does not apply. */
  | { type: 'fileState'; isDefault?: boolean; ext: string; history: boolean }
  | { type: 'error'; message: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'openLink'; href: string }
  | { type: 'revealLine'; line: number }
  | { type: 'getSheet'; index: number }
  | { type: 'edit'; index: number; changes: CellChange[] }
  | { type: 'structure'; index: number; op: StructureOp; at: number; count: number }
  | { type: 'sheetOp'; op: 'add'; name?: string }
  | { type: 'sheetOp'; op: 'rename'; index: number; name: string }
  | { type: 'sheetOp'; op: 'delete'; index: number }
  | { type: 'setAppearance'; patch: Partial<Appearance> }
  | { type: 'setToolbar'; toolbar: ToolbarConfig }
  | { type: 'openSettings' }
  /** Open the document in the text editor: replacing this editor, or beside it. */
  | { type: 'showSource'; beside: boolean }
  /** Close text editors of this document that are open beside the preview. */
  | { type: 'closeSource' }
  | { type: 'setDefault'; on: boolean }
  | { type: 'history' }
  /** Markdown: save the rendered article as HTML, or open it for printing to PDF. */
  | { type: 'export'; format: 'html' | 'pdf'; html: string; theme: ThemeId; dark: boolean; rtl: boolean }
  /** Markdown: replace source lines [start, end) with `text`. */
  | { type: 'editBlock'; start: number; end: number; text: string; expected: string }
  /** Sheets: save a copy of sheet `index` in another format. */
  | { type: 'convert'; index: number; format: 'csv' | 'tsv' | 'xlsx' }
  /** Sent once per load: the document is on screen, or could not be rendered. */
  | { type: 'status'; ok: boolean; detail?: string };

/** Static configuration injected into the webview HTML. */
export interface WebviewConfig {
  kind: ViewerKind;
  /** Base URL of dist/webview (no trailing slash). */
  assets: string;
  /** Resolved UI language. */
  lang: 'en' | 'zh';
  appearance: Appearance;
  toolbar?: ToolbarConfig;
}
