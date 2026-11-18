import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { unzipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import PptxGenJS from 'pptxgenjs';
import { describe, expect, it } from 'vitest';
import { formatCommentsAsMarkdown } from '../../src/common/commentsMarkdown';
import {
  applyDocxMutations,
  applyPdfMutations,
  applyPptxMutations,
  extractPdfPagesToBytes,
  inspectDocx,
  inspectPdf,
  inspectPptx,
  OfficeSession,
  parsePageRangeSpec,
  readPptxAspect,
  resolveTargetIndex,
} from '../../src/host/office';

async function makeSampleDocx(): Promise<Uint8Array> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: '项目立项报告', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
          new Paragraph({
            children: [
              new TextRun({ text: '第一段正文：包含中文与 English 混排。', bold: true, color: 'C00000' }),
            ],
          }),
          new Paragraph({ text: '第二段正文：待评审条款。' }),
        ],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function makeSamplePptx(layout: 'LAYOUT_16x9' | 'LAYOUT_4x3' = 'LAYOUT_4x3'): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = layout;
  const s1 = pptx.addSlide();
  s1.addText('季度总结汇报', { x: 0.5, y: 0.5, w: 8, h: 1, fontSize: 32, bold: true });
  s1.addText('核心指标达成率 108%', { x: 0.5, y: 2.0, w: 8, h: 1, fontSize: 20 });

  const s2 = pptx.addSlide();
  s2.addText('下一步计划', { x: 0.5, y: 0.5, w: 8, h: 1, fontSize: 28 });

  const buf = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function makeSamplePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = pdf.addPage([600, 800]);
    page.drawText(`Sample PDF Page ${i}`, { x: 50, y: 720, size: 18, font });
  }
  const saved = await pdf.save();
  return new Uint8Array(saved.buffer, saved.byteOffset, saved.byteLength);
}

describe('DOCX comments & in-place paragraph editing', () => {
  it('adds, updates and deletes OOXML Word/WPS comments and preserves paragraph anchors', async () => {
    const initial = await makeSampleDocx();
    const info0 = inspectDocx(initial);
    expect(info0.paragraphs).toEqual([
      '项目立项报告',
      '第一段正文：包含中文与 English 混排。',
      '第二段正文：待评审条款。',
    ]);
    expect(info0.comments).toEqual([]);

    const withComments = applyDocxMutations(initial, [
      { kind: 'addComment', pIndex: 1, text: '请核对英文术语拼写', author: '张三' },
      { kind: 'addComment', pIndex: 2, text: '此处需补充法务意见', author: '李四' },
    ]);

    const info1 = inspectDocx(withComments);
    expect(info1.comments).toHaveLength(2);
    expect(info1.comments[0]).toMatchObject({
      id: '1',
      author: '张三',
      text: '请核对英文术语拼写',
      pIndex: 1,
      quote: '第一段正文：包含中文与 English 混排。',
    });
    expect(info1.comments[1]).toMatchObject({
      id: '2',
      author: '李四',
      text: '此处需补充法务意见',
      pIndex: 2,
    });

    // Update comment #1 and delete comment #2
    const updated = applyDocxMutations(withComments, [
      { kind: 'updateComment', id: '1', text: '已核对通过\n可进入下一阶段' },
      { kind: 'deleteComment', id: '2' },
    ]);
    const info2 = inspectDocx(updated);
    expect(info2.comments).toHaveLength(1);
    expect(info2.comments[0]).toMatchObject({
      id: '1',
      text: '已核对通过\n可进入下一阶段',
      pIndex: 1,
    });
  });

  it('edits paragraph text in place while preserving styles, comments and untouched zip entries', async () => {
    const initial = await makeSampleDocx();
    const commented = applyDocxMutations(initial, [
      { kind: 'addComment', pIndex: 1, text: '保留这条批注' },
    ]);
    const edited = applyDocxMutations(commented, [
      {
        kind: 'editDocxParagraph',
        pIndex: 1,
        expected: '第一段正文：包含中文与 English 混排。',
        text: '第一段正文（已修订）：支持直接双击编辑文字。',
      },
    ]);

    const info = inspectDocx(edited);
    expect(info.paragraphs[1]).toBe('第一段正文（已修订）：支持直接双击编辑文字。');
    expect(info.comments).toHaveLength(1);
    expect(info.comments[0].pIndex).toBe(1);

    // word/styles.xml must remain byte-for-byte identical
    const zBefore = unzipSync(initial);
    const zAfter = unzipSync(edited);
    expect(Buffer.from(zAfter['word/styles.xml']).equals(Buffer.from(zBefore['word/styles.xml']))).toBe(true);
  });
});

