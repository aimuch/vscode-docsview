// Shared Comments & Annotations UI for Word (.docx), PowerPoint (.pptx) and PDF (.pdf):
// sidebar comment cards, floating comment composer, inline text editor modal, and page/slide
// pin & box overlays.
import { formatCommentsAsMarkdown } from '../../common/commentsMarkdown';
import type { DocComment } from '../../common/protocol';
import { el, post, t } from './api';
import { icons } from './icons';
import { iconButton } from './ui';

function formatShortDate(raw: string | undefined): string {
  if (!raw) {
    return '';
  }
  // Handle PDF date format D:YYYYMMDDHHmmSS...
  const pdfMatch = /^D:(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2}))?/.exec(raw);
  if (pdfMatch) {
    const [, y, m, d, hh, mm] = pdfMatch;
    return hh && mm ? `${y}-${m}-${d} ${hh}:${mm}` : `${y}-${m}-${d}`;
  }
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) {
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export interface CommentsPanelOptions {
  docName?: () => string;
  targetLabel?: (comment: DocComment) => string;
  onSelect: (comment: DocComment) => void;
  onUpdate: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onToggleAddMode?: () => void;
}

export class CommentsPanel {
  readonly node: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly exportBtn: HTMLButtonElement;
  private readonly listEl: HTMLElement;
  private items: DocComment[] = [];
  private activeId: string | undefined;
  private editingId: string | undefined;

  constructor(private readonly opts: CommentsPanelOptions) {
    this.countEl = el('span', { class: 'dv-ol-count' });
    this.exportBtn = iconButton('export', t('exportCommentsMd'), () => this.exportMarkdown());
    this.exportBtn.classList.add('dv-cm-mini');
    const rightGroup = el('span', { class: 'dv-cm-head-actions' }, [this.exportBtn]);
    if (opts.onToggleAddMode) {
      const addBtn = el('button', { class: 'dv-cm-head-add', title: t('addComment') });
      addBtn.type = 'button';
      addBtn.innerHTML = `${icons.plus}<span>${t('addComment')}</span>`;
      addBtn.addEventListener('click', () => opts.onToggleAddMode?.());
      rightGroup.append(addBtn);
    }
    const head = el('div', { class: 'dv-cm-head' }, [this.countEl, rightGroup]);
    this.listEl = el('div', { class: 'dv-cm-list' });
    this.node = el('div', { class: 'dv-cm-panel' }, [head, this.listEl]);
    this.render();
  }

  exportMarkdown(): void {
    if (!this.items.length) {
      return;
    }
    const md = formatCommentsAsMarkdown(this.opts.docName?.() ?? 'Document', this.items, this.opts.targetLabel);
    post({ type: 'saveTextExport', ext: 'md', suffix: '-comments', content: md });
  }

  get count(): number {
    return this.items.length;
  }

  get active(): string | undefined {
    return this.activeId;
  }

  setComments(comments: DocComment[]): void {
    this.items = comments;
    if (this.activeId && !comments.some((c) => c.id === this.activeId)) {
      this.activeId = undefined;
    }
    if (this.editingId && !comments.some((c) => c.id === this.editingId)) {
      this.editingId = undefined;
    }
    this.render();
  }

  setActive(id: string | undefined, scrollIntoView = true): void {
    this.activeId = id;
    for (const card of this.listEl.querySelectorAll<HTMLElement>('.dv-cm-card')) {
      const on = card.dataset.commentId === id;
      card.classList.toggle('dv-cm-active', on);
      if (on && scrollIntoView) {
        card.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  private render(): void {
    this.countEl.textContent = t('commentsCount', this.items.length);
    this.exportBtn.disabled = this.items.length === 0;
    if (!this.items.length) {
      this.listEl.replaceChildren(el('div', { class: 'dv-ol-empty', text: t('noComments') }));
      return;
    }

    const cards = this.items.map((comment, idx) => {
      const card = el('div', { class: 'dv-cm-card' });
      card.dataset.commentId = comment.id;
      if (comment.id === this.activeId) {
        card.classList.add('dv-cm-active');
      }

      const badge = el('span', { class: 'dv-cm-badge', text: String(idx + 1) });
      const author = el('span', { class: 'dv-cm-author', text: comment.author || 'DocsView' });
      const dateStr = formatShortDate(comment.date);
      const dateEl = el('span', { class: 'dv-cm-date', text: dateStr });

      const editBtn = iconButton('pencil', t('editComment'), () => {
        this.editingId = comment.id;
        this.render();
      });
      editBtn.classList.add('dv-cm-mini');

      const delBtn = iconButton('trash', t('deleteComment'), () => {
        this.opts.onDelete(comment.id);
      });
      delBtn.classList.add('dv-cm-mini');

      const actions = el('span', { class: 'dv-cm-actions' }, [editBtn, delBtn]);
      actions.addEventListener('click', (e) => e.stopPropagation());

      const metaRow = el('div', { class: 'dv-cm-meta' }, [badge, author, dateEl, actions]);
      card.append(metaRow);

      const targetText = this.opts.targetLabel?.(comment) ?? '';
      if (targetText) {
        card.append(el('div', { class: 'dv-cm-target', text: targetText }));
      }

      if (this.editingId === comment.id) {
        const area = el('textarea', { class: 'dv-cm-textarea' });
        area.value = comment.text;
        area.rows = Math.max(2, Math.min(6, comment.text.split('\n').length + 1));
        const saveBtn = el('button', { class: 'dv-btn dv-cm-primary', text: t('save') });
        saveBtn.type = 'button';
        const cancelBtn = el('button', { class: 'dv-btn', text: t('cancel') });
        cancelBtn.type = 'button';

        const commit = () => {
          const next = area.value.trim();
          this.editingId = undefined;
          if (next && next !== comment.text) {
            this.opts.onUpdate(comment.id, next);
          } else {
            this.render();
          }
        };
        saveBtn.addEventListener('click', commit);
        cancelBtn.addEventListener('click', () => {
          this.editingId = undefined;
          this.render();
        });
        area.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.editingId = undefined;
            this.render();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
          }
        });
        const editorWrap = el('div', { class: 'dv-cm-edit-wrap' }, [
          area,
          el('div', { class: 'dv-cm-edit-btns' }, [cancelBtn, saveBtn]),
        ]);
        editorWrap.addEventListener('click', (e) => e.stopPropagation());
        card.append(editorWrap);
        requestAnimationFrame(() => {
          area.focus();
          area.select();
        });
      } else {
        card.append(el('div', { class: 'dv-cm-body', text: comment.text }));
      }

      card.addEventListener('click', () => {
        this.setActive(comment.id, false);
        this.opts.onSelect(comment);
      });

      return card;
    });

    this.listEl.replaceChildren(...cards);
  }
}

let activePopoverCleanup: (() => void) | undefined;

export function closeFloatingEditors(): void {
  activePopoverCleanup?.();
  activePopoverCleanup = undefined;
}

function mountFloatingDialog(opts: {
  anchor: { x: number; y: number };
  title: string;
  initialText?: string;
  placeholder?: string;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}): void {
  closeFloatingEditors();

  const pop = el('div', { class: 'dv-float-editor' });
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', opts.title);

  const head = el('div', { class: 'dv-float-head' }, [
    el('span', { class: 'dv-float-title', text: opts.title }),
  ]);
  const area = el('textarea', { class: 'dv-cm-textarea' });
  area.value = opts.initialText ?? '';
  area.placeholder = opts.placeholder ?? '';
  area.rows = Math.max(3, Math.min(10, (opts.initialText ?? '').split('\n').length + 1));

  const cancelBtn = el('button', { class: 'dv-btn', text: t('cancel') });
  cancelBtn.type = 'button';
  const saveBtn = el('button', { class: 'dv-btn dv-cm-primary', text: t('save') });
  saveBtn.type = 'button';

  const cleanup = () => {
    window.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('keydown', onEsc, true);
    pop.remove();
    if (activePopoverCleanup === cleanup) {
      activePopoverCleanup = undefined;
    }
  };

  const cancel = () => {
    cleanup();
    opts.onCancel?.();
  };

  const submit = () => {
    const val = area.value;
    cleanup();
    opts.onSubmit(val);
  };

  const onOutside = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node)) {
      cancel();
    }
  };
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  cancelBtn.addEventListener('click', cancel);
  saveBtn.addEventListener('click', submit);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  });

  pop.append(head, area, el('div', { class: 'dv-cm-edit-btns' }, [cancelBtn, saveBtn]));
  document.body.append(pop);

  const measured = pop.getBoundingClientRect();
  const pw = measured.width || 320;
  const ph = measured.height || 200;
  const left = Math.max(12, Math.min(Math.max(12, window.innerWidth - pw - 12), opts.anchor.x));
  const top = Math.max(44, Math.min(Math.max(44, window.innerHeight - ph - 12), opts.anchor.y));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  activePopoverCleanup = cleanup;
  setTimeout(() => {
    window.addEventListener('mousedown', onOutside, true);
    window.addEventListener('keydown', onEsc, true);
    area.focus();
    if (opts.initialText) {
      area.select();
    }
  }, 0);
}

