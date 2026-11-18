// Archive (`.zip` / `.tar` / `.tar.gz` / `.tgz` / `.vsix` / `.whl` / `.jar`) explorer & inline file previewer.
import '../shared/base.css';
import './archive.css';
import type { ArchiveEntryInfo } from '../../common/protocol';
import { app, el, onMessage, post, showStatus, t, toArrayBuffer } from '../shared/api';
import { createFindBar } from '../shared/find';
import { icons } from '../shared/icons';
import { Outline, Sidebar, type OutlineItem } from '../shared/sidebar';
import { customToolbar, iconButton, openExternalButton, openExternalMenuItem } from '../shared/ui';

const MAX_RENDERED_ROWS = 2000;

let archiveName = '';
let allEntries: ArchiveEntryInfo[] = [];
let currentFolder = '';
let sortCol: 'name' | 'size' | 'compressed' | 'ratio' = 'name';
let sortDir: 1 | -1 = 1;
let searchQuery = '';
let filteredCount = 0;
let activePath = '';
let previewBlobUrl: string | undefined;

const tableWrap = el('div', { class: 'arc-table-wrap' });
tableWrap.tabIndex = -1;

const sidebar = new Sidebar(t('nav'), undefined, { defaultOpen: true });
const folderTree = new Outline((key) => {
  currentFolder = key === '__ALL__' ? '' : key;
  folderTree.setActive(key);
  renderTable();
});
sidebar.panel().append(folderTree.node);

const findBar = createFindBar(
  {
    onInput: (q) => {
      searchQuery = q.trim().toLowerCase();
      renderTable();
    },
    step: () => undefined,
    clear: () => {
      searchQuery = '';
      renderTable();
    },
    status: (q) => (q.trim() ? (filteredCount ? String(filteredCount) : t('noMatch')) : ''),
  },
  tableWrap,
);

const extractAllBtn = iconButton('export', t('archiveExtractAll'), () => post({ type: 'extractAllArchive' }));

const topBar = customToolbar({
  subtitle: () => (archiveName ? archiveName : 'ARCHIVE'),
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'find', nodes: findBar.nodes },
    { id: 'actions', label: t('archiveExtractAll'), nodes: [extractAllBtn] },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    { icon: 'export', label: t('archiveExtractAll'), onClick: () => post({ type: 'extractAllArchive' }) },
    openExternalMenuItem(),
  ],
});

const previewPane = el('div', { class: 'arc-preview' });
previewPane.hidden = true;
const previewTitle = el('span', { class: 'arc-preview-title' });
const openTempBtn = el('button', { class: 'dv-btn dv-cm-primary', text: t('archiveExtractOpen') });
openTempBtn.type = 'button';
openTempBtn.addEventListener('click', () => {
  if (activePath) {
    post({ type: 'openArchiveEntryTemp', path: activePath });
  }
});
const saveAsBtn = el('button', { class: 'dv-btn', text: t('archiveSaveAs') });
saveAsBtn.type = 'button';
saveAsBtn.addEventListener('click', () => {
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
  el('div', { class: 'arc-preview-head' }, [
    previewTitle,
    el('div', { class: 'dv-spacer' }),
    saveAsBtn,
    openTempBtn,
    closePreviewBtn,
  ]),
  previewBody,
);

const statusText = el('span', { class: 'dv-label' });
const statusBar = el('div', { class: 'dv-statusbar arc-statusbar' }, [el('div', { class: 'dv-spacer' }), statusText]);

const splitMain = el('div', { class: 'arc-workspace' }, [tableWrap, previewPane]);
app.append(
  topBar.node,
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [splitMain])]),
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
  if (currentFolder && !dirs.has(currentFolder)) {
    currentFolder = '';
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
  folderTree.setActive(currentFolder || '__ALL__');
}

function selectRowForPreview(path: string) {
  activePath = path;
  previewTitle.textContent = path;
  previewPane.hidden = false;
  showStatus(previewBody, t('loading'));
  renderTable();
  post({ type: 'previewArchiveEntry', path });
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

  filteredCount = files.length;
  findBar.refreshCount();

  if (!files.length) {
    tableWrap.replaceChildren(el('div', { class: 'dv-status', text: t('noMatch') }));
    return;
  }

  files.sort((a, b) => {
    let cmp = 0;
    if (sortCol === 'name') cmp = a.path.localeCompare(b.path, undefined, { numeric: true });
    else if (sortCol === 'size') cmp = a.size - b.size;
    else if (sortCol === 'compressed') cmp = a.compressedSize - b.compressedSize;
    else cmp = savedPct(a.size, a.compressedSize) - savedPct(b.size, b.compressedSize);
    return cmp * sortDir;
  });

  const th = (col: typeof sortCol, label: string, num = false) => {
    const isSorted = sortCol === col;
    const arrow = isSorted ? (sortDir === 1 ? ' ↑' : ' ↓') : '';
    const cell = el('th', { class: num ? 'arc-num' : '', text: `${label}${arrow}` });
    cell.tabIndex = 0;
    cell.setAttribute('aria-sort', isSorted ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
    const toggleSort = () => {
      if (sortCol === col) sortDir = sortDir === 1 ? -1 : 1;
      else {
        sortCol = col;
        sortDir = col === 'name' ? 1 : -1;
      }
      renderTable();
    };
    cell.addEventListener('click', toggleSort);
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSort();
      }
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

  const rows = files.slice(0, MAX_RENDERED_ROWS).map((f, rowIdx) => {
    const pct = savedPct(f.size, f.compressedSize);
    const ic = el('span', { class: 'arc-file-ic' });
    ic.innerHTML = icons.file;
    const tr = el('tr', { class: f.path === activePath ? 'arc-row-active' : '' }, [
      el('td', { class: 'arc-path-cell', title: f.path }, [ic, el('span', { text: f.path })]),
      el('td', { class: 'arc-num', text: fmtBytes(f.size) }),
      el('td', { class: 'arc-num', text: fmtBytes(f.compressedSize) }),
      el('td', { class: 'arc-num', text: pct > 0 ? `-${pct}%` : '0%' }),
    ]);
    tr.tabIndex = 0;
    tr.addEventListener('click', () => selectRowForPreview(f.path));
    tr.addEventListener('dblclick', () => post({ type: 'openArchiveEntryTemp', path: f.path }));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          post({ type: 'openArchiveEntryTemp', path: f.path });
        } else {
          selectRowForPreview(f.path);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        rows[rowIdx + 1]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        rows[rowIdx - 1]?.focus();
      }
    });
    return tr;
  });

  if (files.length > MAX_RENDERED_ROWS) {
    const noticeTd = el('td', {
      class: 'arc-trunc-cell',
      text: t('archiveTruncated', MAX_RENDERED_ROWS.toLocaleString(), files.length.toLocaleString()),
    });
    noticeTd.colSpan = 4;
    rows.push(el('tr', {}, [noticeTd]));
  }

  tableWrap.replaceChildren(el('table', { class: 'arc-table' }, [thead, el('tbody', {}, rows)]));
}

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
