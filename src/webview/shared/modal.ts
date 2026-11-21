// Accessible modal dialog helper shared across DocsView webviews.
// Provides role="dialog", aria-modal, Tab focus trap, mousedown backdrop dismissal,
// and automatic Escape + focus restoration via overlayStack.
import { el, t } from './api';
import { overlayStack } from './overlayStack';
import { iconButton } from './ui';

export interface ModalOptions {
  id: string;
  title: string;
  width?: string;
  body: HTMLElement[];
  footer?: HTMLElement[];
  headExtra?: HTMLElement[];
  initialFocus?: HTMLElement;
  onClose?: () => void;
}

export interface ModalHandle {
  backdrop: HTMLElement;
  modal: HTMLElement;
  close(): void;
}

export function openAccessibleModal(opts: ModalOptions): ModalHandle {
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const backdrop = el('div', { class: 'dv-modal-backdrop' });

  const close = () => {
    window.removeEventListener('keydown', onTrapKey, true);
    overlayStack.remove(opts.id);
    backdrop.remove();
    opts.onClose?.();
  };

  const closeBtn = iconButton('close', t('cancel'), close);
  const head = el('div', { class: 'dv-modal-head' }, [
    el('span', { class: 'dv-modal-title', text: opts.title }),
    ...(opts.headExtra ?? []),
    el('div', { class: 'dv-spacer' }),
    closeBtn,
  ]);

  const bodyEl = el('div', { class: 'dv-modal-body' }, opts.body);
  const children: HTMLElement[] = [head, bodyEl];
  if (opts.footer?.length) {
    children.push(el('div', { class: 'dv-modal-footer' }, opts.footer));
  }

  const modal = el('div', { class: 'dv-modal' }, children);
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', opts.title);
  if (opts.width) {
    modal.style.width = opts.width;
  }

  const onTrapKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !backdrop.isConnected) {
      return;
    }
    const focusables = [
      ...modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((n) => !n.hidden && !n.closest('[hidden]'));
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || !modal.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  backdrop.append(modal);
  // Use mousedown (not click) so dragging inside a canvas/input and releasing outside never accidentally closes the modal.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) {
      close();
    }
  });
  document.body.append(backdrop);
  window.addEventListener('keydown', onTrapKey, true);
  overlayStack.push({
    id: opts.id,
    isOpen: () => backdrop.isConnected,
    close,
    restoreFocus: () => trigger,
  });

  const focusTarget = opts.initialFocus ?? modal.querySelector<HTMLElement>('input, textarea, select, button');
  focusTarget?.focus();

  return { backdrop, modal, close };
}
