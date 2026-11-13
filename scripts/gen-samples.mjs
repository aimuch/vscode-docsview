// Generates the sample documents under samples/ used for manual testing, the dev
// harness and the unit tests.  Usage: npm run samples
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import { PDFDocument, PDFHexString, PDFName, PDFNull, StandardFonts, rgb } from 'pdf-lib';
import PptxGenJS from 'pptxgenjs';
import * as XLSX from 'xlsx';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'samples');
mkdirSync(join(out, 'assets'), { recursive: true });
const write = (name, data) => {
  writeFileSync(join(out, name), data);
  console.log('wrote', `samples/${name}`);
};

// ---------------------------------------------------------------- markdown

write(
  'assets/logo.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="64" viewBox="0 0 220 64">
  <rect width="220" height="64" rx="10" fill="#2f6feb"/>
  <text x="110" y="41" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">DocsView</text>
</svg>
`,
);

const filler = Array.from(
  { length: 12 },
  (_, i) => `### 小节 ${i + 1}\n\n这是用于测试滚动同步的第 ${i + 1} 段填充内容。Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n`,
).join('\n');

write(
  'demo.md',
  `---
title: DocsView 示例
author: demo
---

# DocsView Markdown 示例

![logo](assets/logo.svg)

一段包含 **粗体**、*斜体*、~~删除线~~、\`行内代码\` 和[外部链接](https://code.visualstudio.com)的文字，以及指向[另一个文件](people.csv)的相对链接。跳到[数学公式](#数学公式)。

## 任务列表

- [x] Markdown 预览
- [x] 表格编辑
- [ ] 待办事项

## 表格

| 格式 | 预览 | 编辑 |
| :--- | :---: | ---: |
| Markdown | ✅ | 文本 |
| CSV | ✅ | ✅ |
| Excel | ✅ | ✅ |

## 代码

\`\`\`ts
interface User {
  id: number;
  name: string;
}

export function greet(user: User): string {
  // 返回问候语
  return \`Hello, \${user.name}!\`;
}
\`\`\`

\`\`\`python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
\`\`\`

## 流程图

\`\`\`mermaid
graph LR
  A[打开文件] --> B{格式?}
  B -->|Markdown| C[渲染 HTML]
  B -->|Excel| D[表格视图]
  B -->|PDF| E[pdf.js]
  C --> F[预览]
  D --> F
  E --> F
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant W as Webview
  participant H as 扩展宿主
  W->>H: ready
  H-->>W: render(html)
  W->>H: revealLine
\`\`\`

## 数学公式

行内公式 $E = mc^2$，以及块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

## 引用与脚注

> 好的工具让复杂的事情变简单。[^1]

[^1]: 这是一个脚注。

---

${filler}
`,
);

// ---------------------------------------------------------------- csv

write(
  'people.csv',
  [
    '姓名,部门,城市,入职日期,薪资,备注',
    '张伟,研发部,北京,2019-03-12,28000,"后端, 架构"',
    '李娜,设计部,上海,2020-07-01,22000,"UI ""主设计师"""',
    '王芳,市场部,广州,2018-11-23,19500,',
    'John Smith,Engineering,London,2021-01-15,6500,"Line one',
    'line two"',
    '赵磊,研发部,深圳,2022-05-09,25000,前端',
    'Maria García,Sales,Madrid,2017-09-30,4800,',
    '',
  ].join('\n'),
);

write('scores.tsv', ['name\tmath\tenglish\tnote', 'Alice\t92\t88\tgood', 'Bob\t75\t91\t', 'Carol\t60\t70\tneeds help', ''].join('\n'));

