// Plain-text fallback viewer, used for legacy .doc files (with full-text search, AI Assistant & status bar).
import { countDocumentWords } from '../../common/textStats';
import '../shared/base.css';
import './text.css';
import { createAiAssistant } from '../shared/aiAssistant';
import { app, el, onMessage, post, showStatus, t } from '../shared/api';
import { createFindWidget, PreviewFind } from '../shared/find';
import { overlayStack } from '../shared/overlayStack';
import { customToolbar, iconButton, noticeBanner, openExternalButton, openExternalMenuItem } from '../shared/ui';
import { createZoom } from '../shared/zoom';

const notice = noticeBanner(t('docNotice'));
const stage = el('div', { class: 'dv-stage' });
stage.tabIndex = -1;
const page = el('div', { class: 'text-page dv-page-invert' });
stage.append(page);

const docFind = new PreviewFind(page, stage);
const findWidget = createFindWidget(docFind, stage);
const zoom = createZoom((value) => page.style.setProperty('zoom', String(value)), stage);

let currentBody = '';
let currentDocName = 'Document.doc';
const exportMdBtn = iconButton('export', t('exportMarkdown'), () => {
  if (currentBody) {
    post({ type: 'saveTextExport', ext: 'md', content: currentBody });
  }
});

let openTextDrawerFn: (() => void) | undefined;

const ai = createAiAssistant({
  viewerKind: 'text',
  getFileName: () => currentDocName,
  selectionRoot: page,
  onOpenSettings: () => openTextDrawerFn?.(),
  focusReturnTarget: () => stage,
  captureContext: () => {
    const sel = window.getSelection()?.toString().trim() ?? '';
    if (sel) {
      return {
        selection: sel,
        surrounding: currentBody.slice(0, 12_000),
        badge: t('aiContextSelection', sel.length),
      };
    }
    return {
      surrounding: currentBody.slice(0, 12_000),
      badge: t('aiContextDocument'),
    };
  },
});

const statusText = el('span', { class: 'dv-label' });
const statusBar = el('div', { class: 'dv-statusbar' }, [el('div', { class: 'dv-spacer' }), statusText]);

const topBar = customToolbar({
  subtitle: 'DOC',
  slots: [
    { id: 'zoom', nodes: zoom.nodes },
    { id: 'find', nodes: findWidget.nodes },
    { id: 'ai', nodes: [ai.button] },
    { id: 'actions', nodes: [exportMdBtn] },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    { id: 'ai', slotId: 'ai', label: t('aiAssistant'), icon: 'sparkle', onClick: () => ai.open() },
    openExternalMenuItem(),
    {
      id: 'exportMd',
      slotId: 'actions',
      label: t('exportMarkdown'),
      icon: 'export',
      onClick: () => {
        if (currentBody) {
          post({ type: 'saveTextExport', ext: 'md', content: currentBody });
        }
      },
    },
  ],
});
openTextDrawerFn = () => topBar.openDrawer();

app.append(topBar.node, notice.node, stage, statusBar);
showStatus(page, t('loading'));

onMessage((message) => {
  if (message.type === 'text') {
    currentBody = message.body;
    if (message.name) {
      currentDocName = message.name;
    }
    const lines = message.body.split('\n');
    const paragraphs = lines.map((line) => {
      const p = el('p', { text: line });
      if (!line.trim()) {
        p.classList.add('text-gap');
      }
      return p;
    });
    page.replaceChildren(...paragraphs);
    docFind.refresh();
    findWidget.refreshCount();

    const nonEmptyCount = lines.filter((l) => l.trim().length > 0).length;
    const words = countDocumentWords(message.body);
    statusText.textContent = `${message.name ? `${message.name} · ` : ''}${t('docParagraphs', nonEmptyCount)} · ${t('mdWords', words.toLocaleString())}`;

    post({
      type: 'status',
      ok: true,
      detail: `${paragraphs.length} paragraphs`,
      mode: 'read',
      overlays: overlayStack.getOpenIds(),
    });
  } else if (message.type === 'error') {
    showStatus(page, message.message, true);
  }
});

post({ type: 'ready' });
