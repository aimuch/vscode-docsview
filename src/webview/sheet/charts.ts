// Zero-dependency interactive SVG Chart engine (Bar / Line / Pie / Scatter) for CSV, Excel & JSONL.
import type { Cell } from '../../common/protocol';
import { el, post, t } from '../shared/api';
import { overlayStack } from '../shared/overlayStack';
import { iconButton, segmented } from '../shared/ui';
import { numericValue } from './view';

export type ChartKind = 'bar' | 'line' | 'pie' | 'scatter';

export interface ChartDataset {
  labels: string[];
  series: { name: string; values: number[]; color: string }[];
}

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

const cellStr = (c: Cell | undefined): string => (c == null ? '' : typeof c === 'string' ? c : c.v).trim();

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Extracts labels & numeric series from a rectangular cell selection `[r0..r1] x [c0..c1]`. */
export function extractChartDataset(
  cellAt: (r: number, c: number) => Cell | undefined,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  maxPoints = 120,
): ChartDataset | undefined {
  const endR = Math.min(r1, r0 + maxPoints);
  const colCount = c1 - c0 + 1;
  if (endR < r0 || colCount < 1) {
    return undefined;
  }

  // Detect whether r0 is a header row (mostly non-numeric while r0+1 has numbers).
  let hasHeader = false;
  if (endR > r0) {
    let r0Num = 0;
    let r1Num = 0;
    for (let c = c0; c <= c1; c++) {
      if (numericValue(cellAt(r0, c)) !== undefined) r0Num++;
      if (numericValue(cellAt(r0 + 1, c)) !== undefined) r1Num++;
    }
    hasHeader = r1Num > 0 && r0Num === 0;
  }

  const dataStartR = hasHeader ? r0 + 1 : r0;
  if (dataStartR > endR) {
    return undefined;
  }

  // Decide if first column is labels (non-numeric or multi-column where col 0 is category).
  let firstColNum = 0;
  let firstColNonEmpty = 0;
  for (let r = dataStartR; r <= endR; r++) {
    const v = cellStr(cellAt(r, c0));
    if (!v) continue;
    firstColNonEmpty++;
    if (numericValue(cellAt(r, c0)) !== undefined) firstColNum++;
  }
  const useFirstAsLabel = colCount >= 2 && (firstColNum === 0 || firstColNum < firstColNonEmpty * 0.5 || hasHeader);
  const seriesStartC = useFirstAsLabel ? c0 + 1 : c0;

  const labels: string[] = [];
  for (let r = dataStartR; r <= endR; r++) {
    labels.push(useFirstAsLabel ? cellStr(cellAt(r, c0)) || `#${r - dataStartR + 1}` : `#${r - dataStartR + 1}`);
  }

  const series: { name: string; values: number[]; color: string }[] = [];
  for (let c = seriesStartC; c <= Math.min(c1, seriesStartC + 7); c++) {
    const values: number[] = [];
    let validCount = 0;
    for (let r = dataStartR; r <= endR; r++) {
      const n = numericValue(cellAt(r, c));
      if (n !== undefined && Number.isFinite(n)) {
        values.push(n);
        validCount++;
      } else {
        values.push(0);
      }
    }
    if (validCount > 0) {
      const name = hasHeader ? cellStr(cellAt(r0, c)) || `Series ${series.length + 1}` : `Series ${series.length + 1}`;
      series.push({ name, values, color: PALETTE[series.length % PALETTE.length] });
    }
  }

  return series.length > 0 && labels.length > 0 ? { labels, series } : undefined;
}

function fmtTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Generates a crisp standalone SVG chart string (supports dark/light foreground via CSS vars & explicit fallbacks). */
export function renderChartSvg(data: ChartDataset, kind: ChartKind, width = 660, height = 340): string {
  const padL = 56;
  const padR = 20;
  const padT = 28;
  const padB = 54;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:system-ui,-apple-system,sans-serif;font-size:11px">`,
  ];

  // Legend
  let lx = padL;
  for (const s of data.series) {
    parts.push(`<rect x="${lx}" y="8" width="10" height="10" rx="2" fill="${s.color}"/>`);
    parts.push(`<text x="${lx + 14}" y="17" fill="currentColor" opacity="0.85">${escXml(s.name.slice(0, 18))}</text>`);
    lx += Math.min(130, 32 + s.name.length * 7);
  }

  if (kind === 'pie') {
    const s = data.series[0];
    const total = s.values.reduce((acc, v) => acc + Math.max(0, v), 0) || 1;
    const cx = width * 0.36;
    const cy = padT + plotH / 2 + 6;
    const r = Math.min(plotW * 0.3, plotH * 0.45);
    let angle = -Math.PI / 2;
    s.values.forEach((rawVal, idx) => {
      const val = Math.max(0, rawVal);
      if (val <= 0) return;
      const frac = val / total;
      const nextAngle = angle + frac * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(nextAngle);
      const y2 = cy + r * Math.sin(nextAngle);
      const large = frac > 0.5 ? 1 : 0;
      const color = PALETTE[idx % PALETTE.length];
      if (frac >= 0.9999) {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`);
      } else {
        parts.push(
          `<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${color}" stroke="#ffffff" stroke-width="1"><title>${escXml(data.labels[idx])}: ${val} (${(frac * 100).toFixed(1)}%)</title></path>`,
        );
      }
      angle = nextAngle;
    });
    // Right-side pie labels (top 12)
    const maxLegend = Math.min(data.labels.length, 12);
    for (let i = 0; i < maxLegend; i++) {
      const val = Math.max(0, s.values[i]);
      const pct = ((val / total) * 100).toFixed(1);
      const ly = padT + 14 + i * 20;
      parts.push(`<rect x="${Math.round(width * 0.64)}" y="${ly - 9}" width="10" height="10" rx="2" fill="${PALETTE[i % PALETTE.length]}"/>`);
      parts.push(
        `<text x="${Math.round(width * 0.64) + 15}" y="${ly}" fill="currentColor">${escXml(data.labels[i].slice(0, 18))} (${pct}%)</text>`,
      );
    }
    parts.push('</svg>');
    return parts.join('');
  }

  // Cartesian axes (bar / line / scatter)
  const allVals = data.series.flatMap((s) => s.values);
  let minV = Math.min(0, ...allVals);
  let maxV = Math.max(0, ...allVals);
  if (minV === maxV) {
    maxV = minV + 1;
  }
  const span = maxV - minV;
  const yOf = (v: number) => padT + plotH - ((v - minV) / span) * plotH;

  // Gridlines & Y ticks
  for (let i = 0; i <= 4; i++) {
    const v = minV + (span * i) / 4;
    const y = yOf(v);
    parts.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.14"/>`);
    parts.push(`<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="currentColor" opacity="0.72">${escXml(fmtTick(v))}</text>`);
  }

  const n = data.labels.length;
  const stepX = plotW / Math.max(1, n);
  const labelStride = Math.max(1, Math.ceil(n / 12));
  for (let i = 0; i < n; i += labelStride) {
    const cx = padL + stepX * (i + 0.5);
    parts.push(
      `<text x="${cx.toFixed(1)}" y="${height - padB + 18}" text-anchor="middle" fill="currentColor" opacity="0.75">${escXml(data.labels[i].slice(0, 12))}</text>`,
    );
  }

  const zeroY = yOf(0);
  if (kind === 'bar') {
    const sCount = data.series.length;
    const groupW = Math.max(4, stepX * 0.74);
    const barW = Math.max(2, groupW / sCount - 1);
    data.series.forEach((s, sIdx) => {
      s.values.forEach((v, i) => {
        const x = padL + stepX * i + (stepX - groupW) / 2 + sIdx * (groupW / sCount);
        const y = v >= 0 ? yOf(v) : zeroY;
        const h = Math.max(1, Math.abs(yOf(v) - zeroY));
        parts.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${s.color}"><title>${escXml(data.labels[i])} · ${escXml(s.name)}: ${v}</title></rect>`,
        );
      });
    });
  } else if (kind === 'line') {
    data.series.forEach((s) => {
      const pts = s.values
        .map((v, i) => `${(padL + stepX * (i + 0.5)).toFixed(1)},${yOf(v).toFixed(1)}`)
        .join(' ');
      parts.push(`<polyline fill="none" stroke="${s.color}" stroke-width="2.2" points="${pts}"/>`);
      if (n <= 40) {
        s.values.forEach((v, i) => {
          const cx = padL + stepX * (i + 0.5);
          const cy = yOf(v);
          parts.push(
            `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="${s.color}"><title>${escXml(data.labels[i])} · ${escXml(s.name)}: ${v}</title></circle>`,
          );
        });
      }
    });
  } else {
    // scatter
    data.series.forEach((s) => {
      s.values.forEach((v, i) => {
        const cx = padL + stepX * (i + 0.5);
        const cy = yOf(v);
        parts.push(
          `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.2" fill="${s.color}" fill-opacity="0.82"><title>${escXml(data.labels[i])} · ${escXml(s.name)}: ${v}</title></circle>`,
        );
      });
    });
  }

  parts.push('</svg>');
  return parts.join('');
}

