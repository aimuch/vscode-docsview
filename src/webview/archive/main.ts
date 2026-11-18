// Archive (`.zip` / `.tar` / `.tar.gz` / `.tgz`) explorer & inline file previewer.
import '../shared/base.css';
import './archive.css';
import type { ArchiveEntryInfo } from '../../common/protocol';
import { app, el, onMessage, post, showStatus, t, toArrayBuffer } from '../shared/api';
import { icons } from '../shared/icons';
import { Outline, Sidebar, type OutlineItem } from '../shared/sidebar';
import { customToolbar, iconButton, openExternalButton, openExternalMenuItem } from '../shared/ui';

let archiveName = '';
let allEntries: ArchiveEntryInfo[] = [];
let currentFolder = '';
let sortCol: 'name' | 'size' | 'compressed' | 'ratio' = 'name';
let sortDir: 1 | -1 = 1;
let searchQuery = '';
let activePath = '';
let previewBlobUrl: string | undefined;

const sidebar = new Sidebar(t('nav'), undefined, { defaultOpen: true });
const folderTree = new Outline((key) => {
  currentFolder = key === '__ALL__' ? '' : key;
  renderTable();
});
sidebar.panel().append(folderTree.node);

const filterInput = el('input');
filterInput.type = 'search';
filterInput.placeholder = t('find');
filterInput.addEventListener('input', () => {
  searchQuery = filterInput.value.trim().toLowerCase();
  renderTable();
});
const searchIcon = el('span', { class: 'dv-find-icon' });
searchIcon.innerHTML = icons.search;
const filterBox = el('label', { class: 'dv-search dv-find-box' }, [searchIcon, filterInput]);

const topBar = customToolbar({
  subtitle: () => (archiveName ? archiveName : 'ARCHIVE'),
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'find', nodes: [filterBox] },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [openExternalMenuItem()],
});

const tableWrap = el('div', { class: 'arc-table-wrap' });
const previewPane = el('div', { class: 'arc-preview' });
previewPane.hidden = true;
const previewTitle = el('span', { class: 'arc-preview-title' });
const extractBtn = el('button', { class: 'dv-btn dv-cm-primary', text: t('archiveExtractOpen') });
extractBtn.type = 'button';
extractBtn.addEventListener('click', () => {
  if (activePath) {
    post({ type: 'extractArchiveEntry', path: activePath });
  }
});
const closePreviewBtn = iconButton('close', t('close'), () => {
  previewPane.hidden = true;
  activePath = '';
  renderTable();
});
const previewBody = el('div', { class: 'arc-preview-body' });
previewPane.append(
  el('div', { class: 'arc-preview-head' }, [previewTitle, el('div', { class: 'dv-spacer' }), extractBtn, closePreviewBtn]),
  previewBody,
);

const statusText = el('span', { class: 'dv-label' });
const statusBar = el('div', { class: 'arc-statusbar' }, [el('div', { class: 'dv-spacer' }), statusText]);

const splitMain = el('div', { class: 'arc-workspace' }, [tableWrap, previewPane]);
app.append(
  topBar.node,
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [sidebar.expandBtn, splitMain])]),
  statusBar,
);
showStatus(tableWrap, t('loading'));

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function savedPct(size: number, comp: number): number {
  if (size <= 0 || comp >= size) return 0;
  return Math.round(((size - comp) / size) * 100);
}

function buildFolderOutline() {
  const dirs = new Set<string>();
  for (const e of allEntries) {
    if (e.isDir) {
      dirs.add(e.path);
    } else {
      const parts = e.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }
  }
  const sortedDirs = [...dirs].sort((a, b) => a.localeCompare(b));
  const items: OutlineItem[] = [
    { level: 1, text: `${archiveName || '/'} (${allEntries.filter((e) => !e.isDir).length})`, key: '__ALL__' },
    ...sortedDirs.map((d) => {
      const segs = d.split('/');
      return {
        level: Math.min(6, segs.length + 1),
        text: segs[segs.length - 1],
        key: d,
      };
    }),
  ];
  folderTree.setItems(items);
  folderTree.setActive('__ALL__');
}

