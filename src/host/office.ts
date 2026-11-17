export { applyDocxMutations, inspectDocx, type DocxInspection } from './office/docxPatcher';
export { applyPdfMutations, inspectPdf } from './office/pdfAnnotator';
export { applyPptxMutations, inspectPptx, readPptxAspect, type PptxInspection } from './office/pptxPatcher';
export { OfficeSession, type OfficeEditResult, type OfficeFormat } from './office/officeSession';
