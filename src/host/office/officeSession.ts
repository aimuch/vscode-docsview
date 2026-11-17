// Stateful editing & annotation session for .docx, .pptx and .pdf documents.
// Pure module (no vscode imports): manages undo/redo, hot-exit backup/restore, and byte export.
import type { DocComment, DocMutation, HostMessage } from '../../common/protocol';
import { applyDocxMutations, inspectDocx } from './docxPatcher';
import { applyPdfMutations, inspectPdf } from './pdfAnnotator';
import { applyPptxMutations, inspectPptx } from './pptxPatcher';

export type OfficeFormat = 'docx' | 'pptx' | 'pdf';

interface DocSnapshot {
  bytes: Uint8Array;
  comments: DocComment[];
  docxParagraphs?: string[];
  pptxShapes?: string[][];
  slideAspect?: number;
}

interface OfficeStep {
  mutation: DocMutation;
  before: DocSnapshot;
  after: DocSnapshot;
}

export interface OfficeEditResult {
  message: HostMessage;
  undo(): HostMessage;
  redo(): HostMessage;
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

async function inspectByFormat(format: OfficeFormat, bytes: Uint8Array): Promise<DocSnapshot> {
  const clean = plainU8(bytes);
  if (format === 'docx') {
    const info = inspectDocx(clean);
    return {
      bytes: clean,
      comments: info.comments,
      docxParagraphs: info.paragraphs,
    };
  }
  if (format === 'pptx') {
    const info = inspectPptx(clean);
    return {
      bytes: clean,
      comments: info.comments,
      pptxShapes: info.shapes,
      slideAspect: info.slideAspect,
    };
  }
  const comments = await inspectPdf(clean);
  return {
    bytes: clean,
    comments,
  };
}

async function mutateOnce(format: OfficeFormat, bytes: Uint8Array, mutation: DocMutation): Promise<Uint8Array> {
  if (format === 'docx') {
    return applyDocxMutations(bytes, [mutation]);
  }
  if (format === 'pptx') {
    return applyPptxMutations(bytes, [mutation]);
  }
  return applyPdfMutations(bytes, [mutation]);
}

export class OfficeSession {
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
    this.current = await inspectByFormat(this.format, bytes);
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
      slideAspect: this.current.slideAspect,
    };
  }

  private messageForTransition(mutation: DocMutation): HostMessage {
    const isCommentOnly =
      mutation.kind === 'addComment' || mutation.kind === 'updateComment' || mutation.kind === 'deleteComment';
    if (isCommentOnly && (this.format === 'pdf' || this.format === 'pptx')) {
      return { type: 'comments', comments: this.current.comments };
    }
    return this.loadMessage();
  }

  async apply(mutation: DocMutation): Promise<OfficeEditResult | undefined> {
    if (mutation.kind === 'editDocxParagraph') {
      if (this.format !== 'docx') {
        return undefined;
      }
      const paras = this.current.docxParagraphs ?? [];
      const exact = paras[mutation.pIndex]?.trim() === mutation.expected.trim();
      const anywhere = paras.some((p) => p.trim() === mutation.expected.trim());
      if (!exact && !anywhere) {
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
      const exact = slideShapes[mutation.shapeIndex]?.trim() === mutation.expected.trim();
      const anywhere = slideShapes.some((s) => s.trim() === mutation.expected.trim());
      if (!exact && !anywhere) {
        return undefined;
      }
      if (mutation.text === mutation.expected) {
        return undefined;
      }
    } else if (mutation.kind === 'addComment' && !mutation.text.trim()) {
      return undefined;
    }

    const before = this.current;
    const nextBytes = await mutateOnce(this.format, before.bytes, mutation);
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

    return {
      message: this.messageForTransition(mutation),
      undo: () => {
        if (this.cursor > 0 && this.history[this.cursor - 1] === step) {
          this.cursor--;
        }
        this.current = step.before;
        return this.messageForTransition(mutation);
      },
      redo: () => {
        if (this.history[this.cursor] === step) {
          this.cursor++;
        }
        this.current = step.after;
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
