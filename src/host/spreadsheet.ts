// Shared entry point for heavy spreadsheet engines (ExcelJS, SheetJS, xmldom, fflate)
// so the extension host loads them on demand as one shared bundle.
export { ExcelSession, type EditResult } from './excel/excelSession';
export { rowsToDelimited, rowsToXlsx, sanitizeSheetName, workbookToDelimited, workbookToXlsx } from './convert';
