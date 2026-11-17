// Lightweight, zero-dependency Excel formula parser, evaluator, and reference shifter.
import { dateToSerial, formatNumber } from './reader';

export type ErrorCode = '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#N/A' | '#NUM!' | '#CYCLE!';

export class FormulaError {
  constructor(readonly code: ErrorCode) {}
}

export type ScalarValue = number | string | boolean | null | FormulaError;
export type EvalResult = ScalarValue | ScalarValue[][];

export interface FormulaContext {
  readonly currentSheet: number;
  sheetIndexByName(name: string): number;
  getCellValue(sheet: number, r: number, c: number): ScalarValue;
  getRangeValues(sheet: number, r0: number, c0: number, r1: number, c1: number): ScalarValue[][];
}

// ---------------------------------------------------------------- coordinate helpers

export function colToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
  }
  return n - 1;
}

export function indexToCol(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

const SIMPLE_SHEET_NAME = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_.\u0080-\uffff]*$/;
const LOOKS_LIKE_CELL = /^[A-Za-z]{1,3}\d+$/;

export function formatSheetPrefix(name: string): string {
  if (SIMPLE_SHEET_NAME.test(name) && !LOOKS_LIKE_CELL.test(name)) {
    return name;
  }
  return `'${name.replace(/'/g, "''")}'`;
}

function unquoteSheet(raw: string): string {
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

// ---------------------------------------------------------------- reference shifting & sheet renaming

/**
 * Matches strings ("..."), or optional sheet prefix + cell/range ref (`Sheet1!$A$1:$B$10`).
 * Group 1: string literal (preserved verbatim)
 * Group 2: sheet prefix without '!'
 * Group 3..6: start col$, col, row$, row
 * Group 7..10: end col$, col, row$, row (when range)
 */
const FORMULA_SCAN_RE =
  /("(?:""|[^"])*")|(?:('(?:''|[^'])*'|[A-Za-z0-9_.\u0080-\uffff]+)!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?/g;

function isWordBoundaryBefore(src: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const prev = src[index - 1];
  return !/[A-Za-z0-9_.\u0080-\uffff$']/.test(prev);
}

function isFunctionCallOrIdentifierAfter(src: string, endIndex: number): boolean {
  const next = src[endIndex];
  return next === '(' || (next !== undefined && /[A-Za-z0-9_.\u0080-\uffff]/.test(next));
}

function shiftAxis(
  pos: number,
  op: 'insert' | 'delete',
  at: number,
  count: number,
): number | 'deleted' {
  if (op === 'insert') {
    return pos >= at ? pos + count : pos;
  }
  if (pos < at) {
    return pos;
  }
  if (pos < at + count) {
    return 'deleted';
  }
  return pos - count;
}

function shiftRangeAxis(
  start: number,
  end: number,
  op: 'insert' | 'delete',
  at: number,
  count: number,
): [number, number] | 'deleted' {
  let lo = Math.min(start, end);
  let hi = Math.max(start, end);
  if (op === 'insert') {
    if (lo >= at) {
      lo += count;
      hi += count;
    } else if (hi >= at) {
      hi += count;
    }
    return start <= end ? [lo, hi] : [hi, lo];
  }
  // Delete [at, at + count)
  const delEnd = at + count - 1;
  if (hi < at) {
    return [start, end];
  }
  if (lo > delEnd) {
    return [start - count, end - count];
  }
  if (lo >= at && hi <= delEnd) {
    return 'deleted';
  }
  const newLo = lo < at ? lo : at;
  const newHi = hi > delEnd ? hi - count : at - 1;
  if (newLo > newHi) {
    return 'deleted';
  }
  return start <= end ? [newLo, newHi] : [newHi, newLo];
}

/**
 * Rewrites cell and range references inside `formula` when rows or columns are inserted or deleted
 * on `targetSheet`. Preserves string literals, whitespace, and `$` markers.
 */
export function shiftFormulaReferences(
  formula: string,
  targetSheet: string,
  currentSheet: string,
  op: 'insertRow' | 'deleteRows' | 'insertCol' | 'deleteCols',
  at: number,
  count: number,
): string {
  const targetLower = targetSheet.toLowerCase();
  const currentLower = currentSheet.toLowerCase();
  const isRow = op === 'insertRow' || op === 'deleteRows';
  const kind: 'insert' | 'delete' = op.startsWith('insert') ? 'insert' : 'delete';

  return formula.replace(
    FORMULA_SCAN_RE,
    (
      match,
      strLit: string | undefined,
      sheetRaw: string | undefined,
      c1Abs: string,
      c1Str: string,
      r1Abs: string,
      r1Str: string,
      c2Abs: string | undefined,
      c2Str: string | undefined,
      r2Abs: string | undefined,
      r2Str: string | undefined,
      offset: number,
    ) => {
      if (strLit !== undefined) {
        return match;
      }
      if (!isWordBoundaryBefore(formula, offset) || isFunctionCallOrIdentifierAfter(formula, offset + match.length)) {
        return match;
      }
      const refSheet = sheetRaw ? unquoteSheet(sheetRaw).toLowerCase() : currentLower;
      if (refSheet !== targetLower) {
        return match;
      }
      const c1 = colToIndex(c1Str);
      const r1 = Number(r1Str) - 1;
      if (r1 < 0 || c1 > 16383) {
        return match;
      }
      const prefix = sheetRaw ? `${sheetRaw}!` : '';

      if (c2Str !== undefined && r2Str !== undefined) {
        const c2 = colToIndex(c2Str);
        const r2 = Number(r2Str) - 1;
        if (r2 < 0 || c2 > 16383) {
          return match;
        }
        if (isRow) {
          const shifted = shiftRangeAxis(r1, r2, kind, at, count);
          if (shifted === 'deleted') {
            return '#REF!';
          }
          return `${prefix}${c1Abs}${c1Str}${r1Abs}${shifted[0] + 1}:${c2Abs ?? ''}${c2Str}${r2Abs ?? ''}${shifted[1] + 1}`;
        }
        const shifted = shiftRangeAxis(c1, c2, kind, at, count);
        if (shifted === 'deleted') {
          return '#REF!';
        }
        return `${prefix}${c1Abs}${indexToCol(shifted[0])}${r1Abs}${r1Str}:${c2Abs ?? ''}${indexToCol(shifted[1])}${r2Abs ?? ''}${r2Str}`;
      }

      if (isRow) {
        const nextR = shiftAxis(r1, kind, at, count);
        if (nextR === 'deleted') {
          return '#REF!';
        }
        return `${prefix}${c1Abs}${c1Str}${r1Abs}${nextR + 1}`;
      }
      const nextC = shiftAxis(c1, kind, at, count);
      if (nextC === 'deleted') {
        return '#REF!';
      }
      return `${prefix}${c1Abs}${indexToCol(nextC)}${r1Abs}${r1Str}`;
    },
  );
}

/** Rewrites cross-sheet references when a worksheet is renamed. */
export function renameSheetInFormula(formula: string, oldName: string, newName: string): string {
  const oldLower = oldName.toLowerCase();
  const formatted = formatSheetPrefix(newName);
  const sheetRefRe = /("(?:""|[^"])*")|('(?:''|[^'])*'|[A-Za-z0-9_.\u0080-\uffff]+)!/g;
  return formula.replace(sheetRefRe, (match, strLit: string | undefined, sheetRaw: string | undefined) => {
    if (strLit !== undefined || !sheetRaw) {
      return match;
    }
    if (unquoteSheet(sheetRaw).toLowerCase() === oldLower) {
      return `${formatted}!`;
    }
    return match;
  });
}

