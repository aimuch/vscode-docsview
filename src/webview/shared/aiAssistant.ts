// Shared, format-aware AI Assistant controller & floating workbench card for DocsView webviews.
// Supports multi-turn follow-ups, prompt history (↑/↓), safe Markdown formatting + inline word Diff preview,
// quick model switching, and multimodal image payloads — driven by `StateMachine<AiUiPhase>` + `overlayStack`.
import type { AiActionKind, AiChatTurn, AiPromptContext, AiSheetSchemaContext, ViewerKind } from '../../common/protocol';
import { StateMachine } from '../../common/stateMachine';
import { diffInlineText } from '../../common/textDiff';
import { el, onMessage, post, t } from './api';
import { icons } from './icons';
import { overlayStack } from './overlayStack';
import { readState, writeState } from './sidebar';
import { getAiSettings, iconButton, onAiSettingsChange } from './ui';

export type AiUiPhase = 'closed' | 'idle' | 'streaming' | 'done' | 'error';

export interface AiCapturedContext {
  selection?: string;
  surrounding?: string;
  badge?: string;
  sheetSchema?: AiSheetSchemaContext;
  imageDataUrl?: string;
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
  /** Opens the host Settings Drawer when the user clicks Settings in the model picker. */
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
  if (kind === 'image') {
    return [
      { kind: 'visionOcr', label: () => t('aiActVisionOcr'), visible: (c) => Boolean(c.imageDataUrl) },
      { kind: 'visionTable', label: () => t('aiActVisionTable'), visible: (c) => Boolean(c.imageDataUrl) },
      { kind: 'visionChart', label: () => t('aiActVisionChart'), visible: (c) => Boolean(c.imageDataUrl) },
      { kind: 'visionBbox', label: () => t('aiActVisionBbox'), visible: (c) => Boolean(c.imageDataUrl) },
      { kind: 'explain', label: () => t('aiActExplain') },
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

/** Safe DOM-only Markdown renderer for AI responses (code blocks, headings, lists, inline code & bold). */
function appendInlineFormatted(parent: HTMLElement, text: string): void {
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parent.append(document.createTextNode(text.slice(last, m.index)));
    }
    const token = m[0];
    if (token.startsWith('`')) {
      parent.append(el('code', { class: 'dv-ai-inline-code', text: token.slice(1, -1) }));
    } else {
      parent.append(el('strong', { text: token.slice(2, -2) }));
    }
    last = m.index + token.length;
  }
  if (last < text.length) {
    parent.append(document.createTextNode(text.slice(last)));
  }
}

function renderFormattedOutput(container: HTMLElement, raw: string): void {
  const nodes: HTMLElement[] = [];
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      nodes.push(el('pre', { class: 'dv-ai-code-block' }, [el('code', { text: codeLines.join('\n') })]));
      continue;
    }
    const hMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (hMatch) {
      const h = el('div', { class: 'dv-ai-md-h' });
      appendInlineFormatted(h, hMatch[2]);
      nodes.push(h);
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const ul = el('ul', { class: 'dv-ai-md-list' });
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const li = el('li');
        appendInlineFormatted(li, lines[i].replace(/^\s*[-*+]\s+/, ''));
        ul.append(li);
        i++;
      }
      nodes.push(ul);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = el('ol', { class: 'dv-ai-md-list' });
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = el('li');
        appendInlineFormatted(li, lines[i].replace(/^\s*\d+\.\s+/, ''));
        ol.append(li);
        i++;
      }
      nodes.push(ol);
      continue;
    }
    // GFM Markdown table: header row + separator row `| --- | --- |`
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const splitCells = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = splitCells(line);
      i += 2;
      const tbody = el('tbody');
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = splitCells(lines[i]);
        tbody.append(
          el(
            'tr',
            {},
            headers.map((_, cIdx) => {
              const td = el('td');
              appendInlineFormatted(td, cells[cIdx] ?? '');
              return td;
            }),
          ),
        );
        i++;
      }
      const thead = el('thead', {}, [
        el(
          'tr',
          {},
          headers.map((h) => {
            const th = el('th');
            appendInlineFormatted(th, h);
            return th;
          }),
        ),
      ]);
      nodes.push(el('table', { class: 'dv-ai-md-table' }, [thead, tbody]));
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const p = el('p', { class: 'dv-ai-md-p' });
    appendInlineFormatted(p, line);
    nodes.push(p);
    i++;
  }
  container.replaceChildren(...nodes);
}