export function openCommentComposer(opts: {
  anchor: { x: number; y: number };
  title: string;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}): void {
  mountFloatingDialog({
    anchor: opts.anchor,
    title: opts.title,
    placeholder: t('commentPlaceholder'),
    onSubmit: (raw) => {
      const trimmed = raw.trim();
      if (trimmed) {
        opts.onSubmit(trimmed);
      } else {
        opts.onCancel?.();
      }
    },
    onCancel: opts.onCancel,
  });
}

export function openInlineTextEditor(opts: {
  anchor: { x: number; y: number };
  title: string;
  initialText: string;
  onCommit: (nextText: string) => void;
}): void {
  mountFloatingDialog({
    anchor: opts.anchor,
    title: opts.title,
    initialText: opts.initialText,
    onSubmit: (next) => {
      if (next !== opts.initialText) {
        opts.onCommit(next);
      }
    },
  });
}

// ---------------------------------------------------------------- page / slide overlay pins & boxes

export function renderSurfaceAnnotations(
  surfaceEl: HTMLElement,
  entries: { comment: DocComment; badgeIndex: number }[],
  activeId: string | undefined,
  onSelect: (comment: DocComment) => void,
): void {
  let layer = surfaceEl.querySelector<HTMLElement>(':scope > .dv-annot-layer');
  if (!entries.length) {
    layer?.remove();
    return;
  }
  if (!layer) {
    layer = el('div', { class: 'dv-annot-layer' });
    surfaceEl.append(layer);
  }
  const nodes = entries.map(({ comment, badgeIndex }) => {
    const r = comment.rect ?? { x: 0.1, y: 0.1, w: 0, h: 0 };
    const isHighlight = comment.subtype === 'highlight';
    const isBox = !isHighlight && r.w > 0.005 && r.h > 0.005;
    const tip = `${comment.author}: ${comment.text}`;
    if (isHighlight) {
      const hl = el('div', { class: 'dv-annot-highlight', title: tip });
      hl.style.left = `${r.x * 100}%`;
      hl.style.top = `${r.y * 100}%`;
      hl.style.width = `${Math.max(0.01, r.w) * 100}%`;
      hl.style.height = `${Math.max(0.01, r.h) * 100}%`;
      const col = comment.color ?? '#fde047';
      hl.style.background = col.toLowerCase() === '#4ade80' ? 'rgba(74, 222, 128, 0.38)' : 'rgba(250, 204, 21, 0.42)';
      if (comment.id === activeId) {
        hl.classList.add('dv-annot-active');
      }
      hl.addEventListener('pointerdown', (e) => e.stopPropagation());
      hl.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(comment);
      });
      return hl;
    }
    if (isBox) {
      const box = el('div', { class: 'dv-annot-box', title: tip }, [
        el('span', { class: 'dv-annot-tag', text: String(badgeIndex) }),
      ]);
      box.style.left = `${r.x * 100}%`;
      box.style.top = `${r.y * 100}%`;
      box.style.width = `${r.w * 100}%`;
      box.style.height = `${r.h * 100}%`;
      if (comment.id === activeId) {
        box.classList.add('dv-annot-active');
      }
      box.addEventListener('pointerdown', (e) => e.stopPropagation());
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelect(comment);
      });
      return box;
    }
    const pin = el('button', { class: 'dv-annot-pin', title: tip, text: String(badgeIndex) });
    pin.type = 'button';
    pin.style.left = `${r.x * 100}%`;
    pin.style.top = `${r.y * 100}%`;
    if (comment.id === activeId) {
      pin.classList.add('dv-annot-active');
    }
    pin.addEventListener('pointerdown', (e) => e.stopPropagation());
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      onSelect(comment);
    });
    return pin;
  });
  layer.replaceChildren(...nodes);
}