describe('PPTX aspect ratio, slide comments & text shape editing', () => {
  it('reads exact 4:3 and 16:9 slide aspect ratios from presentation.xml', async () => {
    const ppt43 = await makeSamplePptx('LAYOUT_4x3');
    const ppt169 = await makeSamplePptx('LAYOUT_16x9');
    expect(readPptxAspect(ppt43)).toBeCloseTo(4 / 3, 3);
    expect(readPptxAspect(ppt169)).toBeCloseTo(16 / 9, 3);
    expect(inspectPptx(ppt43).slideAspect).toBeCloseTo(4 / 3, 3);
  });

  it('round-trips OOXML slide comments with normalised coordinates and edits slide text shapes', async () => {
    const initial = await makeSamplePptx('LAYOUT_16x9');
    const info0 = inspectPptx(initial);
    expect(info0.shapes[0]).toEqual(['季度总结汇报', '核心指标达成率 108%']);
    expect(info0.comments).toEqual([]);

    const mutated = applyPptxMutations(initial, [
      {
        kind: 'addComment',
        page: 1,
        author: '王五',
        text: '标题字号建议再放大一点',
        rect: { x: 0.25, y: 0.4, w: 0, h: 0 },
      },
      {
        kind: 'editPptxText',
        slideIndex: 0,
        shapeIndex: 1,
        expected: '核心指标达成率 108%',
        text: '核心指标达成率 125%\n同比增长显著',
      },
    ]);

    const info1 = inspectPptx(mutated);
    expect(info1.shapes[0][1]).toBe('核心指标达成率 125%\n同比增长显著');
    expect(info1.comments).toHaveLength(1);
    expect(info1.comments[0].author).toBe('王五');
    expect(info1.comments[0].text).toBe('标题字号建议再放大一点');
    expect(info1.comments[0].page).toBe(1);
    expect(info1.comments[0].rect?.x).toBeCloseTo(0.25, 2);
    expect(info1.comments[0].rect?.y).toBeCloseTo(0.4, 2);

    const cid = info1.comments[0].id;
    const afterUpdate = applyPptxMutations(mutated, [{ kind: 'updateComment', id: cid, text: '已调整字号' }]);
    expect(inspectPptx(afterUpdate).comments[0].text).toBe('已调整字号');

    const afterDelete = applyPptxMutations(afterUpdate, [{ kind: 'deleteComment', id: cid }]);
    expect(inspectPptx(afterDelete).comments).toEqual([]);
  });
});

