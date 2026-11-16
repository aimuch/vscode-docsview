import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  deleteCols,
  deleteRows,
  detectDelimiter,
  editCells,
  insertCols,
  insertRows,
  parseCsv,
  serializeCell,
  type CsvContext,
} from '../../src/host/csv/csvParser';
import { CsvSession } from '../../src/host/csv/csvSession';

function ctx(text: string, delimiter = ',', eol = '\n'): CsvContext {
  return { text, records: parseCsv(text, delimiter), delimiter, eol };
}

const cells = (text: string, delimiter = ',') => parseCsv(text, delimiter).map((r) => r.cells);

describe('parseCsv', () => {
  it('parses quoted fields, escaped quotes and embedded line breaks', () => {
    const text = 'a,b,c\n"x, y","say ""hi""","line1\nline2"\n';
    expect(cells(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
    ]);
  });

  it('records the exact character range of every record', () => {
    const text = 'a,b\r\n"1\r\n2",3\r\nlast';
    const records = parseCsv(text, ',');
    expect(records.map((r) => text.slice(r.start, r.end))).toEqual(['a,b', '"1\r\n2",3', 'last']);
  });

  it('keeps empty lines and trailing empty fields', () => {
    expect(cells('a,\n\nb,c')).toEqual([['a', ''], [''], ['b', 'c']]);
  });

  it('does not invent a record for a trailing line break', () => {
    expect(cells('a\nb\n')).toHaveLength(2);
    expect(cells('')).toHaveLength(0);
  });
});

describe('detectDelimiter', () => {
  it('detects common delimiters', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
    expect(detectDelimiter('a|b|c\n1|2|3\n')).toBe('|');
  });

  it('ignores delimiters inside quotes and prefers the consistent one', () => {
    expect(detectDelimiter('name;note\n"a,b,c,d";x\n"e,f";y\n')).toBe(';');
    expect(detectDelimiter('name;note\n"say ""a,b""";x\n1;2\n')).toBe(';');
  });

  it('is not fooled by bare unquoted inch marks inside fields', () => {
    expect(detectDelimiter('item;spec\nDell;24" Monitor\nLG;27" Display\n')).toBe(';');
    expect(detectDelimiter('item|spec\nPipe|1/2" steel\nValve|3/4" brass\n')).toBe('|');
  });

  it('uses tab for .tsv regardless of content', () => {
    expect(detectDelimiter('a,b', 'data.tsv')).toBe('\t');
  });
});

describe('serializeCell', () => {
  it('quotes only when needed', () => {
    expect(serializeCell('plain', ',')).toBe('plain');
    expect(serializeCell('a,b', ',')).toBe('"a,b"');
    expect(serializeCell('a,b', ';')).toBe('a,b');
    expect(serializeCell('say "hi"', ',')).toBe('"say ""hi"""');
    expect(serializeCell('two\nlines', ',')).toBe('"two\nlines"');
    expect(serializeCell(' padded', ',')).toBe('" padded"');
  });
});

describe('editCells', () => {
  const text = 'name,city,note\n"Smith, J",London,"keeps ""quotes"""\nLi,Beijing,\n';

  it('replaces only the edited cell and leaves the rest of the file byte-identical', () => {
    const edits = editCells(ctx(text), [{ r: 2, c: 1, text: 'Shanghai' }]);
    expect(edits).toHaveLength(1);
    expect(text.slice(edits[0].start, edits[0].end)).toBe('Beijing');
    expect(applyEdits(text, edits)).toBe(text.replace('Beijing', 'Shanghai'));
  });

  it('quotes new values that need it', () => {
    const out = applyEdits(text, editCells(ctx(text), [{ r: 2, c: 2, text: 'a, "b"' }]));
    expect(cells(out)[2]).toEqual(['Li', 'Beijing', 'a, "b"']);
    expect(cells(out)[1]).toEqual(['Smith, J', 'London', 'keeps "quotes"']);
  });

  it('pads a short row when editing past its last cell', () => {
    const out = applyEdits('a,b,c\nx\n', editCells(ctx('a,b,c\nx\n'), [{ r: 1, c: 2, text: 'z' }]));
    expect(out).toBe('a,b,c\nx,,z\n');
  });

  it('appends rows when editing below the last record', () => {
    const out = applyEdits('a,b\n', editCells(ctx('a,b\n'), [{ r: 2, c: 1, text: 'new' }]));
    expect(out).toBe('a,b\n\n,new\n');
    const noTrailing = applyEdits('a,b', editCells(ctx('a,b'), [{ r: 1, c: 0, text: 'x' }]));
    expect(noTrailing).toBe('a,b\nx');
  });

  it('applies several changes at once', () => {
    const out = applyEdits(
      text,
      editCells(ctx(text), [
        { r: 0, c: 0, text: 'NAME' },
        { r: 1, c: 1, text: 'Paris' },
        { r: 2, c: 0, text: 'Wang' },
      ]),
    );
    expect(cells(out)).toEqual([
      ['NAME', 'city', 'note'],
      ['Smith, J', 'Paris', 'keeps "quotes"'],
      ['Wang', 'Beijing', ''],
    ]);
  });

  it('respects CRLF files', () => {
    const crlf = 'a,b\r\n1,2\r\n';
    const out = applyEdits(crlf, editCells(ctx(crlf, ',', '\r\n'), [{ r: 3, c: 0, text: 'x' }]));
    expect(out).toBe('a,b\r\n1,2\r\n\r\nx\r\n');
  });
});

