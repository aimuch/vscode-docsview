export { applyDocxMutations, inspectDocx, resolveTargetIndex, type DocxInspection } from './office/docxPatcher';
export {
  applyPdfMutations,
  extractPdfPagesToBytes,
  inspectPdf,
  parsePageRangeSpec,
  pdfRectToVisualRect,
  visualRectToPdfRect,
} from './office/pdfAnnotator';
export { applyPptxMutations, inspectPptx, readPptxAspect, type PptxInspection } from './office/pptxPatcher';
export { OfficeSession, type OfficeEditResult, type OfficeFormat } from './office/officeSession';
export { docxToMarkdown, pptxToMarkdown } from './office/toMarkdown';
