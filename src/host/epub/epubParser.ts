// Pure EPUB 2 / EPUB 3 parser (`fflate` + `@xmldom/xmldom` + `sanitizeExportHtml`).
// Resolves container.xml -> OPF spine/manifest/TOC, inlines packaged images as data: URIs,
// and sanitises chapter XHTML so books render safely offline under strict CSP.
import { DOMParser, type Element as XElement } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import type { EpubBookData, EpubChapter, EpubTocItem } from '../../common/protocol';
import { sanitizeExportHtml } from '../markdown/exportPage';

const createXmlParser = () => new DOMParser({ locator: false, onError: () => undefined });

function resolveZipPath(baseDir: string, relHref: string): string {
  const cleanHref = decodeURIComponent(relHref.split('#')[0].split('?')[0]);
  if (cleanHref.startsWith('/')) {
    return cleanHref.slice(1);
  }
  const parts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const seg of cleanHref.split('/')) {
    if (seg === '..') {
      parts.pop();
    } else if (seg && seg !== '.') {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash) : '';
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function guessImageMime(path: string, declared?: string): string {
  if (declared && declared.startsWith('image/')) {
    return declared;
  }
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

function extractBodyInnerHtml(rawXhtml: string): { title: string; bodyHtml: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(rawXhtml);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(rawXhtml);
  const bodyHtml = bodyMatch ? bodyMatch[1] : rawXhtml;
  return { title, bodyHtml };
}

export function parseEpub(bytes: Uint8Array): EpubBookData {
  const files = unzipSync(bytes);
  const parser = createXmlParser();

  // 1. Locate OPF package path from META-INF/container.xml
  let opfPath = '';
  const containerBytes = files['META-INF/container.xml'];
  if (containerBytes) {
    const cDoc = parser.parseFromString(strFromU8(containerBytes), 'text/xml');
    const rootfile = cDoc.getElementsByTagNameNS('*', 'rootfile').item(0);
    opfPath = rootfile?.getAttribute('full-path') ?? '';
  }
  if (!opfPath || !files[opfPath]) {
    opfPath = Object.keys(files).find((k) => k.toLowerCase().endsWith('.opf')) ?? '';
  }
  if (!opfPath || !files[opfPath]) {
    throw new Error('Invalid EPUB archive: package .opf file not found.');
  }

  const opfDir = dirOf(opfPath);
  const opfDoc = parser.parseFromString(strFromU8(files[opfPath]), 'text/xml');

  const firstText = (localName: string): string => {
    const el = opfDoc.getElementsByTagNameNS('*', localName).item(0);
    return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  };
  const bookTitle = firstText('title') || 'Untitled Book';
  const bookAuthor = firstText('creator') || '';

  // 2. Parse manifest items
  const manifest = new Map<string, { path: string; href: string; mediaType: string; properties: string }>();
  const pathToManifestMedia = new Map<string, string>();
  const itemNodes = opfDoc.getElementsByTagNameNS('*', 'item');
  for (let i = 0; i < itemNodes.length; i++) {
    const el = itemNodes.item(i)!;
    const id = el.getAttribute('id') ?? '';
    const href = el.getAttribute('href') ?? '';
    const mediaType = el.getAttribute('media-type') ?? '';
    const properties = el.getAttribute('properties') ?? '';
    if (id && href) {
      const fullPath = resolveZipPath(opfDir, href);
      manifest.set(id, { path: fullPath, href, mediaType, properties });
      pathToManifestMedia.set(fullPath, mediaType);
    }
  }

  // 3. Parse spine reading order
  const spinePaths: { id: string; path: string }[] = [];
  const itemRefs = opfDoc.getElementsByTagNameNS('*', 'itemref');
  for (let i = 0; i < itemRefs.length; i++) {
    const idref = itemRefs.item(i)!.getAttribute('idref') ?? '';
    const item = manifest.get(idref);
    if (item && files[item.path]) {
      spinePaths.push({ id: idref, path: item.path });
    }
  }
  if (!spinePaths.length) {
    for (const [id, item] of manifest) {
      if (/html|xml/i.test(item.mediaType) && !item.properties.includes('nav') && files[item.path]) {
        spinePaths.push({ id, path: item.path });
      }
    }
  }

  const chapterIndexByPath = new Map<string, number>();
  spinePaths.forEach((sp, idx) => chapterIndexByPath.set(sp.path, idx));

  // 4. Parse TOC (EPUB 3 nav document or EPUB 2 NCX)
  const toc: EpubTocItem[] = [];
  const navEntry = [...manifest.values()].find((m) => /\bnav\b/.test(m.properties) && files[m.path]);
  const ncxEntry = [...manifest.values()].find((m) => /ncx/i.test(m.mediaType) && files[m.path]);

  if (navEntry) {
    const navDir = dirOf(navEntry.path);
    const navDoc = parser.parseFromString(strFromU8(files[navEntry.path]), 'text/xml');
    const navs = navDoc.getElementsByTagNameNS('*', 'nav');
    let tocNav: XElement | null = navs.item(0);
    for (let i = 0; i < navs.length; i++) {
      const n = navs.item(i)!;
      if ((n.getAttribute('epub:type') ?? n.getAttribute('type') ?? '').includes('toc')) {
        tocNav = n;
        break;
      }
    }
    const walkOl = (parent: XElement, level: number) => {
      for (let c = parent.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        const el = c as XElement;
        const ln = el.localName || el.tagName;
        if (ln === 'ol' || ln === 'ul') {
          walkOl(el, level);
        } else if (ln === 'li') {
          for (let lc = el.firstChild; lc; lc = lc.nextSibling) {
            if (lc.nodeType !== 1) continue;
            const lel = lc as XElement;
            const ltag = lel.localName || lel.tagName;
            if (ltag === 'a') {
              const rawHref = lel.getAttribute('href') ?? '';
              const text = (lel.textContent ?? '').replace(/\s+/g, ' ').trim();
              const targetPath = resolveZipPath(navDir, rawHref);
              const hashIdx = rawHref.indexOf('#');
              const anchor = hashIdx >= 0 ? rawHref.slice(hashIdx + 1) : undefined;
              const chIdx = chapterIndexByPath.get(targetPath) ?? 0;
              if (text) {
                toc.push({ level, text, chapterIndex: chIdx, anchor });
              }
            } else if (ltag === 'ol' || ltag === 'ul') {
              walkOl(lel, level + 1);
            }
          }
        }
      }
    };
    if (tocNav) {
      walkOl(tocNav, 1);
    }
  } else if (ncxEntry) {
    const ncxDir = dirOf(ncxEntry.path);
    const ncxDoc = parser.parseFromString(strFromU8(files[ncxEntry.path]), 'text/xml');
    const navMap = ncxDoc.getElementsByTagNameNS('*', 'navMap').item(0);
    const walkNavPoints = (parent: XElement, level: number) => {
      for (let c = parent.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        const el = c as XElement;
        if ((el.localName || el.tagName) !== 'navPoint') continue;
        const labelEl = el.getElementsByTagNameNS('*', 'text').item(0);
        const contentEl = el.getElementsByTagNameNS('*', 'content').item(0);
        const text = (labelEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const rawSrc = contentEl?.getAttribute('src') ?? '';
        const targetPath = resolveZipPath(ncxDir, rawSrc);
        const hashIdx = rawSrc.indexOf('#');
        const anchor = hashIdx >= 0 ? rawSrc.slice(hashIdx + 1) : undefined;
        const chIdx = chapterIndexByPath.get(targetPath) ?? 0;
        if (text) {
          toc.push({ level, text, chapterIndex: chIdx, anchor });
        }
        walkNavPoints(el, level + 1);
      }
    };
    if (navMap) {
      walkNavPoints(navMap, 1);
    }
  }

  // 5. Build sanitised chapters with inlined local images
  const chapters: EpubChapter[] = spinePaths.map((sp, idx) => {
    const chDir = dirOf(sp.path);
    const raw = strFromU8(files[sp.path]);
    const { title, bodyHtml } = extractBodyInnerHtml(raw);

    // Inline relative <img src="..."> and SVG <image href/xlink:href="...">
    const inlined = bodyHtml.replace(
      /\b(src|href|xlink:href)\s*=\s*(["'])([^"']+)\2/gi,
      (full, attr: string, quote: string, url: string) => {
        if (/^(?:data:|https?:|mailto:|#)/i.test(url.trim())) {
          return full;
        }
        const resolved = resolveZipPath(chDir, url);
        const imgBytes = files[resolved];
        if (!imgBytes) {
          // Rewrite intra-book chapter links as `data-epub-ch` hash anchors if matching a spine chapter
          const hashAt = url.indexOf('#');
          const anchor = hashAt >= 0 ? url.slice(hashAt) : '';
          const targetIdx = chapterIndexByPath.get(resolved);
          if (targetIdx !== undefined && attr.toLowerCase() === 'href') {
            return `href=${quote}#epub-ch-${targetIdx}${anchor ? `-${anchor.slice(1)}` : ''}${quote}`;
          }
          return full;
        }
        const mime = guessImageMime(resolved, pathToManifestMedia.get(resolved));
        if (!mime.startsWith('image/')) {
          return full;
        }
        return `${attr}=${quote}data:${mime};base64,${toBase64(imgBytes)}${quote}`;
      },
    );

    const headingMatch = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(inlined);
    const fallbackHeading = headingMatch ? headingMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    const chapterTitle = title || fallbackHeading || `Chapter ${idx + 1}`;

    return {
      id: sp.id,
      title: chapterTitle,
      html: sanitizeExportHtml(inlined),
    };
  });

  if (!toc.length) {
    chapters.forEach((ch, idx) => {
      toc.push({ level: 1, text: ch.title, chapterIndex: idx });
    });
  }

  return {
    title: bookTitle,
    author: bookAuthor,
    chapters,
    toc,
  };
}
