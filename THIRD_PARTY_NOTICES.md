# Third-party notices

DocsView bundles the following open-source libraries (and their transitive dependencies) into `dist/`. No other VS Code extension is required or used.

| Library | Version | License | Used for |
| --- | --- | --- | --- |
| [markdown-it](https://github.com/markdown-it/markdown-it) | 15.0.3 | MIT | Markdown parsing |
| [markdown-it-footnote](https://github.com/markdown-it/markdown-it-footnote) | 4.0.0 | MIT | Markdown footnotes |
| [@vscode/markdown-it-katex](https://github.com/microsoft/vscode-markdown-it-katex) | 1.1.2 | MIT | Math in Markdown |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.19.1 | MIT | Math rendering, fonts |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 11.12.0 | BSD-3-Clause | Code highlighting |
| [Mermaid](https://github.com/mermaid-js/mermaid) | 12.3.0 | MIT | Diagrams |
| [morphdom](https://github.com/patrick-steele-idem/morphdom) | 2.7.8 | MIT | Incremental preview updates |
| [ExcelJS](https://github.com/exceljs/exceljs) | 4.4.0 | MIT | Reading xlsx with styles |
| [SheetJS Community Edition](https://sheetjs.com) | 0.20.3 | Apache-2.0 | Reading xls/ods, number formats |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | Zip read/write for xlsx patching |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | 0.9.12 | MIT | Worksheet XML editing |
| [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) | 0.4.1 | Apache-2.0 | docx rendering |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.x | MIT (dual MIT / GPL-3.0-or-later; used under MIT) | Zip reading for docx/pptx |
| [word-extractor](https://github.com/morungos/node-word-extractor) | 1.0.4 | MIT | Text extraction from .doc |
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 6.5.438 | Apache-2.0 | PDF rendering; ships CMaps, standard fonts and image decoders under their own licenses (see `dist/webview/pdfjs/`) |
| [pptx-preview](https://www.npmjs.com/package/pptx-preview) | 1.0.7 | ISC | pptx rendering; depends on Apache ECharts (Apache-2.0), lodash (MIT), uuid (MIT), tslib (0BSD) |

Note on `pptx-preview`: the npm package is published under the ISC license and its README states the package may be used free of charge, including commercially, but its source code is not public. Review this before publishing DocsView to a marketplace if that matters for your distribution.
