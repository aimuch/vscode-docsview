// Plain-text fallback viewer, used for legacy .doc files.
import '../shared/base.css';
import './text.css';
import { app, el, onMessage, post, showStatus, t } from '../shared/api';
import { customToolbar, noticeBanner } from '../shared/ui';
import { createZoom } from '../shared/zoom';

const notice = noticeBanner(t('docNotice'));
const stage = el('div', { class: 'dv-stage' });
const page = el('div', { class: 'text-page dv-page-invert' });
stage.append(page);

const zoom = createZoom((value) => page.style.setProperty('zoom', String(value)), stage);
app.append(
  customToolbar({
    subtitle: 'DOC',
    slots: [{ id: 'zoom', nodes: zoom.nodes }],
  }).node,
  notice.node,
  stage,
);
showStatus(page, t('loading'));

onMessage((message) => {
  if (message.type === 'text') {
    const paragraphs = message.body.split('\n').map((line) => {
      const p = el('p', { text: line });
      if (!line.trim()) {
        p.classList.add('text-gap');
      }
      return p;
    });
    page.replaceChildren(...paragraphs);
    post({ type: 'status', ok: true, detail: `${paragraphs.length} paragraphs` });
  } else if (message.type === 'error') {
    showStatus(page, message.message, true);
  }
});

post({ type: 'ready' });
