'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  autoColumnWidth, cellInRange, compareCells, detectCsvFormat, looksLikeHeader, normalizeCellRange,
  numericValue, parseClipboard, parseCsv, rangeToTsv, serializeCsv, spreadsheetColumn,
  type Cell, type CellRange, type CsvFormat, type CsvTable,
} from './csvTable';

type Props = {
  text: string;
  filename: string;
  /**
   * Edits arrive as the new file text (the editor's buffer: dirty, Ctrl+S).
   * Absent ⇒ read-only.
   */
  onChange?: (text: string) => void;
  /** Structured edits, for a workbook that writes cells, not CSV. */
  onRowsChange?: (rows: string[][]) => void;
  /** Column widths survive per file under this key (browser-local). */
  storageKey?: string;
  /**
   * Rows/columns may be inserted, deleted or reordered. A workbook says no:
   * shifting cells would rewrite every one after them as plain values.
   */
  structural?: boolean;
};

const ROW_HEIGHT = 28;
const OVERSCAN = 8;
const GUTTER = 48;
const DEFAULT_WIDTH = 160;
const HISTORY = 100;
const WIDTHS_KEY = 'hub.tableWidths.v1';

type Sort = { col: number; dir: 1 | -1 } | null;
type Editing = { row: number; col: number; value: string } | null;

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('clipboard unavailable');
}

function readWidths(key: string | undefined): number[] | null {
  if (!key) return null;
  try {
    const all = JSON.parse(localStorage.getItem(WIDTHS_KEY) || '{}');
    return Array.isArray(all?.[key]) ? all[key] : null;
  } catch { return null; }
}
function saveWidths(key: string | undefined, widths: number[]): void {
  if (!key) return;
  try {
    const all = JSON.parse(localStorage.getItem(WIDTHS_KEY) || '{}');
    delete all[key];
    all[key] = widths;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k];
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(all));
  } catch { /* private mode */ }
}

/**
 * A CSV/TSV (and every spreadsheet sheet) as a table you can work in
 * (§14.112): sort by a column (view only, or applied to the file), filter
 * rows, resize columns (double-click a border to fit), treat the first row as
 * a header, select ranges with live sum/average, copy and paste with Sheets
 * or Excel. With `onChange` it edits too: type over or double-click a cell,
 * Enter/Tab to commit, Delete to clear, insert and delete rows and columns,
 * Ctrl+Z / Ctrl+Y — and the file is written back in its own format.
 * Rows are virtualized; a preview cut by the size limits stays read-only.
 */
