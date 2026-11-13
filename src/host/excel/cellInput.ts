/** How text typed into a cell is stored in the workbook. */
export type CellInput =
  | { kind: 'empty' }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'formula'; formula: string }
  | { kind: 'string'; value: string };

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function parseCellInput(text: string): CellInput {
  if (text === '') {
    return { kind: 'empty' };
  }
  // A leading apostrophe forces text, as in Excel.
  if (text.startsWith("'")) {
    return { kind: 'string', value: text.slice(1) };
  }
  if (text.startsWith('=') && text.length > 1) {
    return { kind: 'formula', formula: text.slice(1) };
  }
  const trimmed = text.trim();
  if (NUMBER.test(trimmed)) {
    // Keep identifiers such as "007" or very long digit strings as text: converting
    // them to a number would silently change what the user typed.
    const digits = trimmed.replace(/^[+-]/, '');
    const leadingZero = /^0\d/.test(digits);
    const tooLong = digits.replace(/[.eE+-].*$/, '').length > 15;
    const value = Number(trimmed);
    if (!leadingZero && !tooLong && Number.isFinite(value)) {
      return { kind: 'number', value };
    }
  }
  const upper = trimmed.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') {
    return { kind: 'boolean', value: upper === 'TRUE' };
  }
  return { kind: 'string', value: text };
}