async function svgToPngBytes(svgMarkup: string, width = 660, height = 340): Promise<{ bytes: Uint8Array; dataUrl: string }> {
  const cleanSvg = svgMarkup.replace(/currentColor/g, '#1f2937');
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleanSvg)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Chart rasterisation failed'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(2, 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/png');
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), dataUrl };
}

export function openChartModal(
  dataset: ChartDataset,
  opts: { onAiExplain?: (summary: string, imageDataUrl?: string) => void } = {},
): void {
  let kind: ChartKind = 'bar';
  let currentSvg = '';

  const backdrop = el('div', { class: 'dv-modal-backdrop' });
  const chartBox = el('div', { class: 'sheet-chart-canvas' });

  const render = () => {
    currentSvg = renderChartSvg(dataset, kind);
    chartBox.innerHTML = currentSvg;
  };

  const kindSeg = segmented<ChartKind>(
    t('sheetChart'),
    [
      ['bar', t('sheetChartBar')],
      ['line', t('sheetChartLine')],
      ['pie', t('sheetChartPie')],
      ['scatter', t('sheetChartScatter')],
    ],
    kind,
    (next) => {
      kind = next;
      render();
    },
  );

  const close = () => {
    overlayStack.remove('sheetChartModal');
    backdrop.remove();
  };

  const exportSvgBtn = el('button', { class: 'dv-btn', text: t('mdExportSvg') });
  exportSvgBtn.type = 'button';
  exportSvgBtn.addEventListener('click', () => {
    post({ type: 'saveTextExport', ext: 'svg', suffix: '-chart', content: currentSvg.replace(/currentColor/g, '#1f2937') });
  });

  const exportPngBtn = el('button', { class: 'dv-btn', text: t('mdExportPng') });
  exportPngBtn.type = 'button';
  exportPngBtn.addEventListener('click', () => {
    void svgToPngBytes(currentSvg).then(({ bytes }) => {
      post({ type: 'saveBytesExport', ext: 'png', suffix: '-chart', bytes });
    });
  });

  const footerBtns: HTMLElement[] = [exportSvgBtn, exportPngBtn];
  if (opts.onAiExplain) {
    const aiBtn = el('button', { class: 'dv-btn dv-ai-primary-btn', text: `✨ ${t('sheetChartAiAnalyze')}` });
    aiBtn.type = 'button';
    aiBtn.addEventListener('click', () => {
      const summary = [
        `Chart type: ${kind}`,
        `Labels (${dataset.labels.length}): ${dataset.labels.slice(0, 30).join(', ')}`,
        ...dataset.series.map((s) => `${s.name}: ${s.values.slice(0, 30).join(', ')}`),
      ].join('\n');
      void svgToPngBytes(currentSvg)
        .then(({ dataUrl }) => {
          close();
          opts.onAiExplain?.(summary, dataUrl);
        })
        .catch(() => {
          close();
          opts.onAiExplain?.(summary);
        });
    });
    footerBtns.push(aiBtn);
  }

  const modal = el('div', { class: 'dv-modal' }, [
    el('div', { class: 'dv-modal-head' }, [
      el('span', { class: 'dv-modal-title', text: t('sheetChart') }),
      kindSeg.node,
      el('div', { class: 'dv-spacer' }),
      iconButton('close', t('close'), close),
    ]),
    el('div', { class: 'dv-modal-body' }, [chartBox]),
    el('div', { class: 'dv-modal-footer' }, footerBtns),
  ]);

  backdrop.append(modal);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
  render();

  overlayStack.push({
    id: 'sheetChartModal',
    isOpen: () => backdrop.isConnected,
    close,
  });
}