export default function CsvViewer({ text, filename, onChange, onRowsChange, storageKey, structural = true }: Props) {
  const tsv = filename.toLowerCase().endsWith('.tsv');
  // Parsed once, then only when the file changes UNDER us: our own edits come
  // back as `text` and must not re-parse (or reset) a 50k-row table per key.
  const initial = useRef<CsvTable | null>(null);
  if (!initial.current) initial.current = parseCsv(text, tsv ? '\t' : undefined);
  const [data, setData] = useState<string[][]>(() => initial.current!.rows);
  const [cols, setCols] = useState(() => initial.current!.columns);
  const [truncated, setTruncated] = useState(() => initial.current!.truncated);
  const [resetKey, setResetKey] = useState(0);
  const fmt = useRef<{ delimiter: CsvTable['delimiter']; format: CsvFormat }>({
    delimiter: initial.current.delimiter, format: detectCsvFormat(text),
  });
  const lastEmitted = useRef(text);
  const past = useRef<string[][][]>([]);
  const future = useRef<string[][][]>([]);
  const editable = !!(onChange || onRowsChange) && !truncated;

  const [header, setHeader] = useState(() => looksLikeHeader(initial.current!.rows));
  const [sort, setSort] = useState<Sort>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [widths, setWidths] = useState<number[]>([]);
  const [range, setRange] = useState<CellRange | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 500 });
  const [flash, setFlash] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  // The file changed under us (a reload, another sheet): start over.
  useEffect(() => {
    if (text === lastEmitted.current) return;
    lastEmitted.current = text;
    const p = parseCsv(text, tsv ? '\t' : undefined);
    setData(p.rows);
    setCols(p.columns);
    setTruncated(p.truncated);
    setHeader(looksLikeHeader(p.rows));
    fmt.current = { delimiter: p.delimiter, format: detectCsvFormat(text) };
    past.current = [];
    future.current = [];
    setRange(null);
    setEditing(null);
    setSort(null);
    setResetKey((k) => k + 1);
  }, [text, tsv]);

  // Widths: remembered for this file, else fitted to the content — once per
  // document, never per edit.
  useEffect(() => {
    const saved = readWidths(storageKey);
    setWidths(Array.from({ length: cols }, (_, c) => saved?.[c] ?? autoColumnWidth(data, c)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, resetKey]);
  const widthOf = (c: number) => widths[c] ?? DEFAULT_WIDTH;

  useEffect(() => {
    const stop = () => { draggingRef.current = false; };
    document.addEventListener('mouseup', stop);
    return () => document.removeEventListener('mouseup', stop);
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => setViewport({ top: scroller.scrollTop, height: scroller.clientHeight });
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  // View rows → data rows: header pinned, then filter, then sort.
  const first = header ? 1 : 0;
  const order = useMemo(() => {
    let idx = Array.from({ length: Math.max(0, data.length - first) }, (_, i) => i + first);
    const q = debounced.trim().toLowerCase();
    if (q) idx = idx.filter((r) => data[r].some((v) => (v ?? '').toLowerCase().includes(q)));
    if (sort) idx.sort((a, b) => compareCells(data[a][sort.col] ?? '', data[b][sort.col] ?? '') * sort.dir || a - b);
    return idx;
  }, [data, first, debounced, sort]);

  const flashNote = useCallback((msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash((m) => (m === msg ? null : m)), 1600);
  }, []);

  // ── Mutations: one place, history + emit ─────────────────────────────────
  const commit = useCallback((next: string[][], nextCols?: number) => {
    past.current.push(data);
    if (past.current.length > HISTORY) past.current.shift();
    future.current = [];
    setData(next);
    if (nextCols != null) setCols(nextCols);
    const out = serializeCsv(next, fmt.current.delimiter, fmt.current.format);
    lastEmitted.current = out;
    onChange?.(out);
    onRowsChange?.(next);
  }, [data, onChange, onRowsChange]);

  const restore = useCallback((from: React.MutableRefObject<string[][][]>, to: React.MutableRefObject<string[][][]>) => {
    const prev = from.current.pop();
    if (!prev) return;
    to.current.push(data);
    setData(prev);
    setCols((c) => Math.max(c, prev.reduce((m, r) => Math.max(m, r.length), 0)));
    const out = serializeCsv(prev, fmt.current.delimiter, fmt.current.format);
    lastEmitted.current = out;
    onChange?.(out);
    onRowsChange?.(prev);
  }, [data, onChange, onRowsChange]);

  const setCells = useCallback((cells: Array<{ row: number; col: number; value: string }>) => {
    if (!editable || !cells.length) return;
    const next = data.slice();
    let maxCol = cols;
    const touched = new Set<number>();
    for (const { row, col, value } of cells) {
      while (next.length <= row) next.push([]);
      if (!touched.has(row)) { next[row] = next[row].slice(); touched.add(row); }
      while (next[row].length <= col) next[row].push('');
      next[row][col] = value;
      maxCol = Math.max(maxCol, col + 1);
    }
    commit(next, maxCol);
  }, [editable, data, cols, commit]);

  const viewToData = useCallback((viewRow: number) => order[viewRow], [order]);

  const select = useCallback((cell: Cell, extend: boolean, drag = false) => {
    setRange((current) => (extend || drag) && current
      ? { anchor: current.anchor, focus: cell }
      : { anchor: cell, focus: cell });
  }, []);

  const selectedCells = useCallback((): Array<{ row: number; col: number }> => {
    if (!range) return [];
    const r = normalizeCellRange(range);
    const out = [];
    for (let v = r.top; v <= r.bottom; v++) {
      const row = order[v];
      if (row == null) continue;
      for (let c = r.left; c <= r.right; c++) out.push({ row, col: c });
    }
    return out;
  }, [range, order]);

  const copy = useCallback(async (cut = false) => {
    if (!range) return;
    const r = normalizeCellRange(range);
    const rows = [];
    for (let v = r.top; v <= r.bottom; v++) rows.push(data[order[v]] ?? []);
    try {
      await writeClipboard(rangeToTsv(rows, { anchor: { row: 0, col: r.left }, focus: { row: rows.length - 1, col: r.right } }));
      flashNote(cut ? 'cut' : 'copied');
      if (cut) setCells(selectedCells().map((c) => ({ ...c, value: '' })));
    } catch {
      flashNote('copy failed');
    }
  }, [range, data, order, flashNote, setCells, selectedCells]);

  const paste = useCallback((clip: string) => {
    if (!editable || !range) return;
    const block = parseClipboard(clip);
    const r = normalizeCellRange(range);
    const cells = [];
    // One value into a range fills it; a block lands at the top-left.
    if (block.length === 1 && block[0].length === 1 && (r.bottom > r.top || r.right > r.left)) {
      for (const c of selectedCells()) cells.push({ ...c, value: block[0][0] });
    } else {
      for (let i = 0; i < block.length; i++) {
        const viewRow = r.top + i;
        const row = viewRow < order.length ? order[viewRow] : data.length + (viewRow - order.length);
        for (let j = 0; j < block[i].length; j++) cells.push({ row, col: r.left + j, value: block[i][j] });
      }
    }
    setCells(cells);
    flashNote(`pasted ${cells.length} cell${cells.length === 1 ? '' : 's'}`);
  }, [editable, range, order, data.length, selectedCells, setCells, flashNote]);

  // ── Rows and columns ─────────────────────────────────────────────────────
  const insertRow = useCallback(() => {
    if (!editable) return;
    const at = range ? (order[normalizeCellRange(range).bottom] ?? data.length - 1) + 1 : data.length;
    const next = data.slice();
    next.splice(at, 0, Array.from({ length: cols }, () => ''));
    commit(next);
  }, [editable, range, order, data, cols, commit]);

  const deleteRows = useCallback(() => {
    if (!editable || !range) return;
    const r = normalizeCellRange(range);
    const drop = new Set(order.slice(r.top, r.bottom + 1));
    commit(data.filter((_, i) => !drop.has(i)));
    setRange(null);
  }, [editable, range, order, data, commit]);

  const insertColumn = useCallback(() => {
    if (!editable) return;
    const at = range ? normalizeCellRange(range).right + 1 : cols;
    commit(data.map((row) => {
      const copy = row.slice();
      while (copy.length < at) copy.push('');
      copy.splice(at, 0, '');
      return copy;
    }), cols + 1);
    setWidths((w) => { const n = w.slice(); n.splice(at, 0, DEFAULT_WIDTH); return n; });
  }, [editable, range, cols, data, commit]);

  const deleteColumns = useCallback(() => {
    if (!editable || !range) return;
    const r = normalizeCellRange(range);
    const span = r.right - r.left + 1;
    commit(data.map((row) => { const copy = row.slice(); copy.splice(r.left, span); return copy; }),
      Math.max(0, cols - span));
    setWidths((w) => { const n = w.slice(); n.splice(r.left, span); return n; });
    if (sort && sort.col >= r.left) setSort(null);
    setRange(null);
  }, [editable, range, data, cols, commit, sort]);

  const applySort = useCallback(() => {
    if (!editable || !sort) return;
    const sorted = order.length === data.length - first ? order : null;
    if (!sorted) { flashNote('clear the filter to apply the sort to the file'); return; }
    commit([...data.slice(0, first), ...sorted.map((i) => data[i])]);
    setSort(null);
    flashNote('rows reordered in the file');
  }, [editable, sort, order, data, first, commit, flashNote]);

  // ── Editing a cell ───────────────────────────────────────────────────────
  const startEdit = useCallback((viewRow: number, col: number, initial?: string) => {
    if (!editable) return;
    const row = order[viewRow];
    if (row == null) return;
    setEditing({ row: viewRow, col, value: initial ?? data[row]?.[col] ?? '' });
  }, [editable, order, data]);

  const finishEdit = useCallback((move: [number, number] | null) => {
    if (!editing) return;
    const row = order[editing.row];
    if (row != null && (data[row]?.[editing.col] ?? '') !== editing.value) {
      setCells([{ row, col: editing.col, value: editing.value }]);
    }
    const target = move
      ? { row: Math.max(0, Math.min(order.length - 1, editing.row + move[0])), col: Math.max(0, Math.min(cols - 1, editing.col + move[1])) }
      : { row: editing.row, col: editing.col };
    setEditing(null);
    setRange({ anchor: target, focus: target });
    requestAnimationFrame(() => scrollerRef.current?.focus());
  }, [editing, order, data, cols, setCells]);

  const ensureVisible = useCallback((cell: Cell) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = (cell.row + 1) * ROW_HEIGHT;
    if (top < scroller.scrollTop + ROW_HEIGHT) scroller.scrollTop = Math.max(0, top - ROW_HEIGHT);
    else if (top + ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + ROW_HEIGHT - scroller.clientHeight;
    }
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'c' && range) { event.preventDefault(); void copy(); return; }
    if (mod && key === 'x' && range && editable) { event.preventDefault(); void copy(true); return; }
    if (mod && key === 'a' && order.length && cols) {
      event.preventDefault();
      setRange({ anchor: { row: 0, col: 0 }, focus: { row: order.length - 1, col: cols - 1 } });
      return;
    }
    if (mod && key === 'z' && editable) { event.preventDefault(); restore(event.shiftKey ? future : past, event.shiftKey ? past : future); return; }
    if (mod && key === 'y' && editable) { event.preventDefault(); restore(future, past); return; }
    if (!range) return;
    if (editable && (event.key === 'Enter' || event.key === 'F2')) {
      event.preventDefault();
      startEdit(range.focus.row, range.focus.col);
      return;
    }
    if (editable && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault();
      setCells(selectedCells().map((c) => ({ ...c, value: '' })));
      return;
    }
    if (editable && event.key.length === 1 && !mod && !event.altKey) {
      event.preventDefault();
      startEdit(range.focus.row, range.focus.col, event.key);
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, event.shiftKey ? -1 : 1],
    };
    const delta = moves[event.key];
    if (!delta) return;
    event.preventDefault();
    const next = {
      row: Math.max(0, Math.min(order.length - 1, range.focus.row + delta[0])),
      col: Math.max(0, Math.min(cols - 1, range.focus.col + delta[1])),
    };
    select(next, event.shiftKey && event.key !== 'Tab');
    ensureVisible(next);
  }, [editing, range, copy, editable, order.length, cols, restore, startEdit, setCells, selectedCells, select, ensureVisible]);

  // ── Column resize ────────────────────────────────────────────────────────
  const resizeFrom = useCallback((col: number, startX: number) => {
    const startW = widthOf(col);
    const onMove = (e: MouseEvent) => {
      const w = Math.max(40, Math.round(startW + e.clientX - startX));
      setWidths((ws) => { const n = ws.slice(); n[col] = w; return n; });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setWidths((ws) => { saveWidths(storageKey, ws); return ws; });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widths, storageKey]);
  const fitColumn = useCallback((col: number) => {
    setWidths((ws) => {
      const n = ws.slice();
      n[col] = autoColumnWidth(data, col, 2000);
      saveWidths(storageKey, n);
      return n;
    });
  }, [data, storageKey]);

  // ── Selection statistics, like a spreadsheet's status bar ────────────────
  const stats = useMemo(() => {
    if (!range) return null;
    const r = normalizeCellRange(range);
    const cells = (r.bottom - r.top + 1) * (r.right - r.left + 1);
    if (cells < 2 || cells > 200_000) return null;
    let n = 0;
    let sum = 0;
    let filled = 0;
    for (let v = r.top; v <= r.bottom; v++) {
      const row = data[order[v]];
      if (!row) continue;
      for (let c = r.left; c <= r.right; c++) {
        const val = row[c] ?? '';
        if (val.trim()) filled++;
        const num = numericValue(val);
        if (num != null) { n++; sum += num; }
      }
    }
    return { filled, n, sum, avg: n ? sum / n : 0 };
  }, [range, data, order]);

  const editRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => { editRef.current?.focus(); }, [editing?.row, editing?.col]);

  if (!data.length || !cols) {
    return <div className="csv-empty">This table is empty.</div>;
  }

  const normalized = range ? normalizeCellRange(range) : null;
  const start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - 1 - OVERSCAN);
  const end = Math.min(order.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN);
  const totalWidth = GUTTER + Array.from({ length: cols }, (_, c) => widthOf(c)).reduce((a, b) => a + b, 0);
  const delimiter = fmt.current.delimiter === '\t' ? 'tab' : fmt.current.delimiter === ';' ? 'semicolon'
    : fmt.current.delimiter === '|' ? 'pipe' : 'comma';
  const fmtNum = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 6 });
  const selectionLabel = normalized
    ? `${spreadsheetColumn(normalized.left)}${normalized.top + 1}${normalized.top !== normalized.bottom || normalized.left !== normalized.right
      ? `:${spreadsheetColumn(normalized.right)}${normalized.bottom + 1}` : ''}`
    : '';
  const headerLabel = (c: number) => (header ? (data[0]?.[c] ?? '') : '') || spreadsheetColumn(c);

  return (
    <section className="csv-viewer">
      <div className="csv-toolbar">
        <span>
          {order.length.toLocaleString()}{order.length !== data.length - first ? ` of ${(data.length - first).toLocaleString()}` : ''} rows × {cols.toLocaleString()} columns
        </span>
        {/\.(csv|tsv)$/i.test(filename) && <span className="csv-delimiter">{delimiter} separated</span>}
        {truncated && <span className="csv-truncated">preview limited · read-only</span>}
        <input className="csv-filter" type="search" placeholder="filter rows" value={query}
               onChange={(e) => setQuery(e.target.value)} aria-label="Filter rows" />
        <button type="button" className={header ? 'on' : ''} onClick={() => setHeader((h) => !h)}
                title="Treat the first row as column names">Header</button>
        {sort && editable && structural && (
          <button type="button" onClick={applySort} title="Write the rows in this order into the file">Apply sort</button>
        )}
        {editable && (
          <>
            {structural && (
              <>
                <button type="button" onClick={insertRow} title="Insert a row below the selection">+ Row</button>
            <button type="button" onClick={deleteRows} disabled={!range} title="Delete the selected rows">− Row</button>
            <button type="button" onClick={insertColumn} title="Insert a column right of the selection">+ Col</button>
                <button type="button" onClick={deleteColumns} disabled={!range} title="Delete the selected columns">− Col</button>
              </>
            )}
            <button type="button" onClick={() => restore(past, future)} disabled={!past.current.length} title="Undo (Ctrl+Z)">↶</button>
            <button type="button" onClick={() => restore(future, past)} disabled={!future.current.length} title="Redo (Ctrl+Y)">↷</button>
          </>
        )}
        <span className="csv-spacer" />
        <button type="button" onClick={() => void copy()} disabled={!range}>{flash ?? 'Copy'}</button>
      </div>
      <div
        ref={scrollerRef}
        className="csv-grid-scroll"
        role="grid"
        aria-rowcount={order.length}
        aria-colcount={cols}
        aria-readonly={!editable}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPaste={(e) => { if (editable && !editing) { e.preventDefault(); paste(e.clipboardData.getData('text/plain')); } }}
        onScroll={(event) => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
      >
        <div className="csv-grid-canvas" style={{ height: (order.length + 1) * ROW_HEIGHT, width: totalWidth }}>
          <div className="csv-grid-head" role="row">
            <button
              type="button"
              className="csv-corner"
              title="select all"
              onMouseDown={(event) => {
                event.preventDefault();
                setRange({ anchor: { row: 0, col: 0 }, focus: { row: Math.max(0, order.length - 1), col: cols - 1 } });
                scrollerRef.current?.focus();
              }}
            />
            {Array.from({ length: cols }, (_, col) => {
              const sorted = sort?.col === col ? sort.dir : 0;
              return (
                <div key={col} role="columnheader" style={{ width: widthOf(col) }}
                     className={`csv-head-cell${normalized && col >= normalized.left && col <= normalized.right ? ' selected' : ''}`}
                     aria-sort={sorted === 1 ? 'ascending' : sorted === -1 ? 'descending' : 'none'}>
                  <button
                    type="button"
                    className="csv-head-label"
                    title={header ? `${spreadsheetColumn(col)} · ${headerLabel(col)}` : 'select the column'}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setRange({ anchor: { row: 0, col }, focus: { row: Math.max(0, order.length - 1), col } });
                      scrollerRef.current?.focus();
                    }}
                  >{headerLabel(col)}</button>
                  <button
                    type="button"
                    className={`csv-sort${sorted ? ' on' : ''}`}
                    title="Sort by this column (view only)"
                    onClick={() => setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null))}
                  >{sorted === 1 ? '▲' : sorted === -1 ? '▼' : '⇅'}</button>
                  <span className="csv-resize" title="Drag to resize · double-click to fit"
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); resizeFrom(col, e.clientX); }}
                        onDoubleClick={() => fitColumn(col)} />
                </div>
              );
            })}
          </div>
          {order.slice(start, end).map((dataRow, offset) => {
            const viewRow = start + offset;
            const row = data[dataRow] ?? [];
            return (
              <div className={`csv-grid-row${viewRow % 2 ? ' even' : ''}`} role="row" key={dataRow} style={{ top: (viewRow + 1) * ROW_HEIGHT }}>
                <button
                  type="button"
                  role="rowheader"
                  title={`row ${dataRow + 1} of the file`}
                  className={normalized && viewRow >= normalized.top && viewRow <= normalized.bottom ? 'selected' : ''}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setRange({ anchor: { row: viewRow, col: 0 }, focus: { row: viewRow, col: cols - 1 } });
                    scrollerRef.current?.focus();
                  }}
                >{dataRow + 1}</button>
                {Array.from({ length: cols }, (_, col) => {
                  const value = row[col] ?? '';
                  const selected = cellInRange(viewRow, col, range);
                  const anchor = range?.focus.row === viewRow && range.focus.col === col;
                  if (editing && editing.row === viewRow && editing.col === col) {
                    return (
                      <div key={col} className="csv-cell editing" style={{ width: widthOf(col) }}>
                        <input
                          ref={editRef}
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); finishEdit([e.shiftKey ? -1 : 1, 0]); }
                            else if (e.key === 'Tab') { e.preventDefault(); finishEdit([0, e.shiftKey ? -1 : 1]); }
                            else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); scrollerRef.current?.focus(); }
                          }}
                          onBlur={() => finishEdit(null)}
                        />
                      </div>
                    );
                  }
                  return (
                    <div
                      role="gridcell"
                      aria-selected={selected}
                      key={col}
                      style={{ width: widthOf(col) }}
                      className={`csv-cell${selected ? ' selected' : ''}${anchor ? ' focus' : ''}${numericValue(value) != null ? ' num' : ''}`}
                      title={value.length > 30 ? value : undefined}
                      onMouseDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        draggingRef.current = true;
                        select({ row: viewRow, col }, event.shiftKey);
                        scrollerRef.current?.focus();
                      }}
                      onMouseEnter={() => { if (draggingRef.current) select({ row: viewRow, col }, false, true); }}
                      onDoubleClick={() => startEdit(viewRow, col)}
                    >{value}</div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="csv-hint">
        {selectionLabel && <span className="csv-selection">{selectionLabel}</span>}
        {stats && (
          <span className="csv-stats">
            {stats.filled} filled{stats.n > 0 && ` · sum ${fmtNum(stats.sum)} · average ${fmtNum(stats.avg)} · ${stats.n} numbers`}
          </span>
        )}
        <span className="csv-spacer" />
        <span>
          {editable
            ? 'type or double-click to edit · Enter/Tab commit · Delete clears · Ctrl+Z undo · Ctrl+C/V with Sheets/Excel'
            : 'drag or Shift-click to select · Ctrl+C copies for Sheets/Excel'}
        </span>
      </div>
    </section>
  );
}
