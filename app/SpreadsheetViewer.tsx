'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkBook, WorkSheet } from 'xlsx';
import { api } from '@/lib/api';
import CsvViewer from './CsvViewer';
import ConfirmModal from './ConfirmModal';
import { parseCsv } from './csvTable';
import { saveBytes } from './binarySave';
import type { ByteViewerProps } from './fileViews';
import {
  SHEET_MAX_ROWS, fetchFileBytes, isAbort, pickSheet, sheetWindow, sniffContainer,
  spreadsheetContainerOk, spreadsheetErrorText, type SheetWindow,
} from './documentViews';

// A workbook (.xlsx/.xlsm/.xls/.ods), one sheet at a time, in the table
// editor (virtualized rows, sort, filter, copy for Sheets/Excel). Cells show
// their FORMATTED text, as the workbook displays them; formulas are not
// recalculated. SheetJS (~1MB) loads only once a workbook is opened.
//
// Editing (§14.112) writes back only the cells that changed — every other
// cell, formula, merge, width and macro is written as it was read — and never
// inserts, deletes or reorders rows (that would rewrite every shifted cell as
// a plain value). A workbook the grid shows only in part is read-only: saving
// it would truncate it. SheetJS does not keep colours, fonts or borders; the
// first save says so before writing.

type Xlsx = typeof import('xlsx');

let xlsxPromise: Promise<Xlsx> | null = null;
function loadXlsx(): Promise<Xlsx> {
  xlsxPromise ??= import('xlsx').catch((e: unknown) => { xlsxPromise = null; throw e; });
  return xlsxPromise;
}

type SheetMeta = { name: string; hidden: boolean; veryHidden: boolean; chart: boolean };
type SheetView = SheetWindow & { tsv: string };
type Book = {
  lib: Xlsx; wb: WorkBook; sheets: SheetMeta[]; activeTab: number | null; views: Map<string, SheetView>;
  /** Some sheet was read only in part (the grid's caps): never written back. */
  partial: boolean;
};

/** What SheetJS can write for each extension. */
const BOOK_TYPES: Record<string, 'xlsx' | 'xlsm' | 'xlsb' | 'biff8' | 'ods'> = {
  xlsx: 'xlsx', xlsm: 'xlsm', xlsb: 'xlsb', xls: 'biff8', ods: 'ods',
};

/** Set (or clear) one cell, dense or sparse sheet alike, keeping all others. */
function writeCell(lib: Xlsx, ws: WorkSheet, r: number, c: number, value: string): void {
  if (value === '') {
    const dense = (ws as { '!data'?: unknown[][] })['!data'];
    if (dense) { if (dense[r]) dense[r][c] = undefined; }
    else delete ws[lib.utils.encode_cell({ r, c })];
    return;
  }
  // A plain number stays a number; anything else (a date typed as text, a
  // code with leading zeros, a percentage) is stored as the text typed.
  const v = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(value.trim()) && !/^-?0\d/.test(value.trim())
    ? Number(value) : value;
  lib.utils.sheet_add_aoa(ws, [[v]], { origin: { r, c } });
}

/**
 * One sheet as tab-separated text for the grid, cached per workbook. Always
 * from A1 (a table starting at C3 keeps its letters and row numbers), capped
 * like the grid itself. Tabs + quoted fields + a `.tsv` name: the grid never
 * has to GUESS the delimiter of a one-column sheet full of semicolons.
 */
function sheetView(book: Book, name: string): SheetView {
  const hit = book.views.get(name);
  if (hit) return hit;
  const { lib, wb } = book;
  const ws = wb.Sheets[name];
  const decode = (ref: unknown) => (typeof ref === 'string' && ref ? lib.utils.decode_range(ref) : null);
  const win = sheetWindow(decode(ws?.['!ref']), decode(ws?.['!fullref']));
  let tsv = '';
  if (ws && win.shownRows && win.shownCols) {
    const original = ws['!ref'];
    ws['!ref'] = lib.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: win.shownRows - 1, c: win.shownCols - 1 } });
    try {
      tsv = lib.utils.sheet_to_csv(ws, { FS: '\t', RS: '\n', forceQuotes: true, blankrows: true });
    } finally {
      ws['!ref'] = original;
    }
  }
  const view = { ...win, tsv };
  book.views.set(name, view);
  return view;
}

