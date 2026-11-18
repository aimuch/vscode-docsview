// Shared, format-aware AI Assistant controller & floating workbench card for DocsView webviews.
// Driven by an explicit `StateMachine<AiUiPhase>` ('closed' | 'idle' | 'streaming' | 'done' | 'error')
// and integrated with `overlayStack` (Esc stops active stream first; second Esc closes & restores focus).
import type { AiActionKind, AiPromptContext, AiSheetSchemaContext, ViewerKind } from '../../common/protocol';
import { StateMachine } from '../../common/stateMachine';
import { el, onMessage, post, t } from './api';
import { icons } from './icons';
import { overlayStack } from './overlayStack';
import { getAiSettings, iconButton, onAiSettingsChange } from './ui';

export type AiUiPhase = 'closed' | 'idle' | 'streaming' | 'done' | 'error';

export interface AiCapturedContext {
  selection?: string;
  surrounding?: string;
  badge?: string;
  sheetSchema?: AiSheetSchemaContext;
  /** Viewer-specific anchor metadata (e.g. Markdown line range, DOCX pIndex, PPTX slide/shape, Sheet selection). */
  meta?: unknown;
}

export interface AiQuickAction {
  kind: AiActionKind;
  label: () => string;
  visible?: (captured: AiCapturedContext) => boolean;
}

export interface AiApplyResult {
  text: string;
  action: AiActionKind;
  captured: AiCapturedContext;
}

export interface AiApplyAction {
  id: string;
  label: string | (() => string);
  primary?: boolean;
  visible?: (result: AiApplyResult) => boolean;
  /** Return `false` to keep the AI card open after applying. */
  onApply: (result: AiApplyResult) => boolean | void;
}

export interface AiAssistantOptions {
  viewerKind: ViewerKind;
  getFileName?: () => string;
  captureContext: () => AiCapturedContext;
  quickActions?: AiQuickAction[];
  applyActions?: AiApplyAction[];
  /** Optional root element where selecting text surfaces a compact floating `✨ AI` trigger pill. */
  selectionRoot?: HTMLElement;
  /** Opens the host Settings Drawer when the user clicks the provider badge. */
  onOpenSettings?: () => void;
  /** Element to return focus to when the AI card closes. */
  focusReturnTarget?: () => HTMLElement | null | undefined;
}

export interface AiAssistantHandle {
  /** Toolbar `✨` button ready to mount in `{ id: 'ai', nodes: [ai.button] }`. */
  readonly button: HTMLButtonElement;
  readonly phaseMachine: StateMachine<AiUiPhase>;
  open(opts?: {
    presetAction?: AiActionKind;
    initialPrompt?: string;
    autoRun?: boolean;
    capturedOverride?: AiCapturedContext;
  }): void;
  close(): void;
  dispose(): void;
}

let reqCounter = 0;

function defaultQuickActions(kind: ViewerKind): AiQuickAction[] {
  if (kind === 'sheet') {
    return [
      {
        kind: 'formula',
        label: () => t('aiActFormula'),
        visible: (c) => !c.sheetSchema?.isJsonl,
      },
      { kind: 'tableFill', label: () => t('aiActTableFill') },
      { kind: 'summarize', label: () => t('aiActSummarize') },
      { kind: 'explain', label: () => t('aiActExplain') },
      { kind: 'translate', label: () => t('aiActTranslate') },
    ];
  }
  const hasSel = (c: AiCapturedContext) => Boolean(c.selection && c.selection.trim().length > 0);
  const editableDoc = kind === 'markdown' || kind === 'docx' || kind === 'pptx';
  const actions: AiQuickAction[] = [];
  if (editableDoc) {
    actions.push(
      { kind: 'polish', label: () => t('aiActPolish'), visible: hasSel },
      { kind: 'concise', label: () => t('aiActConcise'), visible: hasSel },
      { kind: 'expand', label: () => t('aiActExpand'), visible: hasSel },
      { kind: 'fix', label: () => t('aiActFix'), visible: hasSel },
    );
  }
  actions.push(
    { kind: 'translate', label: () => t('aiActTranslate') },
    { kind: 'explain', label: () => t('aiActExplain') },
    { kind: 'summarize', label: () => t('aiActSummarize') },
  );
  return actions;
}