/** Materialises a shared formula for `(targetRow, targetCol)` from `(masterRow, masterCol)`. */
export function expandSharedFormula(
  masterFormula: string,
  masterRow: number,
  masterCol: number,
  targetRow: number,
  targetCol: number,
): string {
  const dr = targetRow - masterRow;
  const dc = targetCol - masterCol;
  if (dr === 0 && dc === 0) {
    return masterFormula;
  }
  return masterFormula.replace(
    FORMULA_SCAN_RE,
    (
      match,
      strLit: string | undefined,
      sheetRaw: string | undefined,
      c1Abs: string,
      c1Str: string,
      r1Abs: string,
      r1Str: string,
      c2Abs: string | undefined,
      c2Str: string | undefined,
      r2Abs: string | undefined,
      r2Str: string | undefined,
      offset: number,
    ) => {
      if (strLit !== undefined) {
        return match;
      }
      if (!isWordBoundaryBefore(masterFormula, offset) || isFunctionCallOrIdentifierAfter(masterFormula, offset + match.length)) {
        return match;
      }
      const c1 = colToIndex(c1Str) + (c1Abs ? 0 : dc);
      const r1 = Number(r1Str) - 1 + (r1Abs ? 0 : dr);
      if (c1 < 0 || r1 < 0) {
        return '#REF!';
      }
      const prefix = sheetRaw ? `${sheetRaw}!` : '';
      if (c2Str !== undefined && r2Str !== undefined) {
        const c2 = colToIndex(c2Str) + (c2Abs ? 0 : dc);
        const r2 = Number(r2Str) - 1 + (r2Abs ? 0 : dr);
        if (c2 < 0 || r2 < 0) {
          return '#REF!';
        }
        return `${prefix}${c1Abs}${indexToCol(c1)}${r1Abs}${r1 + 1}:${c2Abs ?? ''}${indexToCol(c2)}${r2Abs ?? ''}${r2 + 1}`;
      }
      return `${prefix}${c1Abs}${indexToCol(c1)}${r1Abs}${r1 + 1}`;
    },
  );
}

// ---------------------------------------------------------------- lexer & AST

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'err'; code: ErrorCode }
  | { kind: 'ident'; text: string }
  | { kind: 'sheet'; name: string }
  | { kind: 'op'; op: string }
  | { kind: 'punc'; ch: '(' | ')' | ',' | ';' | ':' };

const ERROR_CODES = new Set<string>(['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#N/A', '#NUM!', '#CYCLE!']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '"') {
      let val = '';
      i++;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            val += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        val += src[i++];
      }
      tokens.push({ kind: 'str', value: val });
      continue;
    }
    if (ch === "'") {
      let name = '';
      i++;
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            name += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        name += src[i++];
      }
      if (src[i] === '!') {
        i++;
        tokens.push({ kind: 'sheet', name });
        continue;
      }
      throw new FormulaError('#VALUE!');
    }
    if (ch === '#') {
      let end = i + 1;
      while (end < n && /[A-Za-z0-9/?!]/.test(src[end])) {
        end++;
        if (src[end - 1] === '!' || src[end - 1] === '?') {
          break;
        }
      }
      const raw = src.slice(i, end).toUpperCase();
      tokens.push({ kind: 'err', code: (ERROR_CODES.has(raw) ? raw : '#VALUE!') as ErrorCode });
      i = end;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (m) {
        tokens.push({ kind: 'num', value: Number(m[0]) });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '(' || ch === ')' || ch === ',' || ch === ';' || ch === ':') {
      tokens.push({ kind: 'punc', ch });
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      tokens.push({ kind: 'op', op: two });
      i += 2;
      continue;
    }
    if ('+-*/^&=%<>'.includes(ch)) {
      tokens.push({ kind: 'op', op: ch });
      i++;
      continue;
    }
    if (/[A-Za-z_$\u0080-\uffff]/.test(ch)) {
      let end = i + 1;
      while (end < n && /[A-Za-z0-9_.$\u0080-\uffff]/.test(src[end])) {
        end++;
      }
      const word = src.slice(i, end);
      if (src[end] === '!') {
        tokens.push({ kind: 'sheet', name: word });
        i = end + 1;
        continue;
      }
      const upper = word.toUpperCase();
      if ((upper === 'TRUE' || upper === 'FALSE') && src[end] !== '(') {
        tokens.push({ kind: 'bool', value: upper === 'TRUE' });
      } else {
        tokens.push({ kind: 'ident', text: word });
      }
      i = end;
      continue;
    }
    throw new FormulaError('#VALUE!');
  }
  return tokens;
}

