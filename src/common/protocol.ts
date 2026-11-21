// Message contract between the extension host and the webviews. Everything here must be
// structured-cloneable (and JSON-serialisable apart from Uint8Array, which the dev
// harness encodes as base64).
import type { DocumentDiffReport } from './docDiff';
import type { StringKey } from './strings';

export type ViewerKind = 'markdown' | 'sheet' | 'docx' | 'pdf' | 'pptx' | 'text' | 'image' | 'epub' | 'archive' | 'media';
export type ImageExportFormat = 'png' | 'jpg' | 'webp' | 'bmp' | 'ico';
export type AnnotationExportFormat = 'yolo' | 'coco' | 'labelme';

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
  /** Rows/columns can be inserted and deleted (CSV, JSONL and editable xlsx/xlsm). */
  canStructure: boolean;
  /** Sheets can be added, renamed and deleted (editable xlsx/xlsm). */
  canManageSheets?: boolean;
  /** Backed by a plain-text file (CSV/TSV/JSONL), enabling the Table/Text switch. */
  hasSource?: boolean;
  /** Whether cells support `=formula` evaluation (`false` for JSONL). */
  supportsFormulas?: boolean;
  /** True when backed by `.jsonl` / `.ndjson` records (enables Record JSON Inspector & schema row semantics). */
  isJsonl?: boolean;
  /** Whether the host supports `compareDocument` diffing (`true` by default; `false` for read-only DB views). */
  canCompare?: boolean;
  /** Informational banner, as a string key so the webview can show it in the current UI language. */
  noticeKey?: StringKey;
  /** Optional dynamic informational banner text (e.g. SQLite WAL or row truncation notice). */
  noticeText?: string;
}

export interface CellChange {
  r: number;
  c: number;
  text: string;
}

export interface CellFormatPatch {
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Hex colour like `#fef08a`, or `""` to clear. */
  bg?: string;
  /** Hex colour like `#dc2626`, or `""` to clear. */
  color?: string;
  /** Excel number format string, e.g. `#,##0.00`, `0.0%`, `¥#,##0.00`, `General`. */
  numFmt?: string;
}

export type StructureOp = 'insertRow' | 'deleteRows' | 'insertCol' | 'deleteCols';

// ---------------------------------------------------------------- office & pdf annotations / editing

export interface DocComment {
  id: string;
  author: string;
  date?: string;
  text: string;
  /** 1-based page (PDF) or 1-based slide number (PPTX). */
  page?: number;
  /** 0-based body paragraph index (DOCX). */
  pIndex?: number;
  /** Excerpt or target label shown in the comments list. */
  quote?: string;
  /** Normalised [0..1] box/pin coordinates on the page or slide. */
  rect?: { x: number; y: number; w: number; h: number };
  /** Normalised [0..1] per-line highlight rectangles for multi-line PDF text highlights. */
  quads?: { x: number; y: number; w: number; h: number }[];
  color?: string;
  subtype?: 'pin' | 'box' | 'highlight';
}

export type DocMutation =
  | {
      kind: 'addComment';
      text: string;
      author?: string;
      page?: number;
      pIndex?: number;
      quote?: string;
      rect?: { x: number; y: number; w: number; h: number };
      quads?: { x: number; y: number; w: number; h: number }[];
      color?: string;
      subtype?: 'pin' | 'box' | 'highlight';
    }
  | { kind: 'updateComment'; id: string; text: string }
  | { kind: 'deleteComment'; id: string }
  | { kind: 'editDocxParagraph'; pIndex: number; text: string; expected: string }
  | { kind: 'editPptxText'; slideIndex: number; shapeIndex: number; text: string; expected: string }
  | { kind: 'editPptxNote'; slideIndex: number; text: string }
  | { kind: 'rotatePdfPages'; pages?: number[]; delta: 90 | -90 }
  | { kind: 'deletePdfPage'; page: number }
  | { kind: 'movePdfPage'; fromPage: number; toPage: number }
  | { kind: 'appendPdfBytes'; otherBytes: Uint8Array; label?: string }
  | {
      kind: 'addPdfImageStamp';
      page: number;
      rect: { x: number; y: number; w: number; h: number };
      pngBytes: Uint8Array;
      label?: string;
    }
  | {
      kind: 'addPdfWatermark';
      watermarkPngBytes?: Uint8Array;
      pageNumbers?: boolean;
      label?: string;
    };

