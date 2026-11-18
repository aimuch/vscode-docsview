// Shared entry point for heavy spreadsheet engines (ExcelJS, SheetJS, xmldom, fflate)
// so the extension host loads them on demand as one shared bundle.
export { ExcelSession, type EditResult } from './excel/excelSession';
export {
  rowsToDelimited,
  rowsToJsonl,
  rowsToXlsx,
  sanitizeSheetName,
  workbookToDelimited,
  workbookToJsonl,
  workbookToXlsx,
} from './convert';