function readBook(lib: Xlsx, buf: ArrayBuffer, name: string): Book {
  const wb = lib.read(new Uint8Array(buf), {
    // Dates stay serial numbers: a rewrite must store them exactly as read.
    type: 'array', cellDates: false, dense: true,
    // Past the grid's row cap nothing would be shown; `!fullref` keeps the real size.
    sheetRows: SHEET_MAX_ROWS,
    cellHTML: false, cellStyles: false,
    // Macros ride along so saving an .xlsm keeps them.
    bookVBA: /\.xlsm$/i.test(name),
  });
  const props = wb.Workbook?.Sheets ?? [];
  const sheets = wb.SheetNames.map((name, i): SheetMeta => ({
    name,
    hidden: (props[i]?.Hidden ?? 0) > 0,
    veryHidden: props[i]?.Hidden === 2,
    chart: wb.Sheets[name]?.['!type'] === 'chart',
  }));
  // Not in SheetJS's types: the workbook view's active tab (XLSX only).
  const views = (wb.Workbook as { WBView?: Array<{ activeTab?: unknown }> } | undefined)?.WBView;
  const tab = Number(views?.[0]?.activeTab);
  const decode = (ref: unknown) => (typeof ref === 'string' && ref ? lib.utils.decode_range(ref) : null);
  const partial = wb.SheetNames.some((n) => {
    const ws = wb.Sheets[n];
    const w = sheetWindow(decode(ws?.['!ref']), decode(ws?.['!fullref']));
    return w.shownRows < w.rows || w.shownCols < w.cols;
  });
  return { lib, wb, sheets, activeTab: Number.isInteger(tab) ? tab : null, views: new Map(), partial };
}