describe('PDF ISO 32000 annotations (/Square & /Text)', () => {
  it('round-trips box and pin annotations with UTF-16BE Chinese text', async () => {
    const initial = await makeSamplePdf();
    expect(await inspectPdf(initial)).toEqual([]);

    const withAnnots = await applyPdfMutations(initial, [
      {
        kind: 'addComment',
        page: 1,
        author: '审阅人A',
        text: '框选批注：检查此处图表数据',
        rect: { x: 0.15, y: 0.2, w: 0.4, h: 0.18 },
      },
      {
        kind: 'addComment',
        page: 2,
        author: 'Reviewer B',
        text: 'Pin note on page 2',
        rect: { x: 0.5, y: 0.6, w: 0, h: 0 },
      },
    ]);

    const list1 = await inspectPdf(withAnnots);
    expect(list1).toHaveLength(2);
    expect(list1[0].page).toBe(1);
    expect(list1[0].author).toBe('审阅人A');
    expect(list1[0].text).toBe('框选批注：检查此处图表数据');
    expect(list1[0].rect?.x).toBeCloseTo(0.15, 2);
    expect(list1[0].rect?.y).toBeCloseTo(0.2, 2);
    expect(list1[0].rect?.w).toBeCloseTo(0.4, 2);
    expect(list1[0].rect?.h).toBeCloseTo(0.18, 2);

    expect(list1[1].page).toBe(2);
    expect(list1[1].rect?.w).toBe(0);
    expect(list1[1].text).toBe('Pin note on page 2');

    const edited = await applyPdfMutations(withAnnots, [
      { kind: 'updateComment', id: list1[0].id, text: '框选批注（已确认无误）' },
      { kind: 'deleteComment', id: list1[1].id },
    ]);
    const list2 = await inspectPdf(edited);
    expect(list2).toHaveLength(1);
    expect(list2[0].text).toBe('框选批注（已确认无误）');
  });
});