function renderTable() {
  const files = allEntries.filter((e) => {
    if (e.isDir) return false;
    if (currentFolder && e.path !== currentFolder && !e.path.startsWith(`${currentFolder}/`)) {
      return false;
    }
    if (searchQuery && !e.path.toLowerCase().includes(searchQuery)) {
      return false;
    }
    return true;
  });

  files.sort((a, b) => {
    let cmp = 0;
    if (sortCol === 'name') cmp = a.path.localeCompare(b.path, undefined, { numeric: true });
    else if (sortCol === 'size') cmp = a.size - b.size;
    else if (sortCol === 'compressed') cmp = a.compressedSize - b.compressedSize;
    else cmp = savedPct(a.size, a.compressedSize) - savedPct(b.size, b.compressedSize);
    return cmp * sortDir;
  });

  const th = (col: typeof sortCol, label: string, num = false) => {
    const arrow = sortCol === col ? (sortDir === 1 ? ' ↑' : ' ↓') : '';
    const cell = el('th', { class: num ? 'arc-num' : '', text: `${label}${arrow}` });
    cell.addEventListener('click', () => {
      if (sortCol === col) sortDir = sortDir === 1 ? -1 : 1;
      else {
        sortCol = col;
        sortDir = col === 'name' ? 1 : -1;
      }
      renderTable();
    });
    return cell;
  };

  const thead = el('thead', {}, [
    el('tr', {}, [
      th('name', t('archiveName')),
      th('size', t('archiveSize'), true),
      th('compressed', t('archiveCompressed'), true),
      th('ratio', t('archiveRatio'), true),
    ]),
  ]);

  const tbody = el(
    'tbody',
    {},
    files.slice(0, 2000).map((f) => {
      const pct = savedPct(f.size, f.compressedSize);
      const ic = el('span', { class: 'arc-file-ic' });
      ic.innerHTML = icons.file;
      const tr = el('tr', { class: f.path === activePath ? 'arc-row-active' : '' }, [
        el('td', { class: 'arc-path-cell', title: f.path }, [ic, el('span', { text: f.path })]),
        el('td', { class: 'arc-num', text: fmtBytes(f.size) }),
        el('td', { class: 'arc-num', text: fmtBytes(f.compressedSize) }),
        el('td', { class: 'arc-num', text: pct > 0 ? `-${pct}%` : '0%' }),
      ]);
      tr.addEventListener('click', () => {
        activePath = f.path;
        previewTitle.textContent = f.path;
        previewPane.hidden = false;
        showStatus(previewBody, t('loading'));
        renderTable();
        post({ type: 'previewArchiveEntry', path: f.path });
      });
      tr.addEventListener('dblclick', () => {
        post({ type: 'extractArchiveEntry', path: f.path });
      });
      return tr;
    }),
  );

  tableWrap.replaceChildren(el('table', { class: 'arc-table' }, [thead, tbody]));
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    filterInput.focus();
    filterInput.select();
  }
});

onMessage((message) => {
  if (message.type === 'archive') {
    archiveName = message.name;
    allEntries = message.entries;
    topBar.refresh();
    buildFolderOutline();
    renderTable();
    const fileCount = allEntries.filter((e) => !e.isDir).length;
    const pct = savedPct(message.totalSize, message.compressedTotal);
    statusText.textContent = t(
      'archiveFiles',
      fileCount.toLocaleString(),
      fmtBytes(message.totalSize),
      fmtBytes(message.compressedTotal),
      pct,
    );
    post({ type: 'status', ok: true, detail: `${fileCount} entries` });
  } else if (message.type === 'archiveEntry' && message.path === activePath) {
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
      previewBlobUrl = undefined;
    }
    if (message.kind === 'text') {
      previewBody.replaceChildren(el('pre', { class: 'arc-code', text: message.text ?? '' }));
    } else if (message.kind === 'image' && message.bytes) {
      const blob = new Blob([toArrayBuffer(message.bytes)], { type: message.mime ?? 'image/png' });
      previewBlobUrl = URL.createObjectURL(blob);
      const img = el('img', { class: 'arc-img' });
      img.src = previewBlobUrl;
      previewBody.replaceChildren(el('div', { class: 'arc-img-wrap' }, [img]));
    } else {
      previewBody.replaceChildren(el('div', { class: 'dv-status', text: t('archiveBinaryHint', fmtBytes(message.size)) }));
    }
  } else if (message.type === 'error') {
    showStatus(tableWrap, message.message, true);
    post({ type: 'status', ok: false, detail: message.message });
  }
});

post({ type: 'ready' });
