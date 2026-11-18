// Pure, zero-dependency explicit finite state machines shared across host sessions and webviews:
// 1. Generic observable `StateMachine<S>`
// 2. `InteractionModeMachine` for Office/PDF ('read' | 'edit' | 'annotate' | 'present')
// 3. `BinarySaveGate` content-fingerprint watcher gate (replaces magic `ignoreWatcherUntil` timestamps)

export class StateMachine<S> {
  private current: S;
  private readonly listeners = new Set<(next: S, prev: S) => void>();

  constructor(
    initial: S,
    private readonly equals: (a: S, b: S) => boolean = Object.is,
  ) {
    this.current = initial;
  }

  get state(): S {
    return this.current;
  }

  transition(next: S): boolean {
    if (this.equals(this.current, next)) {
      return false;
    }
    const prev = this.current;
    this.current = next;
    for (const listener of this.listeners) {
      listener(next, prev);
    }
    return true;
  }

  subscribe(listener: (next: S, prev: S) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// ---------------------------------------------------------------- Office / PDF interaction mode machine

export type DocInteractionMode = 'read' | 'edit' | 'annotate' | 'present';

export class InteractionModeMachine {
  private editable = false;
  private readonly machine = new StateMachine<DocInteractionMode>('read');

  get mode(): DocInteractionMode {
    return this.machine.state;
  }

  get isEditable(): boolean {
    return this.editable;
  }

  setEditable(editable: boolean): void {
    this.editable = editable;
    if (!editable && (this.machine.state === 'edit' || this.machine.state === 'annotate')) {
      this.machine.transition('read');
    }
  }

  setMode(requested: DocInteractionMode): DocInteractionMode {
    if (!this.editable && (requested === 'edit' || requested === 'annotate')) {
      this.machine.transition('read');
      return 'read';
    }
    this.machine.transition(requested);
    return this.machine.state;
  }

  toggle(target: 'edit' | 'annotate'): DocInteractionMode {
    return this.setMode(this.machine.state === target ? 'read' : target);
  }

  onChange(listener: (next: DocInteractionMode, prev: DocInteractionMode) => void): () => void {
    return this.machine.subscribe(listener);
  }
}

// ---------------------------------------------------------------- Content-fingerprint binary watcher gate

/** Fast 32-bit FNV-1a + length fingerprint for distinguishing self-writes from external disk changes. */
export function fingerprintBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  // Stride very large (>4 MB) buffers so fingerprinting stays < 1 ms even on 50 MB PDFs/PSDs.
  const step = bytes.byteLength > 4 * 1024 * 1024 ? Math.floor(bytes.byteLength / (1024 * 1024)) : 1;
  for (let i = 0; i < bytes.byteLength; i += step) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${bytes.byteLength}:${hash >>> 0}`;
}

export type DiskChangeVerdict = 'self-write' | 'reload' | 'conflict-new' | 'conflict-known';

export class BinarySaveGate {
  private lastDiskFingerprint = '';
  private expectedSelfSaveFingerprint: string | undefined;
  private conflictDetected = false;

  get hasConflict(): boolean {
    return this.conflictDetected;
  }

  recordLoadedFromDisk(bytes: Uint8Array): void {
    this.lastDiskFingerprint = fingerprintBytes(bytes);
    this.expectedSelfSaveFingerprint = undefined;
    this.conflictDetected = false;
  }

  beginSelfSave(bytes: Uint8Array): void {
    this.expectedSelfSaveFingerprint = fingerprintBytes(bytes);
  }

  completeSelfSave(bytes: Uint8Array): void {
    const fp = fingerprintBytes(bytes);
    this.lastDiskFingerprint = fp;
    this.expectedSelfSaveFingerprint = fp;
    this.conflictDetected = false;
  }

  /** Evaluates a file-watcher event given the latest bytes on disk and whether in-memory edits exist. */
  evaluateDiskBytes(diskBytes: Uint8Array, isDirty: boolean): DiskChangeVerdict {
    const fp = fingerprintBytes(diskBytes);
    if (fp === this.expectedSelfSaveFingerprint || (!isDirty && fp === this.lastDiskFingerprint)) {
      this.lastDiskFingerprint = fp;
      return 'self-write';
    }
    this.lastDiskFingerprint = fp;
    if (!isDirty) {
      this.conflictDetected = false;
      return 'reload';
    }
    if (!this.conflictDetected) {
      this.conflictDetected = true;
      return 'conflict-new';
    }
    return 'conflict-known';
  }
}