type AstNode =
  | { type: 'scalar'; value: ScalarValue }
  | { type: 'cell'; sheet?: string; r: number; c: number }
  | { type: 'range'; sheet?: string; r0: number; c0: number; r1: number; c1: number }
  | { type: 'unary'; op: '+' | '-'; arg: AstNode }
  | { type: 'percent'; arg: AstNode }
  | { type: 'binary'; op: string; left: AstNode; right: AstNode }
  | { type: 'call'; name: string; args: AstNode[] };

function parseCellToken(text: string): { r: number; c: number } | undefined {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(text);
  if (!m) {
    return undefined;
  }
  const c = colToIndex(m[1]);
  const r = Number(m[2]) - 1;
  if (r < 0 || c > 16383) {
    return undefined;
  }
  return { r, c };
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parse(): AstNode {
    if (!this.tokens.length) {
      return { type: 'scalar', value: null };
    }
    const expr = this.parseComparison();
    if (this.pos < this.tokens.length) {
      throw new FormulaError('#VALUE!');
    }
    return expr;
  }

  private parseComparison(): AstNode {
    let left = this.parseConcat();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && (t.op === '=' || t.op === '<>' || t.op === '<' || t.op === '<=' || t.op === '>' || t.op === '>=')) {
        this.next();
        left = { type: 'binary', op: t.op, left, right: this.parseConcat() };
      } else {
        return left;
      }
    }
  }

  private parseConcat(): AstNode {
    let left = this.parseAdd();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && t.op === '&') {
        this.next();
        left = { type: 'binary', op: '&', left, right: this.parseAdd() };
      } else {
        return left;
      }
    }
  }

  private parseAdd(): AstNode {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && (t.op === '+' || t.op === '-')) {
        this.next();
        left = { type: 'binary', op: t.op, left, right: this.parseMul() };
      } else {
        return left;
      }
    }
  }

  private parseMul(): AstNode {
    let left = this.parsePow();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && (t.op === '*' || t.op === '/')) {
        this.next();
        left = { type: 'binary', op: t.op, left, right: this.parsePow() };
      } else {
        return left;
      }
    }
  }

  private parsePow(): AstNode {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op' && t.op === '^') {
        this.next();
        left = { type: 'binary', op: '^', left, right: this.parseUnary() };
      } else {
        return left;
      }
    }
  }

  private parseUnary(): AstNode {
    const t = this.peek();
    if (t?.kind === 'op' && (t.op === '+' || t.op === '-')) {
      this.next();
      return { type: 'unary', op: t.op, arg: this.parseUnary() };
    }
    let primary = this.parsePrimary();
    while (this.peek()?.kind === 'op' && (this.peek() as { kind: 'op'; op: string }).op === '%') {
      this.next();
      primary = { type: 'percent', arg: primary };
    }
    return primary;
  }

  private parsePrimary(): AstNode {
    const t = this.next();
    if (!t) {
      throw new FormulaError('#VALUE!');
    }
    if (t.kind === 'num' || t.kind === 'str' || t.kind === 'bool') {
      return { type: 'scalar', value: t.value };
    }
    if (t.kind === 'err') {
      return { type: 'scalar', value: new FormulaError(t.code) };
    }
    if (t.kind === 'punc' && t.ch === '(') {
      const inner = this.parseComparison();
      const close = this.next();
      if (!close || close.kind !== 'punc' || close.ch !== ')') {
        throw new FormulaError('#VALUE!');
      }
      return inner;
    }
    if (t.kind === 'sheet') {
      const id = this.next();
      if (!id || id.kind !== 'ident') {
        if (id?.kind === 'err') {
          return { type: 'scalar', value: new FormulaError(id.code) };
        }
        throw new FormulaError('#REF!');
      }
      return this.parseRefTail(t.name, id.text);
    }
    if (t.kind === 'ident') {
      const next = this.peek();
      if (next?.kind === 'punc' && next.ch === '(') {
        this.next();
        const args: AstNode[] = [];
        if (!(this.peek()?.kind === 'punc' && (this.peek() as { kind: 'punc'; ch: string }).ch === ')')) {
          for (;;) {
            const p = this.peek();
            if (p?.kind === 'punc' && (p.ch === ',' || p.ch === ';' || p.ch === ')')) {
              args.push({ type: 'scalar', value: null });
            } else {
              args.push(this.parseComparison());
            }
            const sep = this.peek();
            if (sep?.kind === 'punc' && (sep.ch === ',' || sep.ch === ';')) {
              this.next();
              continue;
            }
            break;
          }
        }
        const close = this.next();
        if (!close || close.kind !== 'punc' || close.ch !== ')') {
          throw new FormulaError('#VALUE!');
        }
        // Strip Excel `_xlfn.` prefix on modern functions like `_xlfn.XLOOKUP`.
        const fnName = t.text.toUpperCase().replace(/^_XLFN\.(?:_XLWS\.)?/, '');
        return { type: 'call', name: fnName, args };
      }
      return this.parseRefTail(undefined, t.text);
    }
    throw new FormulaError('#VALUE!');
  }

  private parseRefTail(sheet: string | undefined, firstIdent: string): AstNode {
    const start = parseCellToken(firstIdent);
    if (!start) {
      return { type: 'scalar', value: new FormulaError('#NAME?') };
    }
    const next = this.peek();
    if (next?.kind === 'punc' && next.ch === ':') {
      this.next();
      let endToken = this.next();
      // Allow `Sheet1!A1:Sheet1!B5` as well as `Sheet1!A1:B5`.
      if (endToken?.kind === 'sheet') {
        endToken = this.next();
      }
      if (!endToken || endToken.kind !== 'ident') {
        return { type: 'scalar', value: new FormulaError('#REF!') };
      }
      const end = parseCellToken(endToken.text);
      if (!end) {
        return { type: 'scalar', value: new FormulaError('#NAME?') };
      }
      return {
        type: 'range',
        sheet,
        r0: Math.min(start.r, end.r),
        c0: Math.min(start.c, end.c),
        r1: Math.max(start.r, end.r),
        c1: Math.max(start.c, end.c),
      };
    }
    return { type: 'cell', sheet, r: start.r, c: start.c };
  }
}

