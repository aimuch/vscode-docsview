// Pure bidirectional CV object-detection annotation converters:
// - Ultralytics / Darknet YOLO (.txt + optional classes.txt)
// - MS COCO Object Detection (.json)
// - LabelMe (.json)
import { BBOX_PALETTE, clamp, type BBox } from './bbox';

export type ImportedBox = Omit<BBox, 'id'>;

function colorForClass(index: number): string {
  return BBOX_PALETTE[Math.abs(index) % BBOX_PALETTE.length];
}

function clampBox(x1: number, y1: number, x2: number, y2: number, imgW: number, imgH: number) {
  const cx1 = clamp(Math.round(Math.min(x1, x2)), 0, Math.max(0, imgW - 1));
  const cy1 = clamp(Math.round(Math.min(y1, y2)), 0, Math.max(0, imgH - 1));
  const cx2 = clamp(Math.max(cx1 + 1, Math.round(Math.max(x1, x2))), 1, Math.max(1, imgW));
  const cy2 = clamp(Math.max(cy1 + 1, Math.round(Math.max(y1, y2))), 1, Math.max(1, imgH));
  return { x1: cx1, y1: cy1, x2: cx2, y2: cy2 };
}

/** Parses YOLO `.txt` lines (`classId cx cy w h` in normalised `[0..1]` file format) into integer pixel BBoxes. */
export function parseYolo(text: string, imgW: number, imgH: number, classesText?: string): ImportedBox[] {
  if (imgW <= 0 || imgH <= 0) {
    return [];
  }
  const classNames = classesText
    ? classesText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s, i, arr) => s.length > 0 || i < arr.length - 1)
    : [];
  const out: ImportedBox[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 5) {
      continue;
    }
    const clsToken = parts[0];
    const clsIdx = /^\d+$/.test(clsToken) ? Number(clsToken) : 0;
    const nums = parts.slice(1, 5).map(Number);
    if (!nums.every(Number.isFinite)) {
      continue;
    }
    const [cx, cy, w, h] = nums;
    const pxW = w * imgW;
    const pxH = h * imgH;
    const pxCx = cx * imgW;
    const pxCy = cy * imgH;
    const rect = clampBox(pxCx - pxW / 2, pxCy - pxH / 2, pxCx + pxW / 2, pxCy + pxH / 2, imgW, imgH);
    const label = /^\d+$/.test(clsToken) ? (classNames[clsIdx] ?? `class_${clsIdx}`) : clsToken;
    out.push({
      ...rect,
      label,
      color: colorForClass(clsIdx || out.length),
    });
  }
  return out;
}

/** Serialises integer pixel BBoxes into YOLO `.txt` + `classes.txt`. */
export function exportYolo(boxes: readonly BBox[], imgW: number, imgH: number): { txt: string; classesTxt: string } {
  const classes: string[] = [];
  const classIndex = new Map<string, number>();
  const getClassId = (rawLabel: string | undefined): number => {
    const label = (rawLabel ?? '').trim() || 'object';
    let idx = classIndex.get(label);
    if (idx === undefined) {
      idx = classes.length;
      classes.push(label);
      classIndex.set(label, idx);
    }
    return idx;
  };
  const wDenom = Math.max(1, imgW);
  const hDenom = Math.max(1, imgH);
  const lines = boxes.map((b) => {
    const cls = getClassId(b.label);
    const bw = Math.max(1, b.x2 - b.x1);
    const bh = Math.max(1, b.y2 - b.y1);
    const cx = (b.x1 + bw / 2) / wDenom;
    const cy = (b.y1 + bh / 2) / hDenom;
    const nw = bw / wDenom;
    const nh = bh / hDenom;
    return `${cls} ${cx.toFixed(6)} ${cy.toFixed(6)} ${nw.toFixed(6)} ${nh.toFixed(6)}`;
  });
  return {
    txt: lines.join('\n') + (lines.length ? '\n' : ''),
    classesTxt: classes.join('\n') + (classes.length ? '\n' : ''),
  };
}

/** Parses MS COCO Object Detection JSON (`images`, `annotations` with `[x, y, width, height]`, `categories`). */
export function parseCoco(jsonText: string, imgW: number, imgH: number, targetFileName?: string): ImportedBox[] {
  const data = JSON.parse(jsonText) as {
    images?: { id: number; file_name?: string }[];
    annotations?: { image_id?: number; category_id?: number; bbox?: number[] }[];
    categories?: { id: number; name: string }[];
  };
  if (!Array.isArray(data?.annotations)) {
    return [];
  }
  const catMap = new Map<number, string>();
  if (Array.isArray(data.categories)) {
    for (const c of data.categories) {
      if (typeof c.id === 'number' && typeof c.name === 'string') {
        catMap.set(c.id, c.name);
      }
    }
  }
  let matchedImageId: number | undefined;
  if (targetFileName && Array.isArray(data.images) && data.images.length > 1) {
    const base = targetFileName.split(/[\\/]/).pop()?.toLowerCase();
    const img = data.images.find((im) => im.file_name?.split(/[\\/]/).pop()?.toLowerCase() === base);
    if (img) {
      matchedImageId = img.id;
    }
  }
  const out: ImportedBox[] = [];
  for (const ann of data.annotations) {
    if (matchedImageId !== undefined && ann.image_id !== matchedImageId) {
      continue;
    }
    if (!Array.isArray(ann.bbox) || ann.bbox.length < 4) {
      continue;
    }
    const [x, y, w, h] = ann.bbox.map(Number);
    if (![x, y, w, h].every(Number.isFinite)) {
      continue;
    }
    const rect = clampBox(x, y, x + w, y + h, imgW, imgH);
    const catId = typeof ann.category_id === 'number' ? ann.category_id : 1;
    out.push({
      ...rect,
      label: catMap.get(catId) ?? (ann.category_id !== undefined ? `class_${catId}` : undefined),
      color: colorForClass(catId - 1),
    });
  }
  return out;
}