describe('row and column operations', () => {
  const text = 'a,b,c\n1,2,3\n4,5,6\n';

  it('inserts and deletes rows', () => {
    expect(applyEdits(text, insertRows(ctx(text), 1, 1, 3))).toBe('a,b,c\n,,\n1,2,3\n4,5,6\n');
    expect(applyEdits(text, insertRows(ctx(text), 3, 1, 3))).toBe('a,b,c\n1,2,3\n4,5,6\n,,\n');
    expect(applyEdits(text, deleteRows(ctx(text), 1, 1))).toBe('a,b,c\n4,5,6\n');
    expect(applyEdits(text, deleteRows(ctx(text), 1, 5))).toBe('a,b,c\n');
    expect(applyEdits(text, deleteRows(ctx(text), 0, 3))).toBe('');
  });

  it('inserts and deletes columns', () => {
    expect(applyEdits(text, insertCols(ctx(text), 1, 1))).toBe('a,,b,c\n1,,2,3\n4,,5,6\n');
    expect(applyEdits(text, deleteCols(ctx(text), 1, 1))).toBe('a,c\n1,3\n4,6\n');
    expect(applyEdits(text, deleteCols(ctx(text), 2, 1))).toBe('a,b\n1,2\n4,5\n');
    expect(applyEdits(text, deleteCols(ctx(text), 0, 2))).toBe('c\n3\n6\n');
  });

  it('handles quoted cells when deleting a column', () => {
    const quoted = 'a,"x,y",c\n1,"p\nq",3\n';
    expect(applyEdits(quoted, deleteCols(ctx(quoted), 1, 1))).toBe('a,c\n1,3\n');
  });
});

describe('CsvSession', () => {
  it('answers an in-place edit with a row patch and a structural change with the full sheet', () => {
    const session = new CsvSession('data.csv', 'auto');
    expect(session.setText('a,b\n1,2\n3,4\n').type).toBe('sheet');

    const edited = applyEdits(session.currentText, session.editCells([{ r: 1, c: 1, text: '20' }]));
    const patch = session.setText(edited);
    expect(patch).toEqual({ type: 'rows', index: 0, rowCount: 3, colCount: 2, rows: [{ r: 1, cells: ['1', '20'] }] });

    const grown = applyEdits(session.currentText, session.structure('insertRow', 1, 1));
    const full = session.setText(grown);
    expect(full.type).toBe('sheet');
    expect(session.model().rowCount).toBe(4);
  });

  it('keeps the delimiter detected when the file was opened', () => {
    const session = new CsvSession('data.csv', 'auto');
    session.setText('a;b\n1;2\n');
    session.setText(applyEdits(session.currentText, session.editCells([{ r: 1, c: 0, text: 'x,y,z,w' }])));
    expect(session.currentDelimiter).toBe(';');
    expect(session.model().rows[1]).toEqual(['x,y,z,w', '2']);
  });

  it('incrementally updates large multi-row CSVs identically to a full parse', () => {
    const initial = Array.from({ length: 20 }, (_, i) => `row${i},val${i},note${i}`).join('\n') + '\n';
    const session = new CsvSession('big.csv', 'auto');
    session.setText(initial);

    const step = (nextText: string) => {
      const msg = session.setText(nextText);
      expect(session.model().rows).toEqual(cells(nextText));
      return msg;
    };

    // Single-cell in-place edit (including embedded delimiter & newline).
    const e1 = applyEdits(session.currentText, session.editCells([{ r: 10, c: 1, text: 'hello, "world"\nline2' }]));
    const m1 = step(e1);
    expect(m1.type).toBe('rows');

    // Identical text fast-path.
    expect(step(e1)).toEqual({ type: 'rows', index: 0, rowCount: 20, colCount: 3, rows: [] });

    // Row insertion and deletion.
    const e2 = applyEdits(session.currentText, session.structure('insertRow', 5, 2));
    expect(step(e2).type).toBe('sheet');
    const e3 = applyEdits(session.currentText, session.structure('deleteRows', 5, 2));
    expect(step(e3).type).toBe('sheet');

    // Unclosed quote injected mid-document falls back cleanly to full parse.
    const rawCorrupt = session.currentText.replace('val8', '"unclosed');
    step(rawCorrupt);
  });
});