function renderDiffOutput(container: HTMLElement, before: string, after: string): void {
  const spans = diffInlineText(before, after);
  const frag = document.createDocumentFragment();
  for (const s of spans) {
    if (s.kind === 'del') {
      frag.append(el('del', { class: 'dv-diff-del', text: s.text }));
    } else if (s.kind === 'add') {
      frag.append(el('ins', { class: 'dv-diff-ins', text: s.text }));
    } else {
      frag.append(document.createTextNode(s.text));
    }
  }
  const wrap = el('div', { class: 'dv-ai-diff-body' });
  wrap.append(frag);
  container.replaceChildren(wrap);
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
  let outputViewMode: 'formatted' | 'diff' = 'formatted';
  let conversation: AiChatTurn[] = [];
  let lastSubmittedPrompt = '';

  const savedHistory = readState().aiPromptHistory;
  const promptHistory: string[] = Array.isArray(savedHistory)
    ? (savedHistory as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20)
    : [];
  let historyCursor = -1;

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
  const turnsBadgeEl = el('span', { class: 'dv-ai-turns-badge' });
  turnsBadgeEl.hidden = true;

  const providerPillBtn = el('button', { class: 'dv-ai-provider-pill', title: t('aiModelLabel') });
  providerPillBtn.type = 'button';
  providerPillBtn.setAttribute('aria-haspopup', 'menu');
  providerPillBtn.setAttribute('aria-expanded', 'false');

  // Quick model switcher popover anchored to providerPillBtn
  const modelMenu = el('div', { class: 'dv-menu dv-more-menu dv-ai-model-menu' });
  modelMenu.setAttribute('role', 'menu');
  modelMenu.hidden = true;
  document.body.append(modelMenu);

  const onModelMenuOutside = (e: MouseEvent) => {
    if (!modelMenu.contains(e.target as Node) && !providerPillBtn.contains(e.target as Node)) {
      closeModelMenu();
    }
  };
  const closeModelMenu = () => {
    if (!modelMenu.hidden) {
      modelMenu.hidden = true;
      providerPillBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onModelMenuOutside);
      overlayStack.remove('aiModelMenu');
    }
  };
  modelMenu.addEventListener('keydown', (e) => {
    const items = [...modelMenu.querySelectorAll<HTMLElement>('.dv-menu-item')];
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  });
  providerPillBtn.addEventListener('click', () => {
    if (!modelMenu.hidden) {
      closeModelMenu();
      return;
    }
    const { settings, models } = getAiSettings();
    if (models.length === 0) {
      post({ type: 'aiGetSettings', discoverModels: true });
    }
    const rows: HTMLElement[] = [];
    if (models.length > 0) {
      for (const m of models.slice(0, 20)) {
        const row = el('button', { class: 'dv-menu-item' });
        row.type = 'button';
        row.setAttribute('role', 'menuitemradio');
        const mark = el('span', { class: 'dv-menu-check' });
        if (settings?.model === m) {
          mark.innerHTML = icons.check;
        }
        row.append(mark, el('span', { class: 'dv-menu-label', text: m }));
        row.addEventListener('click', () => {
          closeModelMenu();
          post({ type: 'aiUpdateSettings', model: m });
        });
        rows.push(row);
      }
      rows.push(el('div', { class: 'dv-menu-sep' }));
    }
    const refreshRow = el('button', { class: 'dv-menu-item' });
    refreshRow.type = 'button';
    refreshRow.setAttribute('role', 'menuitem');
    refreshRow.append(el('span', { class: 'dv-menu-check' }), el('span', { class: 'dv-menu-label', text: t('aiDiscoverModels') }));
    refreshRow.addEventListener('click', () => {
      closeModelMenu();
      post({ type: 'aiGetSettings', discoverModels: true });
    });
    const settingsRow = el('button', { class: 'dv-menu-item' });
    settingsRow.type = 'button';
    settingsRow.setAttribute('role', 'menuitem');
    settingsRow.append(el('span', { class: 'dv-menu-check' }), el('span', { class: 'dv-menu-label', text: t('settings') }));
    settingsRow.addEventListener('click', () => {
      closeModelMenu();
      opts.onOpenSettings?.();
    });
    rows.push(refreshRow, settingsRow);
    modelMenu.replaceChildren(...rows);
    modelMenu.hidden = false;
    providerPillBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onModelMenuOutside);
    overlayStack.push({
      id: 'aiModelMenu',
      isOpen: () => !modelMenu.hidden,
      close: closeModelMenu,
      restoreFocus: () => providerPillBtn,
    });
    const r = providerPillBtn.getBoundingClientRect();
    const mh = modelMenu.offsetHeight || 220;
    modelMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - 230, r.right - 220))}px`;
    modelMenu.style.top = `${Math.max(8, Math.min(window.innerHeight - mh - 8, r.bottom + 4))}px`;
    modelMenu.style.right = 'auto';
    modelMenu.querySelector<HTMLElement>('.dv-menu-item')?.focus();
  });

  const newChatBtn = el('button', { class: 'dv-btn dv-ai-mini-btn', text: t('aiNewChat') });
  newChatBtn.type = 'button';
  newChatBtn.hidden = true;
  newChatBtn.addEventListener('click', () => {
    conversation = [];
    outputText = '';
    errorMessage = '';
    outputViewMode = 'formatted';
    phaseMachine.transition('idle');
    syncUi();
    promptInput.focus();
  });

  const closeCardBtn = iconButton('close', t('close'), () => close());
  closeCardBtn.classList.add('dv-ai-close-btn');

  const headerEl = el('div', { class: 'dv-ai-header' }, [
    titleIcon,
    el('span', { class: 'dv-ai-title', text: t('aiAssistant') }),
    contextBadgeEl,
    turnsBadgeEl,
    el('span', { class: 'dv-spacer' }),
    newChatBtn,
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
    el('span', { class: 'dv-ai-shortcut-hint', text: 'Ctrl/Cmd+Enter · ↑/↓' }),
    el('span', { class: 'dv-spacer' }),
    stopBtn,
    sendBtn,
  ]);

  const statusLineEl = el('div', { class: 'dv-ai-status' });
  statusLineEl.hidden = true;

  const viewFormattedBtn = el('button', { class: 'dv-ai-view-tab dv-active', text: t('aiViewFormatted') });
  viewFormattedBtn.type = 'button';
  const viewDiffBtn = el('button', { class: 'dv-ai-view-tab', text: t('aiViewDiff') });
  viewDiffBtn.type = 'button';
  viewFormattedBtn.addEventListener('click', () => {
    outputViewMode = 'formatted';
    syncUi();
  });
  viewDiffBtn.addEventListener('click', () => {
    outputViewMode = 'diff';
    syncUi();
  });
  const outputViewBar = el('div', { class: 'dv-ai-view-bar' }, [viewFormattedBtn, viewDiffBtn]);
  outputViewBar.hidden = true;

  const outputPre = el('div', { class: 'dv-ai-output' });
  outputPre.hidden = true;

  const applyWrap = el('div', { class: 'dv-ai-apply-bar' });
  applyWrap.hidden = true;

  card.append(headerEl, chipsWrap, promptInput, inputFooter, statusLineEl, outputViewBar, outputPre, applyWrap);

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
    providerPillBtn.textContent = model ? `${provider} · ${model} ▾` : `${provider} ▾`;
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
          if ((act.kind === 'formula' || act.kind === 'tableFill') && !promptInput.value.trim()) {
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
    if (conversation.length >= 2) {
      promptInput.placeholder = t('aiFollowUpPlaceholder');
    } else if (opts.viewerKind === 'sheet' && lastAction === 'formula') {
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
      closeModelMenu();
      return;
    }

    syncProviderPill();
    contextBadgeEl.textContent =
      captured.badge ??
      (captured.selection ? t('aiContextSelection', captured.selection.length) : t('aiContextDocument'));

    const turnCount = Math.floor(conversation.length / 2);
    turnsBadgeEl.hidden = turnCount < 1;
    turnsBadgeEl.textContent = t('aiTurnsBadge', turnCount);
    newChatBtn.hidden = conversation.length === 0 && !outputText;

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
      const retryBtn = el('button', { class: 'dv-btn dv-ai-mini-btn', text: t('aiRetry') });
      retryBtn.type = 'button';
      retryBtn.addEventListener('click', () => runAction(lastAction));
      const cfgBtn = el('button', { class: 'dv-btn dv-ai-mini-btn', text: t('settings') });
      cfgBtn.type = 'button';
      cfgBtn.addEventListener('click', () => opts.onOpenSettings?.());
      statusLineEl.replaceChildren(el('span', { text: errorMessage }), retryBtn, cfgBtn);
    } else {
      statusLineEl.hidden = true;
    }

    const DIFFABLE_ACTIONS = new Set<AiActionKind>(['polish', 'concise', 'expand', 'translate', 'fix', 'generate']);
    const canDiff = Boolean(
      captured.selection &&
        captured.selection.trim() &&
        outputText.trim() &&
        !streaming &&
        DIFFABLE_ACTIONS.has(lastAction),
    );
    outputViewBar.hidden = !canDiff;
    if (!canDiff && outputViewMode === 'diff') {
      outputViewMode = 'formatted';
    }
    viewFormattedBtn.classList.toggle('dv-active', outputViewMode === 'formatted');
    viewDiffBtn.classList.toggle('dv-active', outputViewMode === 'diff');
    viewFormattedBtn.setAttribute('aria-pressed', String(outputViewMode === 'formatted'));
    viewDiffBtn.setAttribute('aria-pressed', String(outputViewMode === 'diff'));

    // Show prior multi-turn thread + latest output cleanly
    const priorTurns = conversation.length >= 2 && outputText ? conversation.slice(0, -2) : conversation;
    if (outputText || priorTurns.length > 0) {
      outputPre.hidden = false;
      const bodyWrap = el('div');
      if (priorTurns.length > 0) {
        const threadEl = el('div', { class: 'dv-ai-thread' });
        for (const turn of priorTurns.slice(-6)) {
          threadEl.append(
            el('div', {
              class: turn.role === 'user' ? 'dv-ai-turn-user' : 'dv-ai-turn-asst',
              text: turn.content,
            }),
          );
        }
        bodyWrap.append(threadEl);
      }
      if (outputText) {
        const latestBox = el('div');
        if (streaming) {
          latestBox.textContent = outputText;
        } else if (outputViewMode === 'diff' && captured.selection) {
          renderDiffOutput(latestBox, captured.selection, outputText);
        } else {
          renderFormattedOutput(latestBox, outputText);
        }
        bodyWrap.append(latestBox);
      }
      outputPre.replaceChildren(bodyWrap);
      outputPre.scrollTop = outputPre.scrollHeight;
    } else {
      outputPre.hidden = true;
      outputPre.replaceChildren();
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

  function recordPromptHistory(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const idx = promptHistory.indexOf(trimmed);
    if (idx >= 0) promptHistory.splice(idx, 1);
    promptHistory.unshift(trimmed);
    if (promptHistory.length > 20) promptHistory.length = 20;
    historyCursor = -1;
    writeState({ aiPromptHistory: promptHistory });
  }

  let hasExplicitOverride = false;
  let draftBeforeHistory = '';

  function runAction(actionOverride?: AiActionKind): void {
    const action = actionOverride ?? lastAction;
    lastAction = action;
    if (!hasExplicitOverride) {
      const fresh = opts.captureContext();
      if (!captured.selection && fresh.selection) {
        captured = fresh;
      } else {
        captured = {
          ...captured,
          sheetSchema: fresh.sheetSchema ?? captured.sheetSchema,
          imageDataUrl: fresh.imageDataUrl ?? captured.imageDataUrl,
          badge: fresh.badge ?? captured.badge,
          meta: fresh.meta ?? captured.meta,
        };
      }
    }
    hasExplicitOverride = false;

    const typed = promptInput.value.trim();
    if (typed) {
      recordPromptHistory(typed);
    }
    lastSubmittedPrompt = typed || `[${action}]`;

    const requestId = ++reqCounter;
    activeRequestId = requestId;
    outputText = '';
    errorMessage = '';
    phaseMachine.transition('streaming');

    const payload: AiPromptContext = {
      viewerKind: opts.viewerKind,
      fileName: opts.getFileName?.(),
      action,
      instruction: typed || undefined,
      selection: captured.selection,
      surrounding: captured.surrounding,
      sheetSchema: captured.sheetSchema,
      imageDataUrl: captured.imageDataUrl,
      history: conversation.length > 0 ? conversation : undefined,
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
    hasExplicitOverride = Boolean(openOpts?.capturedOverride);
    const nextCap = openOpts?.capturedOverride ?? opts.captureContext();
    if (
      nextCap.selection !== captured.selection ||
      nextCap.badge !== captured.badge ||
      nextCap.imageDataUrl !== captured.imageDataUrl
    ) {
      conversation = [];
      outputText = '';
      errorMessage = '';
      activeModelLabel = '';
      outputViewMode = 'formatted';
    }
    captured = nextCap;
    if (openOpts?.presetAction) {
      lastAction = openOpts.presetAction;
    } else if (opts.viewerKind === 'sheet') {
      lastAction = captured.sheetSchema?.isJsonl ? 'tableFill' : 'formula';
    } else if (opts.viewerKind === 'image' && captured.imageDataUrl) {
      lastAction = 'visionOcr';
    } else {
      lastAction = captured.selection ? 'polish' : 'generate';
    }
    if (openOpts?.initialPrompt !== undefined) {
      promptInput.value = openOpts.initialPrompt;
    }
    if (phaseMachine.state === 'closed') {
      phaseMachine.transition(outputText.trim() ? 'done' : 'idle');
    } else if (!outputText.trim() && phaseMachine.state !== 'idle') {
      phaseMachine.transition('idle');
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
    closeModelMenu();
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
      return;
    }
    if (e.key === 'ArrowUp' && promptHistory.length > 0 && promptInput.selectionStart === 0 && promptInput.selectionEnd === 0) {
      e.preventDefault();
      if (historyCursor === -1) {
        draftBeforeHistory = promptInput.value;
      }
      historyCursor = Math.min(promptHistory.length - 1, historyCursor + 1);
      promptInput.value = promptHistory[historyCursor] ?? '';
      promptInput.setSelectionRange(0, 0);
      return;
    }
    if (
      e.key === 'ArrowDown' &&
      historyCursor >= 0 &&
      promptInput.selectionStart === promptInput.value.length &&
      promptInput.selectionEnd === promptInput.value.length
    ) {
      e.preventDefault();
      historyCursor--;
      promptInput.value = historyCursor >= 0 ? promptHistory[historyCursor] : draftBeforeHistory;
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
        if (outputText.trim()) {
          conversation.push(
            { role: 'user', content: lastSubmittedPrompt },
            { role: 'assistant', content: outputText },
          );
          if (conversation.length > 16) {
            conversation = conversation.slice(-16);
          }
          promptInput.value = '';
        }
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
    modelMenu.remove();
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
