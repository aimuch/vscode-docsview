import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { unzipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import PptxGenJS from 'pptxgenjs';
import { describe, expect, it } from 'vitest';
import {
  applyDocxMutations,
  applyPdfMutations,
  applyPptxMutations,
  inspectDocx,
  inspectPdf,
  inspectPptx,
  OfficeSession,
  readPptxAspect,
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
  });
});
