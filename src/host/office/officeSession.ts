// Stateful editing & annotation session for .docx, .pptx and .pdf documents.
// Pure module (no vscode imports): manages memory-bounded undo/redo, hot-exit backup/restore, and byte export.
import type { DocComment, DocMutation, HostMessage } from '../../common/protocol';
import { applyDocxMutations, inspectDocx, resolveTargetIndex } from './docxPatcher';
import { applyPdfMutations, inspectPdf } from './pdfAnnotator';
import { applyPptxMutations, inspectPptx } from './pptxPatcher';

export type OfficeFormat = 'docx' | 'pptx' | 'pdf';

/** Maximum number of full byte snapshots retained in RAM; older steps replay from `initialBytes` on demand. */
const MAX_CACHED_STEPS = 6;

interface DocSnapshot {
  bytes: Uint8Array;
  comments: DocComment[];
  docxParagraphs?: string[];
  pptxShapes?: string[][];
  pptxNotes?: string[];
  slideAspect?: number;
}

interface OfficeStep {
  mutation: DocMutation;
  before?: DocSnapshot;
  after?: DocSnapshot;
}

export interface OfficeEditResult {
  message: HostMessage;
  undo(): HostMessage | Promise<HostMessage>;
  redo(): HostMessage | Promise<HostMessage>;
}

/** Ensures a plain Uint8Array (not a Node Buffer) so webview.postMessage sends binary bytes. */
function plainU8(input: Uint8Array): Uint8Array {
  if (input.constructor === Uint8Array) {
    return input;
  }
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy;
}

function inspectSyncFormat(format: 'docx' | 'pptx', bytes: Uint8Array): DocSnapshot {
  const clean = plainU8(bytes);
  if (format === 'docx') {
    const info = inspectDocx(clean);
    return { bytes: clean, comments: info.comments, docxParagraphs: info.paragraphs };
  }
  const info = inspectPptx(clean);
  return {
    bytes: clean,
    comments: info.comments,
    pptxShapes: info.shapes,
    pptxNotes: info.notes,
    slideAspect: info.slideAspect,
  };
}

async function inspectByFormat(format: OfficeFormat, bytes: Uint8Array): Promise<DocSnapshot> {
  if (format === 'docx' || format === 'pptx') {
    return inspectSyncFormat(format, bytes);
  }
  const clean = plainU8(bytes);
  const comments = await inspectPdf(clean);
  return { bytes: clean, comments };
}

async function mutateMany(format: OfficeFormat, bytes: Uint8Array, mutations: readonly DocMutation[]): Promise<Uint8Array> {
  if (!mutations.length) {
    return bytes;
  }
  if (format === 'docx') {
    return applyDocxMutations(bytes, mutations);
  }
  if (format === 'pptx') {
    return applyPptxMutations(bytes, mutations);
  }
  return applyPdfMutations(bytes, mutations);
}

export class OfficeSession {
  private initialBytes!: Uint8Array;
  private current!: DocSnapshot;
  private history: OfficeStep[] = [];
  private cursor = 0;
  private savedCursor = 0;

  private constructor(
    readonly format: OfficeFormat,
    readonly fileName: string,
  ) {}

  static async open(format: OfficeFormat, bytes: Uint8Array, fileName: string): Promise<OfficeSession> {
    const session = new OfficeSession(format, fileName);
    await session.load(bytes);
    return session;
  }

  async load(bytes: Uint8Array): Promise<void> {
    const clean = plainU8(bytes);
    this.initialBytes = clean;
    this.current = await inspectByFormat(this.format, clean);
    this.history = [];
    this.cursor = 0;
    this.savedCursor = 0;
  }

  get dirty(): boolean {
    return this.cursor !== this.savedCursor;
  }

  get comments(): DocComment[] {
    return this.current.comments;
  }

  loadMessage(): HostMessage {
    return {
      type: 'load',
      name: this.fileName,
      bytes: plainU8(this.current.bytes),
      editable: true,
      comments: this.current.comments,
      docxParagraphs: this.current.docxParagraphs,
      pptxShapes: this.current.pptxShapes,
      pptxNotes: this.current.pptxNotes,
      slideAspect: this.current.slideAspect,
    };
  }

  private messageForTransition(mutation: DocMutation): HostMessage {
    const isCommentOrNoteOnly =
      mutation.kind === 'addComment' ||
      mutation.kind === 'updateComment' ||
      mutation.kind === 'deleteComment' ||
      mutation.kind === 'editPptxNote';
    if (isCommentOrNoteOnly) {
      return {
        type: 'comments',
        comments: this.current.comments,
        docxParagraphs: this.current.docxParagraphs,
        pptxNotes: this.current.pptxNotes,
      };
    }
    return this.loadMessage();
  }

