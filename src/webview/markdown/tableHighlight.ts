// Row/column highlight for tables in the Markdown preview: hovering a cell marks its row,
// its column (colspan-aware) and the cell itself. Styling lives in markdown.css and only
// applies while the body has the dv-highlight class.

const ROW = 'md-hl-row';
const COL = 'md-hl-col';
const CELL = 'md-hl-cell';

/** Column range [start, end] that a cell covers in its row, counting colspans. */
function columnRange(cell: HTMLTableCellElement): [number, number] {
  let start = 0;
  for (const sibling of (cell.parentElement as HTMLTableRowElement).cells) {
    if (sibling === cell) {
      break;
    }
    start += sibling.colSpan || 1;
  }
  return [start, start + (cell.colSpan || 1) - 1];
}

export class TableHighlighter {
  private marked: Element[] = [];
  private current: HTMLTableCellElement | undefined;

  /** Highlights the row and column of `cell`; does nothing if it is already highlighted. */
  highlight(cell: HTMLTableCellElement): void {
    if (cell === this.current) {
      return;
    }
    this.clear();
    const table = cell.closest('table');
    const row = cell.parentElement as HTMLTableRowElement | null;
    if (!table || !row) {
      return;
    }
    this.current = cell;
    const [from, to] = columnRange(cell);
    for (const tr of table.rows) {
      // Only rows of this table, not of a table nested inside one of its cells.
      if (tr.closest('table') !== table) {
        continue;
      }
      let col = 0;
      for (const td of tr.cells) {
        const span = td.colSpan || 1;
        if (col <= to && col + span - 1 >= from) {
          this.mark(td, COL);
        }
        col += span;
      }
    }
    this.mark(row, ROW);
    this.mark(cell, CELL);
  }

  clear(): void {
    for (const node of this.marked) {
      node.classList.remove(ROW, COL, CELL);
    }
    this.marked = [];
    this.current = undefined;
  }

  private mark(node: Element, cls: string): void {
    node.classList.add(cls);
    this.marked.push(node);
  }
}

/**
 * Wires hover highlighting to a container. `enabled` is checked on every move, so the
 * toolbar switch takes effect immediately.
 */
export function attachTableHighlight(container: HTMLElement, enabled: () => boolean): TableHighlighter {
  const highlighter = new TableHighlighter();
  container.addEventListener('mouseover', (event) => {
    const cell = (event.target as Element | null)?.closest?.('td, th') as HTMLTableCellElement | null;
    if (!enabled() || !cell || !container.contains(cell)) {
      highlighter.clear();
      return;
    }
    highlighter.highlight(cell);
  });
  container.addEventListener('mouseleave', () => highlighter.clear());
  return highlighter;
}
