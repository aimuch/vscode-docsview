// Pure memory-bounded undo/redo session for raster & vector image edits (`docsview.image`).
// Evicts byte buffers directly on older step objects (`step.before = undefined`) so closures held
// by VS Code's CustomDocumentEditEvent stack release their multi-megabyte Uint8Arrays to GC.

export const MAX_IMAGE_HISTORY_STEPS = 10;
export const MAX_IMAGE_HISTORY_BYTES = 128 * 1024 * 1024;

export function plainU8(bytes: Uint8Array): Uint8Array {
  if (bytes.constructor === Uint8Array) {
    return bytes;
  }
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

export interface ImageStep {
  readonly beforeVer: number;
  readonly afterVer: number;
  before: Uint8Array | undefined;
  after: Uint8Array | undefined;
}

export interface ImageReplaceHandle {
  readonly step: ImageStep;
  undo(): Uint8Array;
  redo(): Uint8Array;
}

export class ImageSession {
  private originBytes: Uint8Array;
  private savedBytes: Uint8Array;
  private current: Uint8Array;
  private steps: ImageStep[] = [];
  private nextVer = 1;
  private currentVer = 0;
  private savedVer = 0;

  constructor(bytes: Uint8Array) {
    const clean = plainU8(bytes);
    this.originBytes = clean;
    this.savedBytes = clean;
    this.current = clean;
  }

  get bytes(): Uint8Array {
    return this.current;
  }

  get dirty(): boolean {
    return this.currentVer !== this.savedVer;
  }

  get retainedBytes(): number {
    return this.steps.reduce((sum, s) => sum + (s.before?.byteLength ?? 0) + (s.after?.byteLength ?? 0), 0);
  }

  reset(bytes: Uint8Array): void {
    const clean = plainU8(bytes);
    this.originBytes = clean;
    this.savedBytes = clean;
    this.current = clean;
    for (const s of this.steps) {
      s.before = undefined;
      s.after = undefined;
    }
    this.steps = [];
    this.currentVer = 0;
    this.savedVer = 0;
  }

  /** Syncs in-memory text edits from a side-by-side SVG source editor without marking CustomDocument dirty. */
  syncFromTextEditor(bytes: Uint8Array): void {
    const clean = plainU8(bytes);
    this.current = clean;
    if (!this.dirty) {
      this.originBytes = clean;
      this.savedBytes = clean;
    }
  }

  markSaved(): void {
    this.savedVer = this.currentVer;
    this.savedBytes = this.current;
  }

  private resolveSnapshotForVer(targetVer: number): { ver: number; bytes: Uint8Array } {
    if (targetVer === this.savedVer) {
      return { ver: targetVer, bytes: this.savedBytes };
    }
    if (targetVer === 0) {
      return { ver: 0, bytes: this.originBytes };
    }
    for (const s of this.steps) {
      if (s.beforeVer === targetVer && s.before) {
        return { ver: targetVer, bytes: s.before };
      }
      if (s.afterVer === targetVer && s.after) {
        return { ver: targetVer, bytes: s.after };
      }
    }
    // Step was evicted due to memory cap: fall back to saved snapshot (if <= targetVer) or origin.
    if (this.savedVer <= targetVer) {
      return { ver: this.savedVer, bytes: this.savedBytes };
    }
    return { ver: 0, bytes: this.originBytes };
  }

  replace(nextBytes: Uint8Array): ImageReplaceHandle {
    const after = plainU8(nextBytes);
    const before = this.current;
    const beforeVer = this.currentVer;
    const afterVer = this.nextVer++;

    // Drop any redo branch ahead of currentVer and release its buffers.
    const curIdx = this.steps.findIndex((s) => s.afterVer === beforeVer);
    const keepLen = beforeVer === 0 ? 0 : curIdx >= 0 ? curIdx + 1 : this.steps.length;
    for (let i = keepLen; i < this.steps.length; i++) {
      this.steps[i].before = undefined;
      this.steps[i].after = undefined;
    }
    this.steps.length = keepLen;

    const step: ImageStep = { beforeVer, afterVer, before, after };
    this.steps.push(step);
    this.current = after;
    this.currentVer = afterVer;
    this.evict();

    return {
      step,
      undo: () => {
        if (step.before) {
          this.currentVer = step.beforeVer;
          this.current = step.before;
          return step.before;
        }
        const fallback = this.resolveSnapshotForVer(step.beforeVer);
        this.currentVer = fallback.ver;
        this.current = fallback.bytes;
        return fallback.bytes;
      },
      redo: () => {
        if (step.after) {
          this.currentVer = step.afterVer;
          this.current = step.after;
        }
        return this.current;
      },
    };
  }

  private evict(): void {
    let total = this.retainedBytes;
    let activeCount = this.steps.filter((s) => s.before !== undefined || s.after !== undefined).length;
    for (let i = 0; i < this.steps.length - 1; i++) {
      if (activeCount <= MAX_IMAGE_HISTORY_STEPS && total <= MAX_IMAGE_HISTORY_BYTES) {
        break;
      }
      const s = this.steps[i];
      if (s.before !== undefined || s.after !== undefined) {
        total -= (s.before?.byteLength ?? 0) + (s.after?.byteLength ?? 0);
        s.before = undefined;
        s.after = undefined;
        activeCount--;
      }
    }
  }

  dispose(): void {
    for (const s of this.steps) {
      s.before = undefined;
      s.after = undefined;
    }
    this.steps = [];
  }
}