// ---------------------------------------------------------------- epub & archive models

export interface EpubChapter {
  id: string;
  title: string;
  html: string;
}

export interface EpubTocItem {
  level: number;
  text: string;
  chapterIndex: number;
  anchor?: string;
}

export interface EpubBookData {
  title: string;
  author: string;
  chapters: EpubChapter[];
  toc: EpubTocItem[];
}

export interface ArchiveEntryInfo {
  path: string;
  isDir: boolean;
  size: number;
  compressedSize: number;
  mtime?: string;
}

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
export type LoupePosition = 'follow' | 'fixed';
export type SidebarPosition = 'left' | 'right';

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
  /** Image pixel magnifier loupe placement: follow mouse pointer or stay docked in the corner. */
  loupePosition: LoupePosition;
  /** Navigation / outline sidebar placement: left or right side of the preview. */
  sidebarPosition: SidebarPosition;
  /** Markdown & EPUB body font size in pixels (13–22). */
  mdFontSize?: number;
  /** Markdown & EPUB body line height (1.4–2.0). */
  mdLineHeight?: number;
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
  loupePosition: 'follow',
  sidebarPosition: 'left',
  mdFontSize: 15,
  mdLineHeight: 1.65,
};

// ---------------------------------------------------------------- AI assistant models

export type AiProviderId =
  | 'VS Code'
  | 'DeepSeek'
  | 'Kimi'
  | 'Doubao'
  | 'Qwen'
  | 'OpenAI'
  | 'Ollama'
  | 'Magpie'
  | 'CC Switch'
  | 'OpenAI Compatible';

export interface AiProviderPresetInfo {
  id: AiProviderId;
  name: string;
  defaultBaseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
}

export interface AiSettingsSnapshot {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  presets: AiProviderPresetInfo[];
}

export type AiActionKind =
  | 'generate'
  | 'polish'
  | 'concise'
  | 'expand'
  | 'translate'
  | 'explain'
  | 'summarize'
  | 'fix'
  | 'formula'
  | 'tableFill'
  | 'visionOcr'
  | 'visionTable'
  | 'visionChart'
  | 'visionBbox';

export interface AiChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiSheetSchemaContext {
  sheetName: string;
  allSheets: string[];
  headers: string[];
  /** Optional header rows of sibling sheets in the same workbook for accurate cross-sheet formulas. */
  otherSheetsHeaders?: Record<string, string[]>;
  sampleRows: string[][];
  activeCell: string;
  selectionRange: string;
  isJsonl?: boolean;
}

export interface AiPromptContext {
  viewerKind: ViewerKind;
  fileName?: string;
  action: AiActionKind;
  instruction?: string;
  selection?: string;
  surrounding?: string;
  sheetSchema?: AiSheetSchemaContext;
  /** Optional multimodal PNG/JPEG data URL (e.g. from Image Inspector or Chart snapshot). */
  imageDataUrl?: string;
  /** Optional prior conversation turns for multi-turn follow-up prompts. */
  history?: AiChatTurn[];
}

// ---------------------------------------------------------------- toolbar layout

export type CoreToolbarItemId =
  | 'nav'
  | 'view'
  | 'pager'
  | 'zoom'
  | 'width'
  | 'transform'
  | 'bbox'
  | 'cellBar'
  | 'find'
  | 'edit'
  | 'comments'
  | 'openApp'
  | 'highlight'
  | 'structure'
  | 'ai'
  | 'actions'
  | 'history'
  | 'rtl'
  | 'theme'
  | 'scheme'
  | 'invertPages'
  | 'language';

/** Core toolbar slots plus per-document action slots (`doc:<actionId>`). */
export type ToolbarItemId = CoreToolbarItemId | `doc:${string}`;

export const ALL_TOOLBAR_ITEMS: readonly CoreToolbarItemId[] = [
  'nav',
  'view',
  'pager',
  'zoom',
  'width',
  'transform',
  'bbox',
  'cellBar',
  'find',
  'edit',
  'comments',
  'openApp',
  'highlight',
  'structure',
  'ai',
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
  /** Optional per-viewer custom order of action buttons inside "This Document" in Settings. */
  docActionOrder?: Record<string, string[]>;
}