  /** Releases full byte buffers on steps far behind `cursor`, keeping RAM bounded on large PDFs/PPTs. */
  private evictOldSnapshots(): void {
    const keepFrom = Math.max(0, this.cursor - MAX_CACHED_STEPS);
    for (let i = 0; i < keepFrom; i++) {
      this.history[i].before = undefined;
      this.history[i].after = undefined;
    }
  }

  private rebuildAt(targetCursor: number): DocSnapshot | Promise<DocSnapshot> {
    const muts = this.history.slice(0, targetCursor).map((s) => s.mutation);
    if (this.format === 'docx') {
      return inspectSyncFormat('docx', applyDocxMutations(this.initialBytes, muts));
    }
    if (this.format === 'pptx') {
      return inspectSyncFormat('pptx', applyPptxMutations(this.initialBytes, muts));
    }
    return mutateMany('pdf', this.initialBytes, muts).then((b) => inspectByFormat('pdf', b));
  }

  async apply(mutation: DocMutation): Promise<OfficeEditResult | undefined> {
    if (mutation.kind === 'editDocxParagraph') {
      if (this.format !== 'docx') {
        return undefined;
      }
      const paras = this.current.docxParagraphs ?? [];
      if (resolveTargetIndex(paras, mutation.pIndex, mutation.expected) < 0) {
        return undefined;
      }
      if (mutation.text === mutation.expected) {
        return undefined;
      }
    } else if (mutation.kind === 'editPptxText') {
      if (this.format !== 'pptx') {
        return undefined;
      }
      const slideShapes = this.current.pptxShapes?.[mutation.slideIndex] ?? [];
      if (resolveTargetIndex(slideShapes, mutation.shapeIndex, mutation.expected, 6) < 0) {
        return undefined;
      }
      if (mutation.text === mutation.expected) {
        return undefined;
      }
    } else if (mutation.kind === 'editPptxNote') {
      if (this.format !== 'pptx') {
        return undefined;
      }
      const curNote = this.current.pptxNotes?.[mutation.slideIndex] ?? '';
      if (mutation.text.trim() === curNote.trim()) {
        return undefined;
      }
    } else if (mutation.kind === 'addComment' && !mutation.text.trim() && mutation.subtype !== 'highlight') {
      return undefined;
    }

    const before = this.current;
    const nextBytes = await mutateMany(this.format, before.bytes, [mutation]);
    const after = await inspectByFormat(this.format, nextBytes);

    if (this.cursor < this.history.length) {
      if (this.savedCursor > this.cursor) {
        this.savedCursor = -1;
      }
      this.history.length = this.cursor;
    }
    const step: OfficeStep = { mutation, before, after };
    this.history.push(step);
    this.cursor = this.history.length;
    this.current = after;
    this.evictOldSnapshots();

    return {
      message: this.messageForTransition(mutation),
      undo: () => {
        if (this.cursor > 0 && this.history[this.cursor - 1] === step) {
          this.cursor--;
        }
        if (step.before) {
          this.current = step.before;
          return this.messageForTransition(mutation);
        }
        const rebuilt = this.rebuildAt(this.cursor);
        if (rebuilt instanceof Promise) {
          return rebuilt.then((snap) => {
            step.before = snap;
            this.current = snap;
            return this.messageForTransition(mutation);
          });
        }
        step.before = rebuilt;
        this.current = rebuilt;
        return this.messageForTransition(mutation);
      },
      redo: () => {
        if (this.history[this.cursor] === step) {
          this.cursor++;
        }
        if (step.after) {
          this.current = step.after;
          return this.messageForTransition(mutation);
        }
        const rebuilt = this.rebuildAt(this.cursor);
        if (rebuilt instanceof Promise) {
          return rebuilt.then((snap) => {
            step.after = snap;
            this.current = snap;
            return this.messageForTransition(mutation);
          });
        }
        step.after = rebuilt;
        this.current = rebuilt;
        return this.messageForTransition(mutation);
      },
    };
  }

  export(): Uint8Array {
    return plainU8(this.current.bytes);
  }

  markSaved(): void {
    this.savedCursor = this.cursor;
  }

  backup(): string {
    return JSON.stringify(this.history.slice(0, this.cursor).map((s) => s.mutation));
  }

  async restore(raw: string): Promise<void> {
    let items: unknown;
    try {
      items = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(items)) {
      return;
    }
    for (const item of items) {
      if (item && typeof item === 'object' && 'kind' in item) {
        await this.apply(item as DocMutation);
      }
    }
  }
}