{
  const cols = ['id', 'date', 'region', 'product', 'units', 'price', 'amount', 'customer', 'channel', 'status', 'owner', 'memo'];
  const regions = ['华北', '华东', '华南', '西南', 'EMEA', 'APAC'];
  const lines = [cols.join(',')];
  for (let i = 1; i <= 20000; i++) {
    const units = (i * 7) % 50;
    const price = 10 + ((i * 13) % 900) / 10;
    lines.push(
      [
        i,
        `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        regions[i % regions.length],
        `SKU-${1000 + (i % 250)}`,
        units,
        price.toFixed(2),
        (units * price).toFixed(2),
        `customer_${i % 977}`,
        i % 3 ? 'online' : 'retail',
        i % 11 ? 'paid' : 'pending',
        `owner${i % 17}`,
        i % 50 === 0 ? '"needs review, urgent"' : '',
      ].join(','),
    );
  }
  write('large.csv', lines.join('\n') + '\n');
}

// ---------------------------------------------------------------- xlsx

{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('销售报表', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });
  ws.columns = [{ width: 16 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 22 }];

  ws.mergeCells('A1:F1');
  const title = ws.getCell('A1');
  title.value = '2024 年季度销售报表';
  title.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F6FEB' } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 30;

  const header = ws.addRow(['产品', '单价', '数量', '金额', '日期', '备注']);
  header.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F7' } };
    cell.alignment = { horizontal: 'center' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FF2F6FEB' } } };
  });

  const products = ['笔记本电脑', '显示器', '机械键盘', '鼠标', '耳机', '扩展坞', '摄像头', '移动硬盘'];
  products.forEach((name, i) => {
    const r = i + 3;
    const row = ws.addRow([
      name,
      1299.5 + i * 310.25,
      12 + i * 3,
      { formula: `B${r}*C${r}`, result: (1299.5 + i * 310.25) * (12 + i * 3) },
      new Date(Date.UTC(2024, i, 5 + i)),
      i === 2 ? '促销中' : i === 5 ? '缺货，需补货' : '',
    ]);
    row.getCell(2).numFmt = '#,##0.00';
    row.getCell(4).numFmt = '¥#,##0.00';
    row.getCell(5).numFmt = 'yyyy-mm-dd';
    if (i === 5) {
      row.getCell(6).font = { color: { argb: 'FFC00000' }, italic: true };
    }
  });

  const totalRow = products.length + 3;
  const total = ws.addRow(['合计', null, { formula: `SUM(C3:C${totalRow - 1})` }, { formula: `SUM(D3:D${totalRow - 1})` }]);
  total.getCell(3).value = { formula: `SUM(C3:C${totalRow - 1})`, result: products.reduce((s, _, i) => s + 12 + i * 3, 0) };
  total.getCell(4).value = {
    formula: `SUM(D3:D${totalRow - 1})`,
    result: products.reduce((s, _, i) => s + (1299.5 + i * 310.25) * (12 + i * 3), 0),
  };
  total.getCell(4).numFmt = '¥#,##0.00';
  total.eachCell((cell) => {
    cell.font = { bold: true };
    cell.border = { top: { style: 'thin' } };
  });
  ws.getCell(`A${totalRow + 2}`).value = '完成率';
  ws.getCell(`B${totalRow + 2}`).value = 0.8765;
  ws.getCell(`B${totalRow + 2}`).numFmt = '0.00%';

  const ws2 = wb.addWorksheet('员工');
  ws2.addRow(['工号', '姓名', '部门', '在职']);
  ws2.addRow(['007', '张伟', '研发部', true]);
  ws2.addRow(['012', '李娜', '设计部', true]);
  ws2.addRow(['031', '王芳', '市场部', false]);

  const ws3 = wb.addWorksheet('Wide');
  ws3.addRow(Array.from({ length: 40 }, (_, i) => `Col ${i + 1}`));
  for (let r = 0; r < 300; r++) {
    ws3.addRow(Array.from({ length: 40 }, (_, c) => r * 40 + c));
  }

  write('report.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
}

// ---------------------------------------------------------------- xls

{
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Item', 'Qty', 'Price', 'Total'],
    ['Widget', 4, 2.5, { f: 'B2*C2', v: 10, t: 'n' }],
    ['Gadget', 10, 1.75, { f: 'B3*C3', v: 17.5, t: 'n' }],
    ['旧版格式', 1, 99, { f: 'B4*C4', v: 99, t: 'n' }],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Legacy');
  write('legacy.xls', XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }));
}

// ---------------------------------------------------------------- docx

{
  const cell = (text, bold = false) =>
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: '项目进展报告', heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
          new Paragraph({
            children: [
              new TextRun('本文档用于测试 '),
              new TextRun({ text: 'Word 预览', bold: true }),
              new TextRun('，包含 '),
              new TextRun({ text: '斜体', italics: true }),
              new TextRun('、'),
              new TextRun({ text: '彩色文字', color: 'C00000' }),
              new TextRun(' 和表格。'),
            ],
          }),
          new Paragraph({ text: '一、里程碑', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: '完成需求评审', bullet: { level: 0 } }),
          new Paragraph({ text: '完成原型设计', bullet: { level: 0 } }),
          new Paragraph({ text: '进入开发阶段', bullet: { level: 0 } }),
          new Paragraph({ text: '二、数据', heading: HeadingLevel.HEADING_2 }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ children: [cell('阶段', true), cell('负责人', true), cell('状态', true)] }),
              new TableRow({ children: [cell('设计'), cell('李娜'), cell('已完成')] }),
              new TableRow({ children: [cell('开发'), cell('张伟'), cell('进行中')] }),
              new TableRow({ children: [cell('测试'), cell('王芳'), cell('未开始')] }),
            ],
          }),
          new Paragraph({ text: '' }),
          ...Array.from(
            { length: 30 },
            (_, i) =>
              new Paragraph({
                text: `第 ${i + 1} 段：这是一段用于撑开页面、测试分页与滚动的正文内容。The quick brown fox jumps over the lazy dog.`,
                spacing: { after: 200 },
              }),
          ),
        ],
      },
    ],
  });
  write('letter.docx', await Packer.toBuffer(doc));
}

// ---------------------------------------------------------------- doc (macOS only)

try {
  const html = join(out, 'legacy-source.html');
  writeFileSync(
    html,
    `<html><head><meta charset="utf-8"></head><body><h1>旧版 Word 文档</h1><p>这是一个 .doc 文件，用于测试文字提取。</p><p>Second paragraph in English.</p><ul><li>第一项</li><li>第二项</li></ul></body></html>`,
  );
  execFileSync('textutil', ['-convert', 'doc', html, '-output', join(out, 'legacy.doc')]);
  execFileSync('rm', [html]);
  console.log('wrote', 'samples/legacy.doc');
} catch (err) {
  console.warn('skipped samples/legacy.doc (needs macOS textutil):', err.message);
}

// ---------------------------------------------------------------- pdf

{
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let p = 1; p <= 5; p++) {
    const page = pdf.addPage([595, 842]);
    page.drawRectangle({ x: 0, y: 782, width: 595, height: 60, color: rgb(0.18, 0.44, 0.92) });
    page.drawText(`DocsView PDF sample - page ${p}`, { x: 40, y: 804, size: 20, font: bold, color: rgb(1, 1, 1) });
    for (let i = 0; i < 28; i++) {
      page.drawText(
        `Line ${i + 1} of page ${p}: the quick brown fox jumps over the lazy dog. Searchable keyword: needle${p}`,
        { x: 40, y: 740 - i * 24, size: 11, font, color: rgb(0.1, 0.1, 0.1) },
      );
    }
    page.drawCircle({ x: 520, y: 80, size: 30, color: rgb(0.95, 0.6, 0.1) });
  }
  // Bookmarks (document outline), two levels deep, for the outline sidebar.
  const ctx = pdf.context;
  const pages = pdf.getPages();
  const outlinesRef = ctx.nextRef();
  const tree = [
    { title: 'Chapter 1: Introduction', page: 0, children: [{ title: '1.1 Background', page: 1 }] },
    { title: 'Chapter 2: Results', page: 2, children: [{ title: '2.1 Tables', page: 3 }] },
    { title: 'Appendix', page: 4, children: [] },
  ];
  const addLevel = (items, parentRef) => {
    const refs = items.map(() => ctx.nextRef());
    let count = 0;
    items.forEach((item, i) => {
      const dict = {
        Title: PDFHexString.fromText(item.title),
        Parent: parentRef,
        Dest: ctx.obj([pages[item.page].ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]),
      };
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < items.length - 1) dict.Next = refs[i + 1];
      if (item.children?.length) {
        const child = addLevel(item.children, refs[i]);
        dict.First = child.refs[0];
        dict.Last = child.refs[child.refs.length - 1];
        dict.Count = child.count;
        count += child.count;
      }
      ctx.assign(refs[i], ctx.obj(dict));
      count++;
    });
    return { refs, count };
  };
  const top = addLevel(tree, outlinesRef);
  ctx.assign(
    outlinesRef,
    ctx.obj({ Type: 'Outlines', First: top.refs[0], Last: top.refs[top.refs.length - 1], Count: top.count }),
  );
  pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
  write('paper.pdf', await pdf.save());
}

// ---------------------------------------------------------------- pptx

{
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  let slide = pptx.addSlide();
  slide.background = { color: '1F3B73' };
  slide.addText('DocsView 幻灯片示例', { x: 0.6, y: 1.8, w: 8.8, h: 1, fontSize: 36, bold: true, color: 'FFFFFF' });
  slide.addText('PPTX preview sample', { x: 0.6, y: 2.9, w: 8.8, h: 0.6, fontSize: 18, color: 'C9D7F2' });

  slide = pptx.addSlide();
  slide.addText('要点', { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true, color: '1F3B73' });
  slide.addText(
    [
      { text: '支持 Markdown、Excel、Word、CSV', options: { bullet: true } },
      { text: '支持 PDF 与 PPT', options: { bullet: true } },
      { text: '表格可直接编辑', options: { bullet: true } },
    ],
    { x: 0.7, y: 1.3, w: 8.5, h: 2.5, fontSize: 20, color: '333333' },
  );
  slide.addShape(pptx.ShapeType.rect, { x: 7.2, y: 3.6, w: 2, h: 1.2, fill: { color: 'F2994A' } });

  slide = pptx.addSlide();
  slide.addText('数据', { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true, color: '1F3B73' });
  slide.addTable(
    [
      [{ text: '季度', options: { bold: true } }, { text: '收入', options: { bold: true } }, { text: '增长', options: { bold: true } }],
      ['Q1', '120', '5%'],
      ['Q2', '150', '25%'],
      ['Q3', '180', '20%'],
    ],
    { x: 0.7, y: 1.4, w: 8.5, fontSize: 16, border: { type: 'solid', pt: 1, color: '999999' } },
  );
  write('slides.pptx', Buffer.from(await pptx.write({ outputType: 'nodebuffer' })));
}