export const DEFAULT_TOOLBAR: ToolbarConfig = {
  left: [
    'nav',
    'view',
    'doc:slideMode',
    'doc:focusMode',
    'doc:present',
    'pager',
    'zoom',
    'transform',
    'bbox',
    'cellBar',
    'find',
    'edit',
    'comments',
    'highlight',
    'structure',
    'doc:chart',
    'doc:pivot',
    'ai',
    'doc:bookmark',
    'doc:captureFrame',
    'actions',
    'theme',
    'openApp',
  ],
  right: [],
};

const VALID_TOOLBAR_SET = new Set<string>(ALL_TOOLBAR_ITEMS);
const DOC_SLOT_RE = /^doc:[a-zA-Z0-9_-]{1,48}$/;

export function isValidToolbarItemId(id: string): id is ToolbarItemId {
  return VALID_TOOLBAR_SET.has(id) || DOC_SLOT_RE.test(id);
}

/** Sanitises user/persisted toolbar layouts: drops unknown or duplicate IDs. */
export function normalizeToolbarConfig(raw: unknown): ToolbarConfig {
  if (!raw || typeof raw !== 'object') {
    return { left: [...DEFAULT_TOOLBAR.left], right: [...DEFAULT_TOOLBAR.right] };
  }
  const obj = raw as { left?: unknown; right?: unknown; docActionOrder?: unknown };
  const seen = new Set<ToolbarItemId>();
  const clean = (arr: unknown, fallback: readonly ToolbarItemId[]): ToolbarItemId[] => {
    const source = Array.isArray(arr) ? arr : fallback;
    const out: ToolbarItemId[] = [];
    for (const item of source) {
      if (typeof item === 'string' && isValidToolbarItemId(item) && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
    return out;
  };
  let docActionOrder: Record<string, string[]> | undefined;
  if (obj.docActionOrder && typeof obj.docActionOrder === 'object' && !Array.isArray(obj.docActionOrder)) {
    const cleanedMap: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(obj.docActionOrder as Record<string, unknown>)) {
      if (/^[a-zA-Z0-9_-]{1,24}$/.test(k) && Array.isArray(v)) {
        const list = [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[a-zA-Z0-9_:-]{1,48}$/.test(x)))];
        if (list.length) {
          cleanedMap[k] = list;
        }
      }
    }
    if (Object.keys(cleanedMap).length) {
      docActionOrder = cleanedMap;
    }
  }
  const res: ToolbarConfig = {
    left: clean(obj.left, DEFAULT_TOOLBAR.left),
    right: clean(obj.right, DEFAULT_TOOLBAR.right),
  };
  if (docActionOrder) {
    res.docActionOrder = docActionOrder;
  }
  return res;
}

// ---------------------------------------------------------------- messages