// ---------------------------------------------------------------- evaluation helpers

function toScalar(v: EvalResult): ScalarValue {
  if (Array.isArray(v)) {
    return v[0]?.[0] ?? null;
  }
  return v;
}

function toNumber(v: ScalarValue): number {
  if (v instanceof FormulaError) {
    throw v;
  }
  if (v === null) {
    return 0;
  }
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'boolean') {
    return v ? 1 : 0;
  }
  const trimmed = v.trim();
  if (!trimmed) {
    throw new FormulaError('#VALUE!');
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    throw new FormulaError('#VALUE!');
  }
  return num;
}

function toStringVal(v: ScalarValue): string {
  if (v instanceof FormulaError) {
    throw v;
  }
  if (v === null) {
    return '';
  }
  if (typeof v === 'boolean') {
    return v ? 'TRUE' : 'FALSE';
  }
  return String(v);
}

function toBool(v: ScalarValue): boolean {
  if (v instanceof FormulaError) {
    throw v;
  }
  if (typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'number') {
    return v !== 0;
  }
  if (v === null) {
    return false;
  }
  const u = v.trim().toUpperCase();
  if (u === 'TRUE') {
    return true;
  }
  if (u === 'FALSE') {
    return false;
  }
  throw new FormulaError('#VALUE!');
}

function flattenValues(args: EvalResult[]): ScalarValue[] {
  const out: ScalarValue[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const row of arg) {
        for (const cell of row) {
          out.push(cell);
        }
      }
    } else {
      out.push(arg);
    }
  }
  return out;
}

/** Collects numbers for aggregate functions (SUM, AVERAGE, MIN, MAX): range strings/booleans/blanks are ignored, direct scalar args coerce. */
function collectNumbers(args: EvalResult[]): number[] {
  const nums: number[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const row of arg) {
        for (const cell of row) {
          if (cell instanceof FormulaError) {
            throw cell;
          }
          if (typeof cell === 'number') {
            nums.push(cell);
          }
        }
      }
    } else {
      if (arg instanceof FormulaError) {
        throw arg;
      }
      if (arg !== null) {
        nums.push(toNumber(arg));
      }
    }
  }
  return nums;
}

function compareScalars(a: ScalarValue, b: ScalarValue): number {
  if (a instanceof FormulaError) {
    throw a;
  }
  if (b instanceof FormulaError) {
    throw b;
  }
  // Empty coerces to 0 against number, "" against string, FALSE against boolean.
  const left = a === null ? (typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0) : a;
  const right = b === null ? (typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0) : b;
  if (typeof left === typeof right) {
    if (typeof left === 'number') {
      return left - (right as number);
    }
    if (typeof left === 'string') {
      const la = left.toLowerCase();
      const rb = (right as string).toLowerCase();
      return la < rb ? -1 : la > rb ? 1 : 0;
    }
    if (typeof left === 'boolean') {
      return (left ? 1 : 0) - ((right as boolean) ? 1 : 0);
    }
  }
  // Excel cross-type order: number < string < boolean
  const rank = (x: unknown) => (typeof x === 'number' ? 1 : typeof x === 'string' ? 2 : 3);
  return rank(left) - rank(right);
}

function matchesCriteria(cell: ScalarValue, criteria: ScalarValue): boolean {
  if (criteria instanceof FormulaError || cell instanceof FormulaError) {
    return false;
  }
  if (typeof criteria === 'number' || typeof criteria === 'boolean') {
    return cell !== null && compareScalars(cell, criteria) === 0;
  }
  const crit = criteria === null ? '' : String(criteria);
  const opMatch = /^(<=|>=|<>|<|>|=)(.*)$/.exec(crit);
  const op = opMatch ? opMatch[1] : '=';
  const rhsRaw = opMatch ? opMatch[2] : crit;

  if (rhsRaw === '') {
    const empty = cell === null || cell === '';
    return op === '<>' ? !empty : op === '=' ? empty : false;
  }
  const rhsNum = Number(rhsRaw);
  const target: ScalarValue =
    rhsRaw.trim() !== '' && Number.isFinite(rhsNum)
      ? rhsNum
      : rhsRaw.toUpperCase() === 'TRUE'
        ? true
        : rhsRaw.toUpperCase() === 'FALSE'
          ? false
          : rhsRaw;

  // Wildcard matching (* and ?) for equality on strings.
  if (typeof target === 'string' && (op === '=' || op === '<>') && /[*?]/.test(target)) {
    const pattern =
      '^' +
      target
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$';
    const ok = new RegExp(pattern, 'i').test(cell === null ? '' : String(cell));
    return op === '=' ? ok : !ok;
  }

  if (cell === null) {
    return op === '<>';
  }
  if (typeof target === 'number' && typeof cell !== 'number') {
    return op === '<>';
  }
  const cmp = compareScalars(cell, target);
  switch (op) {
    case '=':
      return cmp === 0;
    case '<>':
      return cmp !== 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    default:
      return false;
  }
}

