// Audio & Video Media Player webview: speed control, loop, Web Audio spectrum visualiser,
// keyboard shortcuts, timestamped bookmarks, and video frame capture to Image Inspector.
import '../shared/base.css';
import './media.css';
import { app, el, onMessage, post, showStatus, t } from '../shared/api';
import { getFileState } from '../shared/fileState';
import { readState, writeState } from '../shared/sidebar';
import { customToolbar, iconButton, noticeBanner, openExternalButton, openExternalMenuItem, toggleButton } from '../shared/ui';

interface MediaBookmark {
  time: number;
  label: string;
}

let mediaEl: HTMLMediaElement | undefined;
let mediaKind: 'audio' | 'video' = 'audio';
let fileName = 'Media';
let bookmarks: MediaBookmark[] = Array.isArray(readState().mediaBookmarks)
  ? (readState().mediaBookmarks as MediaBookmark[])
  : [];

const notice = noticeBanner();
const stage = el('div', { class: 'media-stage' });
const playerWrap = el('div', { class: 'media-player-wrap' });
const bookmarkPanel = el('aside', { class: 'media-bookmarks' });
const bookmarkList = el('div', { class: 'media-bm-list' });
const metaLabel = el('span', { class: 'dv-label' });
const statusBar = el('div', { class: 'dv-statusbar' }, [el('div', { class: 'dv-spacer' }), metaLabel]);

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function saveBookmarks() {
  writeState({ mediaBookmarks: bookmarks });
  renderBookmarks();
}

function renderBookmarks() {
  if (!bookmarks.length) {
    bookmarkList.replaceChildren(el('div', { class: 'media-bm-empty', text: t('mediaNoBookmarks') }));
    return;
  }
  const sorted = [...bookmarks].sort((a, b) => a.time - b.time);
  bookmarkList.replaceChildren(
    ...sorted.map((bm) => {
      const jumpBtn = el('button', { class: 'media-bm-jump', text: `${fmtTime(bm.time)}  ${bm.label}` });
      jumpBtn.type = 'button';
      jumpBtn.addEventListener('click', () => {
        if (mediaEl) {
          mediaEl.currentTime = bm.time;
          void mediaEl.play().catch(() => undefined);
        }
      });
      const delBtn = iconButton('close', t('deleteComment'), () => {
        bookmarks = bookmarks.filter((item) => item !== bm);
        saveBookmarks();
      });
      return el('div', { class: 'media-bm-item' }, [jumpBtn, delBtn]);
    }),
  );
}

function addBookmark() {
  if (!mediaEl) return;
  const time = mediaEl.currentTime || 0;
  bookmarks.push({ time, label: `Note #${bookmarks.length + 1}` });
  saveBookmarks();
  notice.flash(`${t('mediaAddBookmark')}: ${fmtTime(time)}`, 1800);
}

function exportBookmarksMarkdown() {
  if (!bookmarks.length) return;
  const sorted = [...bookmarks].sort((a, b) => a.time - b.time);
  const lines = [
    `# ${fileName} — Bookmarks`,
    '',
    ...sorted.map((b) => `- **${fmtTime(b.time)}** — ${b.label}`),
    '',
  ];
  post({ type: 'saveTextExport', ext: 'md', suffix: '-bookmarks', content: lines.join('\n') });
}

function captureVideoFrame() {
  if (!(mediaEl instanceof HTMLVideoElement) || !mediaEl.videoWidth || !mediaEl.videoHeight) {
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = mediaEl.videoWidth;
  canvas.height = mediaEl.videoHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(mediaEl, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) return;
    void blob.arrayBuffer().then((ab) => {
      const stem = fileName.replace(/\.[^.]+$/, '');
      const stamp = fmtTime(mediaEl?.currentTime || 0).replace(/:/g, '-');
      post({
        type: 'openCapturedImage',
        suffix: `${stem}-${stamp}`,
        bytes: new Uint8Array(ab),
      });
    });
  }, 'image/png');
}

const speedSelect = el('select', { class: 'dv-input media-speed', title: t('mediaSpeed') }, [
  ...['0.5', '0.75', '1', '1.25', '1.5', '2'].map((v) => {
    const opt = el('option', { text: `${v}×` }) as HTMLOptionElement;
    opt.value = v;
    if (v === '1') opt.selected = true;
    return opt;
  }),
]) as HTMLSelectElement;
speedSelect.addEventListener('change', () => {
  if (mediaEl) {
    mediaEl.playbackRate = Number(speedSelect.value) || 1;
  }
});

const loopToggle = toggleButton('rotateCW', t('mediaLoop'), (on) => {
  if (mediaEl) mediaEl.loop = on;
});

const bookmarkBtn = iconButton('bookmark', t('mediaAddBookmark'), addBookmark);
const captureBtn = iconButton('camera', t('mediaCaptureFrame'), captureVideoFrame);
captureBtn.hidden = true;
const exportBmBtn = iconButton('export', t('exportMarkdown'), exportBookmarksMarkdown);