export default function SpreadsheetViewer({ vpsId, root, path, url, name, rev, active, onDirtyChange }: ByteViewerProps) {
  // A change noticed while the pane is hidden is fetched once it is shown —
  // unless there are unsaved edits: those are never thrown away silently.
  const [loadRev, setLoadRev] = useState(rev);
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  useEffect(() => {
    if (!active || rev === loadRev) return;
    if (dirtyRef.current) setChangedOnDisk(true); else setLoadRev(rev);
  }, [active, rev, loadRev]);
  const setDirty = useCallback((v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
    onDirtyChange?.(v);
  }, [onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const versionRef = useRef<string | null>(null);
  const baseRows = useRef(new Map<string, string[][]>());
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [warned, setWarned] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const ext = name.split('.').pop()?.toLowerCase() ?? '';

  const [book, setBook] = useState<Book | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    (async () => {
      // The version the edits are based on: a save refuses if it moved.
      const st = await api.statFsFile(vpsId, root, path).catch(() => null);
      const [buf, lib] = await Promise.all([fetchFileBytes(url, ac.signal), loadXlsx()]);
      if (ac.signal.aborted) return;
      if (!spreadsheetContainerOk(name, sniffContainer(new Uint8Array(buf, 0, Math.min(8, buf.byteLength))))) {
        throw new Error('this file is not a valid spreadsheet');
      }
      // Parsing is synchronous: let "loading…" paint first.
      await new Promise((r) => setTimeout(r, 0));
      if (ac.signal.aborted) return;
      let next: Book;
      try { next = readBook(lib, buf, name); } catch (e) { throw new Error(spreadsheetErrorText(e)); }
      if (ac.signal.aborted) return;
      versionRef.current = st?.ok ? st.version ?? null : null;
      baseRows.current = new Map();
      setDirty(false);
      setChangedOnDisk(false);
      // The book on screen stays until its replacement is ready, and the
      // sheet being read stays selected when it still exists.
      setBook(next);
      setSelected(pickSheet(
        next.sheets.map((s) => s.name), next.sheets.map((s) => s.hidden), selectedRef.current, next.activeTab,
      ));
      setErr(null);
    })().catch((e: unknown) => {
      if (!ac.signal.aborted && !isAbort(e)) setErr(e instanceof Error ? e.message : String(e));
    }).finally(() => {
      if (!ac.signal.aborted) setLoading(false);
    });
    return () => ac.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, name, loadRev]);

  const editable = !!book && !book.partial && !!BOOK_TYPES[ext];

  // The grid reports whole rows; the workbook gets only the cells that differ.
  const onRowsChange = useCallback((rows: string[][]) => {
    if (!book || !meta) return;
    const ws = book.wb.Sheets[meta.name];
    if (!ws) return;
    const before = baseRows.current.get(meta.name) ?? parseCsv(sheetView(book, meta.name).tsv, '\t').rows;
    const height = Math.max(before.length, rows.length);
    for (let r = 0; r < height; r++) {
      const a = before[r] ?? [];
      const b = rows[r] ?? [];
      const width = Math.max(a.length, b.length);
      for (let c = 0; c < width; c++) {
        if ((a[c] ?? '') !== (b[c] ?? '')) writeCell(book.lib, ws, r, c, b[c] ?? '');
      }
    }
    baseRows.current.set(meta.name, rows);
    // Coming back to this sheet must show the edits, not the cached text.
    book.views.delete(meta.name);
    setDirty(true);
    setSaveNote(null);
  // `meta` is derived from book + selected.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, selected, setDirty]);

  const save = useCallback(async (force = false) => {
    if (!book || !dirtyRef.current || saving) return;
    setSaving(true);
    setSaveNote(null);
    try {
      const out = book.lib.write(book.wb, { type: 'array', bookType: BOOK_TYPES[ext], bookVBA: ext === 'xlsm' });
      const r = await saveBytes(vpsId, root, path, new Uint8Array(out as ArrayBuffer), force ? null : versionRef.current);
      if (r.ok) {
        versionRef.current = r.version;
        setDirty(false);
        setChangedOnDisk(false);
        setSaveNote({ kind: 'ok', text: 'saved' });
      } else {
        if (r.reason === 'stale') setChangedOnDisk(true);
        setSaveNote({ kind: 'err', text: r.error });
      }
    } catch (e: unknown) {
      setSaveNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [book, saving, ext, vpsId, root, path]);

  const requestSave = useCallback(() => {
    if (!dirtyRef.current) return;
    if (warned) void save(); else setConfirmSave(true);
  }, [warned, save]);

  // Ctrl/⌘+S for the workbook on screen (the pane's own handler only knows text).
  useEffect(() => {
    if (!active || !editable) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); requestSave(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, editable, requestSave]);

  const meta = book?.sheets.find((s) => s.name === selected) ?? null;
  const view = useMemo(() => (book && meta && !meta.chart ? sheetView(book, meta.name) : null), [book, meta]);

  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('button.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  let note = '';
  if (view) {
    note = `${view.rows.toLocaleString()} ${view.rows === 1 ? 'row' : 'rows'} × ${view.cols.toLocaleString()} ${view.cols === 1 ? 'column' : 'columns'}`;
    if (view.shownRows < view.rows || view.shownCols < view.cols) {
      const cut = [
        view.shownRows < view.rows ? `${view.shownRows.toLocaleString()} rows` : '',
        view.shownCols < view.cols ? `${view.shownCols.toLocaleString()} columns` : '',
      ].filter(Boolean).join(', ');
      note += ` · showing the first ${cut}`;
    }
  }
  if (loading) note = book ? `${note}${note ? ' · ' : ''}reloading…` : 'loading…';

  return (
    <div className="xlsv">
      <div className="viewer-bar xlsv-bar">
        {book && (
          <div className="xlsv-tabs" ref={tabsRef} role="tablist" aria-label="Sheets">
            {book.sheets.map((s) => (
              <button
                type="button"
                key={s.name}
                role="tab"
                aria-selected={s.name === selected}
                className={`${s.name === selected ? 'on' : ''}${s.hidden ? ' hidden-sheet' : ''}`}
                title={s.veryHidden ? 'Very hidden sheet' : s.hidden ? 'Hidden sheet' : s.chart ? 'Chart sheet' : undefined}
                onClick={() => setSelected(s.name)}
              >
                <span className="xlsv-name">{s.name}</span>
                {s.hidden && <span className="xlsv-tag">hidden</span>}
                {s.chart && <span className="xlsv-tag">chart</span>}
              </button>
            ))}
          </div>
        )}
        <span className="viewer-bar-spacer" />
        {note && <span className="viewer-bar-note xlsv-note">{note}</span>}
        {book && !editable && (
          <span className="viewer-bar-note" title={book.partial ? 'Saving would cut the rows that are not shown' : 'This format cannot be written back'}>read-only</span>
        )}
        {editable && (
          <button type="button" className={dirty ? 'on' : ''} disabled={!dirty || saving} onClick={requestSave}
                  title="Save the workbook to the VPS (Ctrl+S)">{saving ? 'saving…' : dirty ? 'Save' : 'Saved'}</button>
        )}
      </div>
      {err && <div className="dvm-note err">{err}</div>}
      {saveNote && <div className={`fe-note ${saveNote.kind}`}>{saveNote.text}</div>}
      {changedOnDisk && (
        <div className="fe-conflict">
          <b>This workbook changed on the VPS while you were editing it.</b>
          <span>Reloading discards your edits; overwriting discards the other change.</span>
          <div className="fe-conflict-actions">
            <button onClick={() => { setDirty(false); setChangedOnDisk(false); setLoadRev(rev); }}>reload from the VPS</button>
            <button className="danger" onClick={() => { setWarned(true); void save(true); }}>overwrite with my version</button>
            <button onClick={() => setChangedOnDisk(false)}>keep editing</button>
          </div>
        </div>
      )}
      {confirmSave && (
        <ConfirmModal
          title="Save this workbook?"
          confirmLabel="Save"
          busyLabel="saving…"
          confirmOnEnter
          onConfirm={async () => { setWarned(true); setConfirmSave(false); await save(); }}
          onClose={() => setConfirmSave(false)}
        >
          <p>
            The edited cells are written into <code>{name}</code>. Values, formulas, merged cells,
            column widths{ext === 'xlsm' ? ' and macros' : ''} are kept; <b>colours, fonts and borders are not</b>{' '}
            (the spreadsheet library cannot write them).
          </p>
        </ConfirmModal>
      )}
      {meta?.chart && <div className="xlsv-empty">Chart sheets are not drawn here — open the workbook to see the chart.</div>}
      {view && (view.tsv
        // One grid per sheet: sort, filter and scroll belong to the sheet they were set on.
        ? <CsvViewer key={meta?.name} text={view.tsv} filename={`${meta?.name ?? 'sheet'}.tsv`}
            storageKey={`${vpsId}:${root}:${path}#${meta?.name ?? ''}`}
            onRowsChange={editable ? onRowsChange : undefined} structural={false} />
        : <div className="xlsv-empty">This sheet is empty.</div>)}
    </div>
  );
}
