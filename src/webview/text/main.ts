// Plain-text fallback viewer, used for legacy .doc files (with full-text search & status bar).
import '../shared/base.css';
import './text.css';
import { app, el, onMessage, post, showStatus, t } from '../shared/api';
import { createFindWidget, PreviewFind } from '../shared/find';
import { customToolbar, noticeBanner, openExternalButton, openExternalMenuItem } from '../shared/ui';
import { createZoom } from '../shared/zoom';

const notice = noticeBanner(t('docNotice'));
const stage = el('div', { class: 'dv-stage' });
stage.tabIndex = -1;
const page = el('div', { class: 'text-page dv-page-invert' });
stage.append(page);

const docFind = new PreviewFind(page, stage);
const findWidget = createFindWidget(docFind, stage);
const zoom = createZoom((value) => page.style.setProperty('zoom', String(value)), stage);

const statusText = el('span', { class: 'dv-label' });
const statusBar = el('div', { class: 'text-statusbar' }, [el('div', { class: 'dv-spacer' }), statusText]);

app.append(
  customToolbar({
    subtitle: 'DOC',
    slots: [
      { id: 'zoom', nodes: zoom.nodes },
      { id: 'find', nodes: findWidget.nodes },
      { id: 'openApp', nodes: [openExternalButton()] },
    ],
    documentActions: [openExternalMenuItem()],
  }).node,
  notice.node,
  stage,
  statusBar,
);
showStatus(page, t('loading'));

onMessage((message) => {
  if (message.type === 'text') {
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
    const cjk = (message.body.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
    const latin = (message.body.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9_'-]+/g) ?? []).length;
    const words = cjk + latin;
    statusText.textContent = `${message.name ? `${message.name} · ` : ''}${t('docParagraphs', nonEmptyCount)} · ${t('mdWords', words.toLocaleString())}`;

    post({ type: 'status', ok: true, detail: `${paragraphs.length} paragraphs` });
  } else if (message.type === 'error') {
    showStatus(page, message.message, true);
  }
});

post({ type: 'ready' });