function serialToUtcDate(serial: number): Date {
  const adjusted = serial < 60 ? serial + 1 : serial;
  return new Date(Math.round((adjusted - 25569) * 86_400_000));
}

function evalNode(node: AstNode, ctx: FormulaContext): EvalResult {
  switch (node.type) {
    case 'scalar':
      return node.value;
    case 'cell': {
      const sheetIdx = node.sheet !== undefined ? ctx.sheetIndexByName(node.sheet) : ctx.currentSheet;
      if (sheetIdx < 0) {
        return new FormulaError('#REF!');
      }
      return ctx.getCellValue(sheetIdx, node.r, node.c);
    }
    case 'range': {
      const sheetIdx = node.sheet !== undefined ? ctx.sheetIndexByName(node.sheet) : ctx.currentSheet;
      if (sheetIdx < 0) {
        return new FormulaError('#REF!');
      }
      return ctx.getRangeValues(sheetIdx, node.r0, node.c0, node.r1, node.c1);
    }
    case 'unary': {
      const v = toNumber(toScalar(evalNode(node.arg, ctx)));
      return node.op === '-' ? -v : v;
    }
    case 'percent': {
      return toNumber(toScalar(evalNode(node.arg, ctx))) / 100;
    }
    case 'binary': {
      const l = toScalar(evalNode(node.left, ctx));
      const r = toScalar(evalNode(node.right, ctx));
      if (l instanceof FormulaError) {
        return l;
      }
      if (r instanceof FormulaError) {
        return r;
      }
      switch (node.op) {
        case '+':
          return toNumber(l) + toNumber(r);
        case '-':
          return toNumber(l) - toNumber(r);
        case '*':
          return toNumber(l) * toNumber(r);
        case '/': {
          const denom = toNumber(r);
          if (denom === 0) {
            return new FormulaError('#DIV/0!');
          }
          return toNumber(l) / denom;
        }
        case '^': {
          const res = Math.pow(toNumber(l), toNumber(r));
          return Number.isFinite(res) ? res : new FormulaError('#NUM!');
        }
        case '&':
          return toStringVal(l) + toStringVal(r);
        case '=':
          return compareScalars(l, r) === 0;
        case '<>':
          return compareScalars(l, r) !== 0;
        case '<':
          return compareScalars(l, r) < 0;
        case '<=':
          return compareScalars(l, r) <= 0;
        case '>':
          return compareScalars(l, r) > 0;
        case '>=':
          return compareScalars(l, r) >= 0;
      }
      return new FormulaError('#VALUE!');
    }
    case 'call':
      return evalFunction(node.name, node.args, ctx);
  }
}

