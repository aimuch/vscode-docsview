// Canvas encoding & geometric transform helpers for the Image viewer (`docsview.image`).
import type { ImageExportFormat } from '../../common/protocol';
import { encodeBmp, encodeIcoFromPng, type ImageTransformOp, type PixelRect } from './bbox';

export const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

export function extOfFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : 'png';
}

export function nativeFormatForExt(ext: string): ImageExportFormat {
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'webp') return 'webp';
  if (ext === 'bmp') return 'bmp';
  if (ext === 'ico') return 'ico';
  return 'png';
}

export function canvasToBytes(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error(`Failed to encode ${mime}`));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      mime,
      quality,
    );
  });
}

export async function encodeCanvas(canvas: HTMLCanvasElement, format: ImageExportFormat): Promise<Uint8Array> {
  const w = canvas.width;
  const h = canvas.height;
  if (format === 'bmp') {
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.getImageData(0, 0, w, h);
    return encodeBmp(imgData.data, imgData.width, imgData.height);
  }
  if (format === 'ico') {
    const maxSide = 256;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const iw = Math.max(1, Math.round(w * scale));
    const ih = Math.max(1, Math.round(h * scale));
    const iconCanvas = document.createElement('canvas');
    iconCanvas.width = iw;
    iconCanvas.height = ih;
    iconCanvas.getContext('2d')!.drawImage(canvas, 0, 0, w, h, 0, 0, iw, ih);
    const pngBytes = await canvasToBytes(iconCanvas, 'image/png');
    return encodeIcoFromPng(pngBytes, iw, ih);
  }
  if (format === 'jpg') {
    // Composite transparent pixels over white so PNG -> JPG never turns transparent areas black.
    const jpgCanvas = document.createElement('canvas');
    jpgCanvas.width = w;
    jpgCanvas.height = h;
    const ctx = jpgCanvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0);
    return canvasToBytes(jpgCanvas, 'image/jpeg', 0.92);
  }
  if (format === 'webp') {
    return canvasToBytes(canvas, 'image/webp', 0.92);
  }
  return canvasToBytes(canvas, 'image/png');
}

export async function encodeRegionFromCanvas(
  sourceCanvas: HTMLCanvasElement,
  sampleCtx: CanvasRenderingContext2D,
  rect: PixelRect,
  format: ImageExportFormat,
): Promise<Uint8Array> {
  const w = Math.max(1, Math.round(rect.x2 - rect.x1));
  const h = Math.max(1, Math.round(rect.y2 - rect.y1));

  if (format === 'bmp') {
    const imgData = sampleCtx.getImageData(rect.x1, rect.y1, w, h);
    return encodeBmp(imgData.data, imgData.width, imgData.height);
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  outCanvas.getContext('2d')!.drawImage(sourceCanvas, rect.x1, rect.y1, w, h, 0, 0, w, h);
  return encodeCanvas(outCanvas, format);
}

export function renderTransformedCanvas(sourceCanvas: HTMLCanvasElement, op: ImageTransformOp): HTMLCanvasElement {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const outW = op === 'rotCW' || op === 'rotCCW' ? h : w;
  const outH = op === 'rotCW' || op === 'rotCCW' ? w : h;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const ctx = outCanvas.getContext('2d')!;
  ctx.save();
  if (op === 'rotCW') {
    ctx.translate(outW, 0);
    ctx.rotate(Math.PI / 2);
  } else if (op === 'rotCCW') {
    ctx.translate(0, outH);
    ctx.rotate(-Math.PI / 2);
  } else if (op === 'flipH') {
    ctx.translate(outW, 0);
    ctx.scale(-1, 1);
  } else if (op === 'flipV') {
    ctx.translate(0, outH);
    ctx.scale(1, -1);
  }
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.restore();
  return outCanvas;
}
