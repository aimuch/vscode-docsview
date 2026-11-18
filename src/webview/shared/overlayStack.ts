// Deterministic LIFO transient overlay & Escape-key manager for all DocsView webviews
// (inspired by `vscode-git-map/src/escapeStack.ts`).
// Ensures `Escape` always closes the topmost open surface first and restores focus predictably,
// while exposing `getOpenOverlayIds()` for deterministic UI & Agent inspection (AX).

export interface OverlayEntry {
  readonly id: string;
  readonly isOpen: () => boolean;
  readonly close: () => void;
  readonly restoreFocus?: () => HTMLElement | null | undefined;
}

class WebviewOverlayStack {
  private entries: OverlayEntry[] = [];
  private listenerInstalled = false;
  private readonly changeListeners = new Set<(ids: string[]) => void>();

  private installListener(): void {
    if (this.listenerInstalled || typeof window === 'undefined') {
      return;
    }
    this.listenerInstalled = true;
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) {
          return;
        }
        if (this.popTop(true)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
  }

  push(entry: OverlayEntry): void {
    this.installListener();
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    this.entries.push(entry);
    this.notify();
  }

  remove(id: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) {
      this.notify();
    }
  }

  /** Closes the topmost currently open overlay, optionally restoring focus to its trigger. */
  popTop(restoreFocus = false): boolean {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (!entry.isOpen()) {
        this.entries.splice(i, 1);
        continue;
      }
      this.entries.splice(i, 1);
      const focusTarget = restoreFocus ? entry.restoreFocus?.() : undefined;
      entry.close();
      focusTarget?.focus?.();
      this.notify();
      return true;
    }
    return false;
  }

  hasOpen(excludeId?: string): boolean {
    return this.entries.some((e) => e.id !== excludeId && e.isOpen());
  }

  getOpenIds(): string[] {
    return this.entries.filter((e) => e.isOpen()).map((e) => e.id);
  }

  onChange(listener: (ids: string[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Test helper: clears all entries. */
  resetForTests(): void {
    this.entries = [];
  }

  private notify(): void {
    const openIds = this.getOpenIds();
    for (const fn of this.changeListeners) {
      fn(openIds);
    }
  }
}

export const overlayStack = new WebviewOverlayStack();

/**
 * Keeps the host's `docsview.getViewerState` snapshot synced in real time whenever transient
 * overlays open or close (only after `isReady()` becomes true so initial load status comes first).
 */
export function bindLiveViewerStatus(
  postStatus: (mode: string, overlays: string[]) => void,
  getMode: () => string,
  isReady: () => boolean,
): () => void {
  return overlayStack.onChange((overlays) => {
    if (isReady()) {
      postStatus(getMode(), overlays);
    }
  });
}