/** Exports integer pixel BBoxes as MS COCO Object Detection JSON. */
export function exportCoco(boxes: readonly BBox[], fileName: string, imgW: number, imgH: number): string {
  const categories: { id: number; name: string; supercategory: string }[] = [];
  const catIndex = new Map<string, number>();
  const getCatId = (rawLabel: string | undefined): number => {
    const name = (rawLabel ?? '').trim() || 'object';
    let id = catIndex.get(name);
    if (id === undefined) {
      id = categories.length + 1;
      categories.push({ id, name, supercategory: 'none' });
      catIndex.set(name, id);
    }
    return id;
  };
  const annotations = boxes.map((b, idx) => {
    const x = Math.round(b.x1);
    const y = Math.round(b.y1);
    const w = Math.max(1, Math.round(b.x2 - b.x1));
    const h = Math.max(1, Math.round(b.y2 - b.y1));
    return {
      id: idx + 1,
      image_id: 1,
      category_id: getCatId(b.label),
      bbox: [x, y, w, h],
      area: w * h,
      iscrowd: 0,
    };
  });
  return JSON.stringify(
    {
      images: [{ id: 1, file_name: fileName, width: imgW, height: imgH }],
      annotations,
      categories,
    },
    null,
    2,
  );
}

/** Parses LabelMe JSON (`shapes` with `shape_type: "rectangle"` or polygon bounds). */
export function parseLabelMe(jsonText: string, imgW: number, imgH: number): ImportedBox[] {
  const data = JSON.parse(jsonText) as {
    shapes?: { label?: string; points?: number[][]; shape_type?: string }[];
  };
  if (!Array.isArray(data?.shapes)) {
    return [];
  }
  const labelPalette = new Map<string, number>();
  const out: ImportedBox[] = [];
  for (const shape of data.shapes) {
    if (!Array.isArray(shape.points) || shape.points.length < 2) {
      continue;
    }
    const xs = shape.points.map((p) => Number(p[0])).filter(Number.isFinite);
    const ys = shape.points.map((p) => Number(p[1])).filter(Number.isFinite);
    if (xs.length < 2 || ys.length < 2) {
      continue;
    }
    const rect = clampBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), imgW, imgH);
    const label = shape.label?.trim() || undefined;
    const key = label ?? 'object';
    if (!labelPalette.has(key)) {
      labelPalette.set(key, labelPalette.size);
    }
    out.push({
      ...rect,
      label,
      color: colorForClass(labelPalette.get(key) ?? out.length),
    });
  }
  return out;
}

/** Exports integer pixel BBoxes as LabelMe JSON. */
export function exportLabelMe(boxes: readonly BBox[], fileName: string, imgW: number, imgH: number): string {
  const shapes = boxes.map((b) => ({
    label: (b.label ?? '').trim() || 'object',
    points: [
      [Math.round(b.x1), Math.round(b.y1)],
      [Math.round(b.x2), Math.round(b.y2)],
    ],
    group_id: null,
    description: '',
    shape_type: 'rectangle',
    flags: {},
  }));
  return JSON.stringify(
    {
      version: '5.0.1',
      flags: {},
      shapes,
      imagePath: fileName,
      imageData: null,
      imageHeight: imgH,
      imageWidth: imgW,
    },
    null,
    2,
  );
}

/** Auto-detects YOLO `.txt`, COCO `.json`, LabelMe `.json`, or DocsView BBox array JSON. */
export function parseAnnotationContent(
  content: string,
  imgW: number,
  imgH: number,
  opts?: { classesText?: string; fileName?: string },
): ImportedBox[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown> | unknown[];
      if (Array.isArray(parsed)) {
        const out: ImportedBox[] = [];
        for (const item of parsed) {
          if (item && typeof item === 'object' && Array.isArray((item as { bbox?: unknown }).bbox)) {
            const nums = ((item as { bbox: unknown[] }).bbox).map(Number);
            if (nums.length >= 4 && nums.every(Number.isFinite)) {
              const rect = clampBox(nums[0], nums[1], nums[2], nums[3], imgW, imgH);
              const label = typeof (item as { label?: unknown }).label === 'string' ? (item as { label: string }).label : undefined;
              out.push({ ...rect, label, color: colorForClass(out.length) });
            }
          }
        }
        return out;
      }
      if (Array.isArray(parsed.shapes)) {
        return parseLabelMe(trimmed, imgW, imgH);
      }
      if (Array.isArray(parsed.annotations)) {
        return parseCoco(trimmed, imgW, imgH, opts?.fileName);
      }
    } catch {
      return [];
    }
  }
  return parseYolo(trimmed, imgW, imgH, opts?.classesText);
}