function evalFunction(name: string, args: AstNode[], ctx: FormulaContext): EvalResult {
  const evalArg = (i: number): EvalResult => (i < args.length ? evalNode(args[i], ctx) : null);
  const scalarArg = (i: number): ScalarValue => toScalar(evalArg(i));
  const numArg = (i: number, fallback?: number): number => {
    if (i >= args.length && fallback !== undefined) {
      return fallback;
    }
    return toNumber(scalarArg(i));
  };
  const strArg = (i: number, fallback = ''): string => (i >= args.length ? fallback : toStringVal(scalarArg(i)));

  switch (name) {
    // ---- Conditional / short-circuiting functions
    case 'IF': {
      if (args.length < 2) {
        return new FormulaError('#VALUE!');
      }
      const cond = toBool(scalarArg(0));
      return cond ? evalArg(1) : args.length >= 3 ? evalArg(2) : false;
    }
    case 'IFS': {
      for (let i = 0; i + 1 < args.length; i += 2) {
        if (toBool(scalarArg(i))) {
          return evalArg(i + 1);
        }
      }
      return new FormulaError('#N/A');
    }
    case 'IFERROR': {
      if (args.length < 2) {
        return new FormulaError('#VALUE!');
      }
      try {
        const v = scalarArg(0);
        return v instanceof FormulaError ? evalArg(1) : v;
      } catch (e) {
        if (e instanceof FormulaError) {
          return evalArg(1);
        }
        throw e;
      }
    }
    case 'IFNA': {
      if (args.length < 2) {
        return new FormulaError('#VALUE!');
      }
      try {
        const v = scalarArg(0);
        return v instanceof FormulaError && v.code === '#N/A' ? evalArg(1) : v;
      } catch (e) {
        if (e instanceof FormulaError && e.code === '#N/A') {
          return evalArg(1);
        }
        throw e;
      }
    }
    case 'CHOOSE': {
      const idx = Math.trunc(numArg(0));
      if (idx < 1 || idx >= args.length) {
        return new FormulaError('#VALUE!');
      }
      return evalArg(idx);
    }

    // ---- Logical & inspection
    case 'AND':
    case 'OR':
    case 'XOR': {
      const flat = flattenValues(args.map((_, i) => evalArg(i)));
      const bools: boolean[] = [];
      for (const v of flat) {
        if (v instanceof FormulaError) {
          return v;
        }
        if (typeof v === 'boolean') {
          bools.push(v);
        } else if (typeof v === 'number') {
          bools.push(v !== 0);
        }
      }
      if (!bools.length) {
        return new FormulaError('#VALUE!');
      }
      if (name === 'AND') {
        return bools.every(Boolean);
      }
      if (name === 'OR') {
        return bools.some(Boolean);
      }
      return bools.filter(Boolean).length % 2 === 1;
    }
    case 'NOT':
      return !toBool(scalarArg(0));
    case 'ISBLANK':
      return scalarArg(0) === null;
    case 'ISNUMBER':
      return typeof scalarArg(0) === 'number';
    case 'ISTEXT':
      return typeof scalarArg(0) === 'string';
    case 'ISLOGICAL':
      return typeof scalarArg(0) === 'boolean';
    case 'ISERROR': {
      try {
        return scalarArg(0) instanceof FormulaError;
      } catch (e) {
        return e instanceof FormulaError;
      }
    }
    case 'ISNA': {
      try {
        const v = scalarArg(0);
        return v instanceof FormulaError && v.code === '#N/A';
      } catch (e) {
        return e instanceof FormulaError && e.code === '#N/A';
      }
    }

    // ---- Math & statistical aggregates
    case 'SUM':
      return collectNumbers(args.map((_, i) => evalArg(i))).reduce((a, b) => a + b, 0);
    case 'PRODUCT': {
      const nums = collectNumbers(args.map((_, i) => evalArg(i)));
      return nums.length ? nums.reduce((a, b) => a * b, 1) : 0;
    }
    case 'AVERAGE': {
      const nums = collectNumbers(args.map((_, i) => evalArg(i)));
      if (!nums.length) {
        return new FormulaError('#DIV/0!');
      }
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    case 'MIN': {
      const nums = collectNumbers(args.map((_, i) => evalArg(i)));
      return nums.length ? Math.min(...nums) : 0;
    }
    case 'MAX': {
      const nums = collectNumbers(args.map((_, i) => evalArg(i)));
      return nums.length ? Math.max(...nums) : 0;
    }
    case 'MEDIAN': {
      const nums = collectNumbers(args.map((_, i) => evalArg(i))).sort((a, b) => a - b);
      if (!nums.length) {
        return new FormulaError('#NUM!');
      }
      const mid = nums.length >> 1;
      return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
    }
    case 'COUNT': {
      const flat = flattenValues(args.map((_, i) => evalArg(i)));
      return flat.filter((v) => typeof v === 'number').length;
    }
    case 'COUNTA': {
      const flat = flattenValues(args.map((_, i) => evalArg(i)));
      return flat.filter((v) => v !== null).length;
    }
    case 'COUNTBLANK': {
      const flat = flattenValues(args.map((_, i) => evalArg(i)));
      return flat.filter((v) => v === null || v === '').length;
    }
    case 'SUMPRODUCT': {
      if (!args.length) {
        return new FormulaError('#VALUE!');
      }
      const matrices = args.map((_, i) => {
        const v = evalArg(i);
        return Array.isArray(v) ? v : [[v]];
      });
      const rows = matrices[0].length;
      const cols = matrices[0][0]?.length ?? 0;
      if (matrices.some((m) => m.length !== rows || (m[0]?.length ?? 0) !== cols)) {
        return new FormulaError('#VALUE!');
      }
      let sum = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let prod = 1;
          for (const m of matrices) {
            const cell = m[r][c];
            if (cell instanceof FormulaError) {
              return cell;
            }
            prod *= typeof cell === 'number' ? cell : 0;
          }
          sum += prod;
        }
      }
      return sum;
    }

    // ---- Conditional aggregates (SUMIF, COUNTIF, AVERAGEIF)
    case 'COUNTIF': {
      const range = evalArg(0);
      const crit = scalarArg(1);
      const grid = Array.isArray(range) ? range : [[range]];
      let count = 0;
      for (const row of grid) {
        for (const cell of row) {
          if (matchesCriteria(cell, crit)) {
            count++;
          }
        }
      }
      return count;
    }
    case 'SUMIF':
    case 'AVERAGEIF': {
      const rawRange = evalArg(0);
      const crit = scalarArg(1);
      const rawSumRange = args.length >= 3 ? evalArg(2) : rawRange;
      const grid = Array.isArray(rawRange) ? rawRange : [[rawRange]];
      const sumGrid = Array.isArray(rawSumRange) ? rawSumRange : [[rawSumRange]];
      let sum = 0;
      let count = 0;
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
          if (matchesCriteria(grid[r][c], crit)) {
            const target = sumGrid[r]?.[c];
            if (target instanceof FormulaError) {
              return target;
            }
            if (typeof target === 'number') {
              sum += target;
              count++;
            }
          }
        }
      }
      if (name === 'AVERAGEIF') {
        return count === 0 ? new FormulaError('#DIV/0!') : sum / count;
      }
      return sum;
    }

    // ---- Lookup functions
    case 'VLOOKUP': {
      const needle = scalarArg(0);
      const table = evalArg(1);
      const colIdx = Math.trunc(numArg(2)) - 1;
      const approx = args.length >= 4 ? toBool(scalarArg(3)) : true;
      if (!Array.isArray(table) || colIdx < 0 || colIdx >= (table[0]?.length ?? 0)) {
        return new FormulaError('#REF!');
      }
      let bestRow = -1;
      for (let r = 0; r < table.length; r++) {
        const candidate = table[r][0];
        if (candidate === null || candidate instanceof FormulaError) {
          continue;
        }
        const cmp = compareScalars(candidate, needle);
        if (cmp === 0) {
          return table[r][colIdx] ?? 0;
        }
        if (approx && typeof candidate === typeof needle && cmp < 0) {
          bestRow = r;
        }
      }
      return approx && bestRow >= 0 ? (table[bestRow][colIdx] ?? 0) : new FormulaError('#N/A');
    }
    case 'HLOOKUP': {
      const needle = scalarArg(0);
      const table = evalArg(1);
      const rowIdx = Math.trunc(numArg(2)) - 1;
      const approx = args.length >= 4 ? toBool(scalarArg(3)) : true;
      if (!Array.isArray(table) || rowIdx < 0 || rowIdx >= table.length) {
        return new FormulaError('#REF!');
      }
      const firstRow = table[0] ?? [];
      let bestCol = -1;
      for (let c = 0; c < firstRow.length; c++) {
        const candidate = firstRow[c];
        if (candidate === null || candidate instanceof FormulaError) {
          continue;
        }
        const cmp = compareScalars(candidate, needle);
        if (cmp === 0) {
          return table[rowIdx][c] ?? 0;
        }
        if (approx && typeof candidate === typeof needle && cmp < 0) {
          bestCol = c;
        }
      }
      return approx && bestCol >= 0 ? (table[rowIdx][bestCol] ?? 0) : new FormulaError('#N/A');
    }
    case 'XLOOKUP': {
      const needle = scalarArg(0);
      const lookupFlat = flattenValues([evalArg(1)]);
      const returnFlat = flattenValues([evalArg(2)]);
      const notFound = args.length >= 4 ? scalarArg(3) : new FormulaError('#N/A');
      if (lookupFlat.length !== returnFlat.length) {
        return new FormulaError('#VALUE!');
      }
      for (let i = 0; i < lookupFlat.length; i++) {
        const candidate = lookupFlat[i];
        if (!(candidate instanceof FormulaError) && compareScalars(candidate, needle) === 0) {
          return returnFlat[i] ?? 0;
        }
      }
      return notFound;
    }
    case 'INDEX': {
      const arr = evalArg(0);
      const grid = Array.isArray(arr) ? arr : [[arr]];
      const r = Math.trunc(numArg(1, 1)) - 1;
      const c = args.length >= 3 ? Math.trunc(numArg(2, 1)) - 1 : grid.length === 1 ? r : 0;
      const row = args.length < 3 && grid.length === 1 ? 0 : r;
      if (row < 0 || row >= grid.length || c < 0 || c >= (grid[0]?.length ?? 0)) {
        return new FormulaError('#REF!');
      }
      return grid[row][c] ?? 0;
    }
    case 'MATCH': {
      const needle = scalarArg(0);
      const flat = flattenValues([evalArg(1)]);
      const matchType = args.length >= 3 ? Math.trunc(numArg(2, 1)) : 1;
      let best = -1;
      for (let i = 0; i < flat.length; i++) {
        const item = flat[i];
        if (item === null || item instanceof FormulaError) {
          continue;
        }
        const cmp = compareScalars(item, needle);
        if (cmp === 0) {
          return i + 1;
        }
        if (matchType === 1 && typeof item === typeof needle && cmp < 0) {
          best = i;
        } else if (matchType === -1 && typeof item === typeof needle && cmp > 0) {
          best = i;
        }
      }
      return best >= 0 ? best + 1 : new FormulaError('#N/A');
    }
    case 'ROWS': {
      const v = evalArg(0);
      return Array.isArray(v) ? v.length : 1;
    }
    case 'COLUMNS': {
      const v = evalArg(0);
      return Array.isArray(v) ? (v[0]?.length ?? 1) : 1;
    }

    // ---- Scalar math functions
    case 'ABS':
      return Math.abs(numArg(0));
    case 'SIGN':
      return Math.sign(numArg(0));
    case 'INT':
      return Math.floor(numArg(0));
    case 'TRUNC': {
      const n = numArg(0);
      const d = Math.trunc(numArg(1, 0));
      const f = Math.pow(10, d);
      return Math.trunc(n * f) / f;
    }
    case 'ROUND': {
      const n = numArg(0);
      const d = Math.trunc(numArg(1, 0));
      const f = Math.pow(10, d);
      return (Math.sign(n) * Math.round(Math.abs(n) * f)) / f;
    }
    case 'ROUNDUP': {
      const n = numArg(0);
      const d = Math.trunc(numArg(1, 0));
      const f = Math.pow(10, d);
      return (Math.sign(n) * Math.ceil(Math.abs(n) * f - 1e-12)) / f;
    }
    case 'ROUNDDOWN': {
      const n = numArg(0);
      const d = Math.trunc(numArg(1, 0));
      const f = Math.pow(10, d);
      return (Math.sign(n) * Math.floor(Math.abs(n) * f + 1e-12)) / f;
    }
    case 'CEILING': {
      const n = numArg(0);
      const sig = numArg(1, 1);
      return sig === 0 ? 0 : Math.ceil(n / sig) * sig;
    }
    case 'FLOOR': {
      const n = numArg(0);
      const sig = numArg(1, 1);
      if (sig === 0) {
        return new FormulaError('#DIV/0!');
      }
      return Math.floor(n / sig) * sig;
    }
    case 'MOD': {
      const n = numArg(0);
      const d = numArg(1);
      if (d === 0) {
        return new FormulaError('#DIV/0!');
      }
      return n - d * Math.floor(n / d);
    }
    case 'POWER': {
      const res = Math.pow(numArg(0), numArg(1));
      return Number.isFinite(res) ? res : new FormulaError('#NUM!');
    }
    case 'SQRT': {
      const n = numArg(0);
      return n < 0 ? new FormulaError('#NUM!') : Math.sqrt(n);
    }
    case 'EXP':
      return Math.exp(numArg(0));
    case 'LN': {
      const n = numArg(0);
      return n <= 0 ? new FormulaError('#NUM!') : Math.log(n);
    }
    case 'LOG10': {
      const n = numArg(0);
      return n <= 0 ? new FormulaError('#NUM!') : Math.log10(n);
    }
    case 'LOG': {
      const n = numArg(0);
      const base = numArg(1, 10);
      return n <= 0 || base <= 0 || base === 1 ? new FormulaError('#NUM!') : Math.log(n) / Math.log(base);
    }
    case 'PI':
      return Math.PI;
    case 'RAND':
      return Math.random();

    // ---- Text functions
    case 'CONCAT':
    case 'CONCATENATE':
      return flattenValues(args.map((_, i) => evalArg(i)))
        .map((v) => toStringVal(v))
        .join('');
    case 'LEN':
      return strArg(0).length;
    case 'LOWER':
      return strArg(0).toLowerCase();
    case 'UPPER':
      return strArg(0).toUpperCase();
    case 'PROPER':
      return strArg(0).toLowerCase().replace(/(?:^|[^a-zA-Z])([a-zA-Z])/g, (m) => m.toUpperCase());
    case 'TRIM':
      return strArg(0).trim().replace(/ +/g, ' ');
    case 'LEFT': {
      const s = strArg(0);
      const k = Math.trunc(numArg(1, 1));
      return k < 0 ? new FormulaError('#VALUE!') : s.slice(0, k);
    }
    case 'RIGHT': {
      const s = strArg(0);
      const k = Math.trunc(numArg(1, 1));
      return k < 0 ? new FormulaError('#VALUE!') : k === 0 ? '' : s.slice(-k);
    }
    case 'MID': {
      const s = strArg(0);
      const start = Math.trunc(numArg(1)) - 1;
      const len = Math.trunc(numArg(2));
      return start < 0 || len < 0 ? new FormulaError('#VALUE!') : s.slice(start, start + len);
    }
    case 'REPT': {
      const s = strArg(0);
      const count = Math.trunc(numArg(1));
      return count < 0 || s.length * count > 32767 ? new FormulaError('#VALUE!') : s.repeat(count);
    }
    case 'EXACT':
      return strArg(0) === strArg(1);
    case 'SUBSTITUTE': {
      const text = strArg(0);
      const oldText = strArg(1);
      const newText = strArg(2);
      if (!oldText) {
        return text;
      }
      if (args.length >= 4) {
        const instance = Math.trunc(numArg(3));
        if (instance < 1) {
          return new FormulaError('#VALUE!');
        }
        let seen = 0;
        let idx = 0;
        let out = '';
        for (;;) {
          const found = text.indexOf(oldText, idx);
          if (found < 0) {
            out += text.slice(idx);
            break;
          }
          seen++;
          if (seen === instance) {
            out += text.slice(idx, found) + newText + text.slice(found + oldText.length);
            break;
          }
          out += text.slice(idx, found + oldText.length);
          idx = found + oldText.length;
        }
        return out;
      }
      return text.split(oldText).join(newText);
    }
    case 'REPLACE': {
      const text = strArg(0);
      const start = Math.trunc(numArg(1)) - 1;
      const count = Math.trunc(numArg(2));
      const next = strArg(3);
      if (start < 0 || count < 0) {
        return new FormulaError('#VALUE!');
      }
      return text.slice(0, start) + next + text.slice(start + count);
    }
    case 'FIND':
    case 'SEARCH': {
      const needle = strArg(0);
      const hay = strArg(1);
      const start = Math.trunc(numArg(2, 1)) - 1;
      if (start < 0 || start > hay.length) {
        return new FormulaError('#VALUE!');
      }
      const pos =
        name === 'FIND'
          ? hay.indexOf(needle, start)
          : hay.toLowerCase().indexOf(needle.toLowerCase(), start);
      return pos < 0 ? new FormulaError('#VALUE!') : pos + 1;
    }
    case 'VALUE':
      return toNumber(strArg(0));
    case 'TEXT':
      return formatNumber(numArg(0), strArg(1));

    // ---- Date functions
    case 'TODAY': {
      const now = new Date();
      return dateToSerial(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
    }
    case 'NOW': {
      const now = new Date();
      const utc = Date.UTC(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        now.getHours(),
        now.getMinutes(),
        now.getSeconds(),
      );
      return dateToSerial(new Date(utc));
    }
    case 'DATE':
      return dateToSerial(new Date(Date.UTC(Math.trunc(numArg(0)), Math.trunc(numArg(1)) - 1, Math.trunc(numArg(2)))));
    case 'YEAR':
      return serialToUtcDate(numArg(0)).getUTCFullYear();
    case 'MONTH':
      return serialToUtcDate(numArg(0)).getUTCMonth() + 1;
    case 'DAY':
      return serialToUtcDate(numArg(0)).getUTCDate();

    default:
      return new FormulaError('#NAME?');
  }
}

const astCache = new Map<string, AstNode | FormulaError>();

function parseCached(formula: string): AstNode {
  let ast = astCache.get(formula);
  if (!ast) {
    try {
      ast = new Parser(tokenize(formula)).parse();
    } catch (e) {
      ast = e instanceof FormulaError ? e : new FormulaError('#VALUE!');
    }
    if (astCache.size >= 4000) {
      astCache.clear();
    }
    astCache.set(formula, ast);
  }
  if (ast instanceof FormulaError) {
    throw ast;
  }
  return ast;
}

/** Evaluates an Excel formula body (without the leading `=`). Never throws: errors return `FormulaError`. */
export function evaluateFormula(formula: string, ctx: FormulaContext): ScalarValue {
  try {
    return toScalar(evalNode(parseCached(formula), ctx));
  } catch (e) {
    return e instanceof FormulaError ? e : new FormulaError('#VALUE!');
  }
}