export function createAiAssistant(opts: AiAssistantOptions): AiAssistantHandle {
  const phaseMachine = new StateMachine<AiUiPhase>('closed');
  const quickActions = opts.quickActions ?? defaultQuickActions(opts.viewerKind);
  const applyActions = opts.applyActions ?? [];

  let activeRequestId = 0;
  let lastAction: AiActionKind = opts.viewerKind === 'sheet' ? 'formula' : 'generate';
  let captured: AiCapturedContext = {};
  let outputText = '';
  let errorMessage = '';
  let activeModelLabel = '';

  const button = iconButton('sparkle', t('aiOpenTip'), () => {
    if (phaseMachine.state !== 'closed') {
      close();
    } else {
      open();
    }
  });
  button.classList.add('dv-ai-trigger-btn');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');

  // ---------------------------------------------------------------- Card DOM

  const card = el('section', { class: 'dv-ai-card' });
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t('aiAssistant'));
  card.hidden = true;

  const titleIcon = el('span', { class: 'dv-ai-title-icon' });
  titleIcon.innerHTML = icons.sparkle;

  const contextBadgeEl = el('span', { class: 'dv-ai-ctx-badge' });
  const providerPillBtn = el('button', { class: 'dv-ai-provider-pill', title: t('settings') });
  providerPillBtn.type = 'button';
  providerPillBtn.addEventListener('click', () => {
    opts.onOpenSettings?.();
  });

  const closeCardBtn = iconButton('close', t('close'), () => close());
  closeCardBtn.classList.add('dv-ai-close-btn');

  const headerEl = el('div', { class: 'dv-ai-header' }, [
    titleIcon,
    el('span', { class: 'dv-ai-title', text: t('aiAssistant') }),
    contextBadgeEl,
    el('span', { class: 'dv-spacer' }),
    providerPillBtn,
    closeCardBtn,
  ]);

  const chipsWrap = el('div', { class: 'dv-ai-chips' });

  const promptInput = el('textarea', { class: 'dv-ai-prompt' });
  promptInput.placeholder = opts.viewerKind === 'sheet' ? t('aiFormulaPlaceholder') : t('aiPromptPlaceholder');
  promptInput.rows = 2;

  const sendBtn = el('button', { class: 'dv-btn dv-ai-primary-btn' });
  sendBtn.type = 'button';
  const sendIcon = el('span', { class: 'dv-ai-btn-icon' });
  sendIcon.innerHTML = icons.sparkle;
  const sendLabel = el('span', { text: t('aiSend') });
  sendBtn.append(sendIcon, sendLabel);

  const stopBtn = el('button', { class: 'dv-btn dv-ai-stop-btn' });
  stopBtn.type = 'button';
  stopBtn.hidden = true;
  const stopIcon = el('span', { class: 'dv-ai-btn-icon' });
  stopIcon.innerHTML = icons.stop;
  stopBtn.append(stopIcon, el('span', { text: t('aiStop') }));

  const inputFooter = el('div', { class: 'dv-ai-input-row' }, [
    el('span', { class: 'dv-ai-shortcut-hint', text: 'Ctrl/Cmd + Enter' }),
    el('span', { class: 'dv-spacer' }),
    stopBtn,
    sendBtn,
  ]);

  const statusLineEl = el('div', { class: 'dv-ai-status' });
  statusLineEl.hidden = true;

  const outputPre = el('div', { class: 'dv-ai-output' });
  outputPre.hidden = true;

  const applyWrap = el('div', { class: 'dv-ai-apply-bar' });
  applyWrap.hidden = true;

  card.append(headerEl, chipsWrap, promptInput, inputFooter, statusLineEl, outputPre, applyWrap);

  // ---------------------------------------------------------------- Floating selection pill

  let floatPill: HTMLButtonElement | undefined;
  let pendingFloatSelection: AiCapturedContext | undefined;

  const hideFloatPill = () => {
    if (floatPill) {
      floatPill.hidden = true;
    }
    pendingFloatSelection = undefined;
  };

  const updateFloatPill = () => {
    if (!opts.selectionRoot || phaseMachine.state !== 'closed') {
      hideFloatPill();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hideFloatPill();
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 2) {
      hideFloatPill();
      return;
    }
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const elem = container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement;
    if (!elem || !opts.selectionRoot.contains(elem) || elem.closest('textarea, input, .md-editor')) {
      hideFloatPill();
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hideFloatPill();
      return;
    }
    pendingFloatSelection = opts.captureContext();
    if (!floatPill) {
      floatPill = el('button', { class: 'dv-ai-float-pill', title: t('aiOpenTip') });
      floatPill.type = 'button';
      const ic = el('span', { class: 'dv-ai-btn-icon' });
      ic.innerHTML = icons.sparkle;
      floatPill.append(ic, el('span', { text: 'AI' }));
      floatPill.addEventListener('mousedown', (e) => {
        // Prevent clearing the browser text selection before `click` runs!
        e.preventDefault();
        e.stopPropagation();
      });
      floatPill.addEventListener('click', (e) => {
        e.stopPropagation();
        const snap = pendingFloatSelection ?? opts.captureContext();
        hideFloatPill();
        open({ capturedOverride: snap });
      });
      document.body.append(floatPill);
    }
    floatPill.hidden = false;
    const left = Math.max(12, Math.min(window.innerWidth - 88, rect.right - 24));
    const top = Math.max(46, rect.top - 34);
    floatPill.style.left = `${left}px`;
    floatPill.style.top = `${top}px`;
  };

  const onSelectionPointerUp = () => {
    setTimeout(updateFloatPill, 15);
  };
  const onDocMouseDown = (e: MouseEvent) => {
    if (floatPill && !floatPill.hidden && !floatPill.contains(e.target as Node)) {
      hideFloatPill();
    }
  };

  if (opts.selectionRoot) {
    opts.selectionRoot.addEventListener('mouseup', onSelectionPointerUp);
    opts.selectionRoot.addEventListener('keyup', onSelectionPointerUp);
    document.addEventListener('mousedown', onDocMouseDown);
  }

  // ---------------------------------------------------------------- Rendering & State Sync

  function syncProviderPill(): void {
    const { settings } = getAiSettings();
    const provider = settings?.provider ?? 'VS Code';
    const model = settings?.model || activeModelLabel;
    providerPillBtn.textContent = model ? `${provider} · ${model}` : provider;
  }

  function renderChips(): void {
    const visible = quickActions.filter((a) => (a.visible ? a.visible(captured) : true));
    chipsWrap.replaceChildren(
      ...visible.map((act) => {
        const chip = el('button', {
          class: act.kind === lastAction ? 'dv-ai-chip dv-ai-chip-active' : 'dv-ai-chip',
          text: act.label(),
        });
        chip.type = 'button';
        chip.disabled = phaseMachine.state === 'streaming';
        chip.addEventListener('click', () => {
          lastAction = act.kind;
          renderChips();
          updatePlaceholder();
          // Immediate execution for selection-transform actions when selection or context exists;
          // formula & tableFill focus the prompt if empty so the user can describe the logic.
          if (
            (act.kind === 'formula' || act.kind === 'tableFill') &&
            !promptInput.value.trim()
          ) {
            promptInput.focus();
            return;
          }
          runAction(act.kind);
        });
        return chip;
      }),
    );
    chipsWrap.hidden = visible.length === 0;
  }

  function updatePlaceholder(): void {
    if (opts.viewerKind === 'sheet' && lastAction === 'formula') {
      promptInput.placeholder = t('aiFormulaPlaceholder');
    } else {
      promptInput.placeholder = t('aiPromptPlaceholder');
    }
  }

  function renderApplyBar(): void {
    if (phaseMachine.state !== 'done' || !outputText.trim()) {
      applyWrap.hidden = true;
      applyWrap.replaceChildren();
      return;
    }
    const result: AiApplyResult = { text: outputText, action: lastAction, captured };
    const buttons: HTMLElement[] = [];

    for (const spec of applyActions) {
      if (spec.visible && !spec.visible(result)) {
        continue;
      }
      const labelText = typeof spec.label === 'function' ? spec.label() : spec.label;
      const btn = el('button', {
        class: spec.primary ? 'dv-btn dv-ai-primary-btn' : 'dv-btn',
        text: labelText,
      });
      btn.type = 'button';
      btn.addEventListener('click', () => {
        const shouldClose = spec.onApply(result);
        if (shouldClose !== false) {
          close();
        }
      });
      buttons.push(btn);
    }

    const copyBtn = el('button', { class: 'dv-btn', text: t('copy') });
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard?.writeText(outputText);
      copyBtn.textContent = t('copied');
      setTimeout(() => {
        copyBtn.textContent = t('copy');
      }, 1200);
    });
    buttons.push(copyBtn);

    applyWrap.replaceChildren(...buttons);
    applyWrap.hidden = false;
  }

  function syncUi(): void {
    const phase = phaseMachine.state;
    const isOpen = phase !== 'closed';
    card.hidden = !isOpen;
    button.classList.toggle('dv-active', isOpen);
    button.setAttribute('aria-expanded', String(isOpen));
    if (!isOpen) {
      return;
    }

    syncProviderPill();
    contextBadgeEl.textContent =
      captured.badge ??
      (captured.selection
        ? t('aiContextSelection', captured.selection.length)
        : t('aiContextDocument'));
    updatePlaceholder();
    renderChips();

    const streaming = phase === 'streaming';
    sendBtn.hidden = streaming;
    stopBtn.hidden = !streaming;
    promptInput.disabled = streaming;

    if (streaming) {
      statusLineEl.hidden = false;
      statusLineEl.className = 'dv-ai-status';
      statusLineEl.textContent = activeModelLabel ? `${t('aiThinking')} (${activeModelLabel})` : t('aiThinking');
    } else if (phase === 'error' && errorMessage) {
      statusLineEl.hidden = false;
      statusLineEl.className = 'dv-ai-status dv-ai-status-error';
      statusLineEl.textContent = errorMessage;
    } else {
      statusLineEl.hidden = true;
    }

    if (outputText) {
      outputPre.hidden = false;
      outputPre.textContent = outputText;
      outputPre.scrollTop = outputPre.scrollHeight;
    } else {
      outputPre.hidden = true;
      outputPre.textContent = '';
    }

    renderApplyBar();
  }

  phaseMachine.subscribe(() => syncUi());
  const unsubSettings = onAiSettingsChange(() => {
    if (phaseMachine.state !== 'closed') {
      syncProviderPill();
    }
  });

  // ---------------------------------------------------------------- Actions

  function runAction(actionOverride?: AiActionKind): void {
    const action = actionOverride ?? lastAction;
    lastAction = action;
    // Refresh context if user didn't freeze an explicit selection, or keep frozen selection
    const fresh = opts.captureContext();
    if (!captured.selection && fresh.selection) {
      captured = fresh;
    } else if (fresh.sheetSchema) {
      captured = { ...captured, sheetSchema: fresh.sheetSchema, badge: fresh.badge ?? captured.badge, meta: fresh.meta ?? captured.meta };
    }

    const requestId = ++reqCounter;
    activeRequestId = requestId;
    outputText = '';
    errorMessage = '';
    phaseMachine.transition('streaming');

    const payload: AiPromptContext = {
      viewerKind: opts.viewerKind,
      fileName: opts.getFileName?.(),
      action,
      instruction: promptInput.value.trim() || undefined,
      selection: captured.selection,
      surrounding: captured.surrounding,
      sheetSchema: captured.sheetSchema,
    };
    post({ type: 'aiRun', requestId, context: payload });
  }

  function stopStreaming(): void {
    if (phaseMachine.state !== 'streaming') {
      return;
    }
    const id = activeRequestId;
    activeRequestId = 0;
    post({ type: 'aiCancel', requestId: id });
    phaseMachine.transition(outputText.trim() ? 'done' : 'idle');
  }

  function handleEscape(): void {
    if (phaseMachine.state === 'streaming') {
      stopStreaming();
      // Re-push onto overlayStack so a second Escape closes the card cleanly!
      overlayStack.push({
        id: 'aiAssistant',
        isOpen: () => phaseMachine.state !== 'closed',
        close: handleEscape,
        restoreFocus: () => opts.focusReturnTarget?.() ?? button,
      });
      promptInput.focus();
      return;
    }
    close();
  }

  function open(openOpts?: {
    presetAction?: AiActionKind;
    initialPrompt?: string;
    autoRun?: boolean;
    capturedOverride?: AiCapturedContext;
  }): void {
    hideFloatPill();
    if (!card.isConnected) {
      document.body.append(card);
    }
    captured = openOpts?.capturedOverride ?? opts.captureContext();
    if (openOpts?.presetAction) {
      lastAction = openOpts.presetAction;
    } else if (opts.viewerKind === 'sheet') {
      lastAction = captured.sheetSchema?.isJsonl ? 'tableFill' : 'formula';
    } else {
      lastAction = captured.selection ? 'polish' : 'generate';
    }
    if (openOpts?.initialPrompt !== undefined) {
      promptInput.value = openOpts.initialPrompt;
    }
    if (phaseMachine.state === 'closed') {
      phaseMachine.transition(outputText.trim() ? 'done' : 'idle');
    } else {
      syncUi();
    }
    overlayStack.push({
      id: 'aiAssistant',
      isOpen: () => phaseMachine.state !== 'closed',
      close: handleEscape,
      restoreFocus: () => opts.focusReturnTarget?.() ?? button,
    });
    promptInput.focus();
    if (openOpts?.autoRun) {
      runAction(lastAction);
    }
  }

  function close(): void {
    if (phaseMachine.state === 'closed') {
      return;
    }
    if (phaseMachine.state === 'streaming') {
      post({ type: 'aiCancel', requestId: activeRequestId });
      activeRequestId = 0;
    }
    overlayStack.remove('aiAssistant');
    phaseMachine.transition('closed');
  }

  sendBtn.addEventListener('click', () => {
    const typed = promptInput.value.trim();
    if (typed && opts.viewerKind !== 'sheet' && !captured.selection && lastAction === 'polish') {
      lastAction = 'generate';
    }
    runAction(lastAction);
  });

  stopBtn.addEventListener('click', () => stopStreaming());

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (!e.shiftKey && opts.viewerKind === 'sheet' && lastAction === 'formula'))) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  const onWindowKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'i') {
      if (document.querySelector('.dv-present-overlay:not([hidden]), .md-lightbox:not([hidden])')) {
        return;
      }
      e.preventDefault();
      if (phaseMachine.state === 'closed') {
        open();
      } else {
        promptInput.focus();
      }
    }
  };
  window.addEventListener('keydown', onWindowKeyDown);

  onMessage((msg) => {
    if (msg.type === 'aiOpen') {
      open();
      return;
    }
    if (msg.type === 'aiStream' && msg.requestId === activeRequestId) {
      if (msg.model) {
        activeModelLabel = msg.model;
      }
      outputText = msg.text;
      if (!msg.done) {
        syncUi();
        return;
      }
      activeRequestId = 0;
      if (msg.error) {
        errorMessage = msg.error;
        phaseMachine.transition('error');
      } else {
        phaseMachine.transition(outputText.trim() ? 'done' : 'idle');
      }
    }
  });

  function dispose(): void {
    close();
    unsubSettings();
    window.removeEventListener('keydown', onWindowKeyDown);
    if (opts.selectionRoot) {
      opts.selectionRoot.removeEventListener('mouseup', onSelectionPointerUp);
      opts.selectionRoot.removeEventListener('keyup', onSelectionPointerUp);
      document.removeEventListener('mousedown', onDocMouseDown);
    }
    floatPill?.remove();
    card.remove();
  }

  return {
    button,
    phaseMachine,
    open,
    close,
    dispose,
  };
}