export function attachSurfaceAnnotator(opts: {
  root: HTMLElement;
  allowBox: boolean;
  isActive: () => boolean;
  resolveSurface: (target: EventTarget | null) => { surface: HTMLElement; page: number } | undefined;
  titleForPage: (page: number) => string;
  onCreate: (page: number, rect: { x: number; y: number; w: number; h: number }, text: string) => void;
}): void {
  opts.root.addEventListener('pointerdown', (e) => {
    if (!opts.isActive() || e.button !== 0) {
      return;
    }
    const hit = opts.resolveSurface(e.target);
    if (!hit) {
      return;
    }
    const { surface, page } = hit;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const startX = clamp01((e.clientX - bounds.left) / bounds.width);
    const startY = clamp01((e.clientY - bounds.top) / bounds.height);

    if (!opts.allowBox) {
      const draftPin = el('span', { class: 'dv-annot-pin dv-annot-draft-pin', text: '+' });
      draftPin.style.left = `${startX * 100}%`;
      draftPin.style.top = `${startY * 100}%`;
      surface.append(draftPin);
      openCommentComposer({
        anchor: { x: e.clientX + 10, y: e.clientY + 10 },
        title: `${t('addComment')} · ${opts.titleForPage(page)}`,
        onSubmit: (text) => {
          draftPin.remove();
          opts.onCreate(page, { x: startX, y: startY, w: 0, h: 0 }, text);
        },
        onCancel: () => draftPin.remove(),
      });
      return;
    }

    const draft = el('div', { class: 'dv-annot-draft' });
    draft.style.left = `${startX * 100}%`;
    draft.style.top = `${startY * 100}%`;
    draft.style.width = '0%';
    draft.style.height = '0%';
    surface.append(draft);

    let endX = startX;
    let endY = startY;
    let lastClientX = e.clientX;
    let lastClientY = e.clientY;

    const onMove = (ev: PointerEvent) => {
      const b = surface.getBoundingClientRect();
      endX = clamp01((ev.clientX - b.left) / b.width);
      endY = clamp01((ev.clientY - b.top) / b.height);
      lastClientX = ev.clientX;
      lastClientY = ev.clientY;
      const x = Math.min(startX, endX);
      const y = Math.min(startY, endY);
      const w = Math.abs(endX - startX);
      const h = Math.abs(endY - startY);
      draft.style.left = `${x * 100}%`;
      draft.style.top = `${y * 100}%`;
      draft.style.width = `${w * 100}%`;
      draft.style.height = `${h * 100}%`;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const pxW = Math.abs(endX - startX) * bounds.width;
      const pxH = Math.abs(endY - startY) * bounds.height;
      const isBox = pxW > 8 && pxH > 8;
      const rect = isBox
        ? {
            x: Math.min(startX, endX),
            y: Math.min(startY, endY),
            w: Math.abs(endX - startX),
            h: Math.abs(endY - startY),
          }
        : { x: startX, y: startY, w: 0, h: 0 };

      if (!isBox) {
        draft.className = 'dv-annot-pin dv-annot-draft-pin';
        draft.textContent = '+';
        draft.style.left = `${startX * 100}%`;
        draft.style.top = `${startY * 100}%`;
        draft.style.width = '';
        draft.style.height = '';
      }

      openCommentComposer({
        anchor: { x: lastClientX + 10, y: lastClientY + 10 },
        title: `${t('addComment')} · ${opts.titleForPage(page)}`,
        onSubmit: (text) => {
          draft.remove();
          opts.onCreate(page, rect, text);
        },
        onCancel: () => draft.remove(),
      });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}