describe('OfficeSession undo, redo, stale rejection & hot-exit backup', () => {
  it('tracks dirty state, undo/redo, and backup/restore across sessions', async () => {
    const initial = await makeSampleDocx();
    const session = await OfficeSession.open('docx', initial, 'demo.docx');
    expect(session.dirty).toBe(false);

    // Reject stale edit whose expected text does not match
    const rejected = await session.apply({
      kind: 'editDocxParagraph',
      pIndex: 0,
      expected: '不存在的旧标题',
      text: '新标题',
    });
    expect(rejected).toBeUndefined();
    expect(session.dirty).toBe(false);

    const step1 = await session.apply({
      kind: 'editDocxParagraph',
      pIndex: 0,
      expected: '项目立项报告',
      text: '项目立项报告（终稿）',
    });
    expect(step1).toBeDefined();
    expect(session.dirty).toBe(true);

    const step2 = await session.apply({
      kind: 'addComment',
      pIndex: 0,
      text: '封面标题已更新',
    });
    expect(step2).toBeDefined();
    expect(session.comments).toHaveLength(1);

    // Backup before undo, then verify restore on a brand-new session
    const backupJson = session.backup();
    const restored = await OfficeSession.open('docx', initial, 'demo.docx');
    await restored.restore(backupJson);
    expect(inspectDocx(restored.export()).paragraphs[0]).toBe('项目立项报告（终稿）');
    expect(restored.comments).toHaveLength(1);

    // Undo both steps returns dirty to false
    step2!.undo();
    expect(session.comments).toHaveLength(0);
    expect(session.dirty).toBe(true);

    step1!.undo();
    expect(session.dirty).toBe(false);
    expect(inspectDocx(session.export()).paragraphs[0]).toBe('项目立项报告');

    // Redo step 1 and markSaved
    step1!.redo();
    expect(session.dirty).toBe(true);
    session.markSaved();
    expect(session.dirty).toBe(false);
  });

  it('evicts old byte snapshots beyond MAX_CACHED_STEPS while deterministically replaying deep undo/redo', async () => {
    const initial = await makeSampleDocx();
    const session = await OfficeSession.open('docx', initial, 'deep.docx');
    const steps = [];
    for (let i = 1; i <= 9; i++) {
      const step = await session.apply({
        kind: 'addComment',
        pIndex: i % 3,
        text: `批注 #${i}`,
      });
      expect(step).toBeDefined();
      steps.push(step!);
    }
    expect(session.comments).toHaveLength(9);

    // Undo all 9 steps (crossing the 6-step snapshot cache boundary)
    for (let i = steps.length - 1; i >= 0; i--) {
      await steps[i].undo();
      expect(session.comments).toHaveLength(i);
    }
    expect(session.dirty).toBe(false);

    // Redo all 9 steps back
    for (let i = 0; i < steps.length; i++) {
      await steps[i].redo();
      expect(session.comments).toHaveLength(i + 1);
    }
    expect(session.comments[8].text).toBe('批注 #9');
    // Comment-only mutations on DOCX emit lightweight incremental `{ type: 'comments' }` messages
    expect(steps[0].message.type).toBe('comments');
  });

  it('resolves paragraph indices safely across TOC drift while refusing distant duplicate overwrites', () => {
    const paras = ['封面', '待定', ...Array.from({ length: 30 }, (_, i) => `章节 ${i + 1}`), '唯一结论段', '待定'];
    // Exact index hit
    expect(resolveTargetIndex(paras, 1, '待定')).toBe(1);
    // Unique paragraph found even when hintIndex drifted by > 25 lines due to TOC/page breaks
    expect(resolveTargetIndex(paras, 5, '唯一结论段')).toBe(32);
    // Nearby duplicate within maxDrift (12) resolves to closest
    expect(resolveTargetIndex(paras, 3, '待定')).toBe(1);
    // Ambiguous duplicate far from both occurrences is safely rejected (-1) instead of corrupting line 1!
    expect(resolveTargetIndex(paras, 18, '待定')).toBe(-1);
  });

  it('supports PPTX Speaker Notes (notesSlide), PDF page restructuring, /Highlight & Markdown comment export', async () => {
    // 1. PPTX Speaker Notes creation & editing
    const ppt = await makeSamplePptx('LAYOUT_16x9');
    expect(inspectPptx(ppt).notes).toEqual(['', '']);
    const withNote = applyPptxMutations(ppt, [
      { kind: 'editPptxNote', slideIndex: 0, text: '开场提醒：强调本季度增长亮点\n控制 3 分钟内' },
    ]);
    const pptInfo = inspectPptx(withNote);
    expect(pptInfo.notes[0]).toBe('开场提醒：强调本季度增长亮点\n控制 3 分钟内');
    expect(pptInfo.notes[1]).toBe('');

    // 2. PDF /Highlight, rotation, reorder, delete, merge & extract
    const pdf2 = await makeSamplePdf();
    const pdfMutated = await applyPdfMutations(pdf2, [
      {
        kind: 'addComment',
        page: 1,
        text: '关键结论句',
        quote: 'Sample PDF Page 1',
        rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.04 },
        color: '#fde047',
        subtype: 'highlight',
      },
      { kind: 'rotatePdfPages', pages: [1], delta: 90 },
      { kind: 'movePdfPage', fromPage: 1, toPage: 2 },
    ]);
    const loadedDoc = await PDFDocument.load(pdfMutated);
    expect(loadedDoc.getPageCount()).toBe(2);
    // Original page 1 was rotated 90° and moved to page 2!
    expect(loadedDoc.getPage(1).getRotation().angle).toBe(90);
    const hlComments = await inspectPdf(pdfMutated);
    expect(hlComments).toHaveLength(1);
    expect(hlComments[0].page).toBe(2);
    expect(hlComments[0].subtype).toBe('highlight');

    // Merge another 2-page PDF -> 4 pages, then delete page 4 -> 3 pages
    const merged = await applyPdfMutations(pdfMutated, [
      { kind: 'appendPdfBytes', otherBytes: pdf2 },
      { kind: 'deletePdfPage', page: 4 },
    ]);
    expect((await PDFDocument.load(merged)).getPageCount()).toBe(3);

    // Extract page range "1, 3" -> 2-page PDF
    expect(parsePageRangeSpec('1-2, 5, 2', 3)).toEqual([1, 2]);
    const extracted = await extractPdfPagesToBytes(merged, [1, 3]);
    expect((await PDFDocument.load(extracted)).getPageCount()).toBe(2);

    // 3. Markdown checklist export for comments
    const mdChecklist = formatCommentsAsMarkdown('spec.pdf', hlComments, (c) => `Page ${c.page}`);
    expect(mdChecklist).toContain('# spec.pdf — Comments (1)');
    expect(mdChecklist).toContain('- [ ] **#1** [Page 2]');
    expect(mdChecklist).toContain('> Sample PDF Page 1');
  });

  it('maps rotated PDF annotations (0/90/180/270), multi-quad highlights, appendPdfBytes backup & DOCX/PPTX -> Markdown', async () => {
    const {
      docxToMarkdown,
      pdfRectToVisualRect,
      pptxToMarkdown,
      visualRectToPdfRect,
    } = await import('../../src/host/office');

    // 1. Exact inverse across all 4 PDF /Rotate angles
    const box = { x: 0, y: 0, width: 600, height: 800 };
    const vis = { x: 0.15, y: 0.25, w: 0.4, h: 0.1 };
    for (const angle of [0, 90, 180, 270]) {
      const pdfR = visualRectToPdfRect(vis, box, angle);
      const back = pdfRectToVisualRect(pdfR, box, angle);
      expect(back.x).toBeCloseTo(vis.x, 4);
      expect(back.y).toBeCloseTo(vis.y, 4);
      expect(back.w).toBeCloseTo(vis.w, 4);
      expect(back.h).toBeCloseTo(vis.h, 4);
    }

    // 2. Multi-quad /Highlight on a 90° rotated PDF page + appendPdfBytes hot-exit backup/restore
    const basePdf = await makeSamplePdf();
    const rotatedPdf = await applyPdfMutations(basePdf, [{ kind: 'rotatePdfPages', pages: [1], delta: 90 }]);
    const quads = [
      { x: 0.1, y: 0.2, w: 0.7, h: 0.03 },
      { x: 0.1, y: 0.24, w: 0.45, h: 0.03 },
    ];
    const pdfSession = await OfficeSession.open('pdf', rotatedPdf, 'rot.pdf');
    await pdfSession.apply({
      kind: 'addComment',
      page: 1,
      text: 'Two-line highlight',
      rect: { x: 0.1, y: 0.2, w: 0.7, h: 0.07 },
      quads,
      subtype: 'highlight',
    });
    await pdfSession.apply({ kind: 'appendPdfBytes', otherBytes: basePdf });
    const backupStr = pdfSession.backup();
    const restoredPdf = await OfficeSession.open('pdf', rotatedPdf, 'rot.pdf');
    await restoredPdf.restore(backupStr);
    expect((await PDFDocument.load(restoredPdf.export())).getPageCount()).toBe(4);
    expect(restoredPdf.comments[0].quads).toHaveLength(2);
    expect(restoredPdf.comments[0].quads![1].w).toBeCloseTo(0.45, 2);

    // 3. DOCX -> Markdown & PPTX -> Markdown converters
    const { Table, TableCell, TableRow } = await import('docx');
    const richDoc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: '项目立项报告', heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ children: [new TextRun({ text: '核心结论', bold: true })] }),
            new Paragraph({ text: '里程碑一', bullet: { level: 0 } }),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph('指标')] }),
                    new TableCell({ children: [new Paragraph('数值')] }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph('达成率')] }),
                    new TableCell({ children: [new Paragraph('108%')] }),
                  ],
                }),
              ],
            }),
          ],
        },
      ],
    });
    const richBuf = await Packer.toBuffer(richDoc);
    const docxMd = docxToMarkdown(new Uint8Array(richBuf.buffer, richBuf.byteOffset, richBuf.byteLength));
    expect(docxMd).toContain('# 项目立项报告');
    expect(docxMd).toContain('**核心结论**');
    expect(docxMd).toContain('- 里程碑一');
    expect(docxMd).toContain('| 指标 | 数值 |');

    const pptBytes = applyPptxMutations(await makeSamplePptx('LAYOUT_16x9'), [
      { kind: 'editPptxNote', slideIndex: 0, text: 'Speaker cue 1' },
    ]);
    const pptMd = pptxToMarkdown(pptBytes);
    expect(pptMd).toContain('## Slide 1');
    expect(pptMd).toContain('Speaker cue 1');
  });
});