const topBar = customToolbar({
  subtitle: () => (getFileState().ext ? getFileState().ext.toUpperCase() : 'MEDIA'),
  slots: [
    { id: 'view', nodes: [speedSelect, loopToggle.node] },
    { id: 'actions', nodes: [exportBmBtn] },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    { id: 'bookmark', label: t('mediaAddBookmark'), icon: 'bookmark', toolbarNode: bookmarkBtn, onClick: addBookmark },
    {
      id: 'captureFrame',
      label: t('mediaCaptureFrame'),
      icon: 'camera',
      toolbarNode: captureBtn,
      visible: () => mediaKind === 'video',
      onClick: captureVideoFrame,
    },
    { id: 'exportMd', slotId: 'actions', label: t('exportMarkdown'), icon: 'export', onClick: exportBookmarksMarkdown },
    openExternalMenuItem(),
  ],
});

bookmarkPanel.append(
  el('div', { class: 'media-bm-head' }, [
    el('span', { class: 'media-bm-title', text: t('mediaBookmarks') }),
    iconButton('plus', t('mediaAddBookmark'), addBookmark),
  ]),
  bookmarkList,
);
renderBookmarks();

stage.append(playerWrap, bookmarkPanel);
app.append(topBar.node, notice.node, stage, statusBar);
showStatus(playerWrap, t('loading'));

let rafId = 0;
function startAudioVisualizer(audio: HTMLAudioElement, canvas: HTMLCanvasElement) {
  let ctxAudio: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  const ctx2d = canvas.getContext('2d')!;

  const ensureGraph = () => {
    if (ctxAudio) {
      if (ctxAudio.state === 'suspended') void ctxAudio.resume();
      return;
    }
    try {
      ctxAudio = new AudioContext();
      const src = ctxAudio.createMediaElementSource(audio);
      analyser = ctxAudio.createAnalyser();
      analyser.fftSize = 128;
      src.connect(analyser);
      analyser.connect(ctxAudio.destination);
    } catch {
      // Ignore if AudioContext unavailable
    }
  };

  const draw = () => {
    rafId = requestAnimationFrame(draw);
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    if (!analyser) return;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    const barW = w / bins.length;
    for (let i = 0; i < bins.length; i++) {
      const mag = bins[i] / 255;
      const bh = Math.max(2, mag * (h - 12));
      ctx2d.fillStyle = `hsla(${205 + i * 2}, 78%, 56%, 0.85)`;
      ctx2d.fillRect(i * barW + 1, h - bh, Math.max(2, barW - 2), bh);
    }
  };

  audio.addEventListener('play', () => {
    ensureGraph();
    if (!rafId) draw();
  });
  audio.addEventListener('pause', () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  });
}

window.addEventListener('keydown', (e) => {
  if (!mediaEl) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (mediaEl.paused) void mediaEl.play().catch(() => undefined);
    else mediaEl.pause();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    mediaEl.currentTime = Math.min(mediaEl.duration || Infinity, mediaEl.currentTime + 5);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    mediaEl.currentTime = Math.max(0, mediaEl.currentTime - 5);
  } else if (e.key.toLowerCase() === 'm') {
    mediaEl.muted = !mediaEl.muted;
  } else if (e.key.toLowerCase() === 'b') {
    addBookmark();
  }
});

onMessage((message) => {
  if (message.type === 'media') {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    fileName = message.name;
    mediaKind = message.mediaKind;
    captureBtn.hidden = mediaKind !== 'video';

    if (mediaKind === 'video') {
      const video = document.createElement('video');
      video.className = 'media-video';
      video.controls = true;
      video.preload = 'metadata';
      video.crossOrigin = 'anonymous';
      video.src = message.src;
      video.addEventListener('loadedmetadata', () => {
        metaLabel.textContent = `${video.videoWidth}×${video.videoHeight} · ${fmtTime(video.duration)} · ${fmtSize(message.byteLength)}`;
        post({ type: 'status', ok: true, detail: `${video.videoWidth}x${video.videoHeight}` });
      });
      mediaEl = video;
      playerWrap.replaceChildren(video);
    } else {
      const canvas = document.createElement('canvas');
      canvas.className = 'media-visualizer';
      canvas.width = 560;
      canvas.height = 140;
      const audio = document.createElement('audio');
      audio.className = 'media-audio';
      audio.controls = true;
      audio.preload = 'metadata';
      audio.crossOrigin = 'anonymous';
      audio.src = message.src;
      audio.addEventListener('loadedmetadata', () => {
        metaLabel.textContent = `${fmtTime(audio.duration)} · ${fmtSize(message.byteLength)}`;
        post({ type: 'status', ok: true, detail: fmtTime(audio.duration) });
      });
      startAudioVisualizer(audio, canvas);
      mediaEl = audio;
      playerWrap.replaceChildren(
        el('div', { class: 'media-audio-card' }, [
          el('div', { class: 'media-audio-title', text: fileName }),
          canvas,
          audio,
        ]),
      );
    }
    topBar.refresh();
  } else if (message.type === 'error') {
    showStatus(playerWrap, message.message, true);
    post({ type: 'status', ok: false, detail: message.message });
  }
});

post({ type: 'ready' });