export type HostMessage =
  | {
      type: 'load';
      name: string;
      bytes: Uint8Array;
      comments?: DocComment[];
      editable?: boolean;
      docxParagraphs?: string[];
      pptxShapes?: string[][];
      pptxNotes?: string[];
      slideAspect?: number;
      byteLength?: number;
      siblingIndex?: number;
      siblingCount?: number;
      initialPage?: number;
    }
  | { type: 'comments'; comments: DocComment[]; docxParagraphs?: string[]; pptxNotes?: string[] }
  | { type: 'text'; name: string; body: string }
  | { type: 'epub'; book: EpubBookData }
  | {
      type: 'archive';
      name: string;
      totalSize: number;
      compressedTotal: number;
      entries: ArchiveEntryInfo[];
    }
  | {
      type: 'archiveEntry';
      path: string;
      kind: 'text' | 'image' | 'binary';
      text?: string;
      mime?: string;
      bytes?: Uint8Array;
      size: number;
    }
  | { type: 'compareImage'; name: string; bytes: Uint8Array }
  | { type: 'annotationsLoaded'; format: AnnotationExportFormat; content: string; classesText?: string }
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
  | { type: 'aiSettings'; settings: AiSettingsSnapshot; models?: string[] }
  | { type: 'aiOpen' }
  | { type: 'aiStream'; requestId: number; text: string; model?: string; done: boolean; error?: string }
  | { type: 'diffReport'; report: DocumentDiffReport }
  | { type: 'media'; name: string; src: string; mediaKind: 'audio' | 'video'; ext: string; byteLength: number }
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
  | { type: 'openExternalApp' }
  | { type: 'docMutate'; mutation: DocMutation }
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
  /** Markdown: atomically move source lines `[fromStart, fromEnd)` to target line `toLine` (outline drag reorder). */
  | { type: 'moveMarkdownLines'; fromStart: number; fromEnd: number; toLine: number }
  /** Excel: apply cell styling / number formatting to a rectangular range. */
  | { type: 'formatCells'; index: number; r0: number; c0: number; r1: number; c1: number; patch: CellFormatPatch }
  /** Compare current document/spreadsheet against latest version history or a user-chosen file. */
  | { type: 'compareDocument'; fromHistory?: boolean }
  /** Media: save a captured video frame PNG and open it directly in DocsView Image Inspector. */
  | { type: 'openCapturedImage'; bytes: Uint8Array; suffix?: string }
  /** Sheets: save a copy of sheet `index` in another format. */
  | { type: 'convert'; index: number; format: 'csv' | 'tsv' | 'xlsx' | 'jsonl' }
  /** JSONL: replace an entire record object (from the Record JSON Inspector) at 0-based `recordIndex`. */
  | { type: 'editJsonlRecord'; recordIndex: number; jsonText: string }
  /** Image: step to previous/next sibling image in the same directory (`[` / `]`). */
  | { type: 'stepFolderImage'; delta: -1 | 1 }
  /** Office (.docx / .pptx): convert document content to a clean Markdown `.md` file. */
  | { type: 'exportDocMarkdown' }
  /** Image: replace current image bytes in-place (e.g. crop), backed by VS Code undo/redo & save. */
  | { type: 'imageReplace'; bytes: Uint8Array; label?: string }
  /** Image: save a converted or cropped copy to a user-chosen path. */
  | { type: 'saveImageAs'; format: ImageExportFormat; bytes: Uint8Array; suffix?: string }
  /** Image: pick a second image (or latest history version) for visual Image Diff. */
  | { type: 'pickCompareImage'; fromHistory?: boolean }
  /** Image: load sibling or user-selected YOLO / COCO / LabelMe annotation file. */
  | { type: 'importAnnotations' }
  /** Image: save YOLO / COCO / LabelMe annotations next to the image. */
  | { type: 'exportAnnotations'; format: AnnotationExportFormat; content: string; classesContent?: string }
  /** Generic text file export (e.g. comments Markdown report, Mermaid SVG). */
  | { type: 'saveTextExport'; ext: string; suffix?: string; content: string }
  /** Generic binary file export (e.g. Mermaid PNG). */
  | { type: 'saveBytesExport'; ext: string; suffix?: string; bytes: Uint8Array }
  /** Markdown: save pasted clipboard image into `assets/` and insert markdown link. */
  | { type: 'pasteImage'; bytes: Uint8Array; ext: string; insertAtLine?: number }
  /** Markdown: open local image inside DocsView Image Inspector. */
  | { type: 'inspectImage'; src: string }
  /** PDF: extract a page range into a new PDF file. */
  | { type: 'extractPdfPages'; currentPage: number; totalPages: number }
  /** PDF: merge one or more external PDF files into the current PDF. */
  | { type: 'mergePdfs' }
  /** Archive: preview an entry inside a ZIP/TAR archive. */
  | { type: 'previewArchiveEntry'; path: string }
  /** Archive: extract an entry to a session temp folder and open immediately in VS Code (double-click). */
  | { type: 'openArchiveEntryTemp'; path: string }
  /** Archive: extract an entry to a user-chosen disk path and open it in VS Code. */
  | { type: 'extractArchiveEntry'; path: string }
  /** Archive: extract all archive contents into a user-chosen directory. */
  | { type: 'extractAllArchive' }
  /** AI Assistant: execute a context-aware prompt (streaming chunks back via `aiStream`). */
  | { type: 'aiRun'; requestId: number; context: AiPromptContext }
  /** AI Assistant: cancel an in-flight streaming request. */
  | { type: 'aiCancel'; requestId: number }
  /** AI Assistant: request current AI provider settings (and optionally probe `/models`). */
  | { type: 'aiGetSettings'; discoverModels?: boolean }
  /** AI Assistant: update `docsview.ai.provider`, `baseUrl`, or `model` in VS Code machine settings. */
  | { type: 'aiUpdateSettings'; provider?: AiProviderId; baseUrl?: string; model?: string }
  /** AI Assistant: prompt to store or clear API key in VS Code SecretStorage. */
  | { type: 'aiManageKey'; op: 'set' | 'clear' }
  /** Sent once per load (or state change): the document is on screen, or could not be rendered. */
  | { type: 'status'; ok: boolean; detail?: string; mode?: string; overlays?: string[] };

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
