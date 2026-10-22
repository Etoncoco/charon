export type CsvTable = {
  rows: string[][];
  delimiter: ',' | ';' | '\t' | '|';
  columns: number;
  truncated: boolean;
};

export type Cell = { row: number; col: number };
export type CellRange = { anchor: Cell; focus: Cell };

const CANDIDATES: CsvTable['delimiter'][] = [',', ';', '\t', '|'];
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 500;
const MAX_CELLS = 1_000_000;

function parseWith(text: string, delimiter: CsvTable['delimiter'], rowLimit = MAX_ROWS): CsvTable {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!input) return { rows: [], delimiter, columns: 0, truncated: false };
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  let cells = 0;

  const pushField = () => {
    if (row.length < MAX_COLUMNS && cells < MAX_CELLS) {
      row.push(field);
      cells++;
    } else {
      truncated = true;
    }
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (rows.length < rowLimit && cells <= MAX_CELLS) rows.push(row);
    else truncated = true;
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) { quoted = true; continue; }
    if (ch === delimiter) { pushField(); continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      pushRow();
      if (rows.length >= rowLimit || cells >= MAX_CELLS) {
        if (i < input.length - 1) truncated = true;
        break;
      }
      continue;
    }
    field += ch;
  }
  const last = input[input.length - 1];
  if (row.length > 0 || field.length > 0 || last === delimiter) pushRow();
  const columns = rows.reduce((max, current) => Math.max(max, current.length), 0);
  return { rows, delimiter, columns, truncated };
}

function delimiterScore(table: CsvTable): number {
  const sample = table.rows.filter((row) => row.some((cell) => cell.length > 0)).slice(0, 30);
  if (!sample.length) return 0;
  const counts = new Map<number, number>();
  for (const row of sample) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  let modeColumns = 1;
  let modeCount = 0;
  for (const [columns, count] of counts) {
    if (columns > 1 && count > modeCount) { modeColumns = columns; modeCount = count; }
  }
  return modeColumns === 1 ? 0 : modeCount * 1_000 + modeColumns;
}

/** RFC-style quoted fields/newlines plus pragmatic delimiter detection. */
export function parseCsv(text: string, preferred?: CsvTable['delimiter']): CsvTable {
  if (preferred) return parseWith(text, preferred);
  let best = parseWith(text, ',', 30);
  let score = delimiterScore(best);
  for (const delimiter of CANDIDATES.slice(1)) {
    const candidate = parseWith(text, delimiter, 30);
    const candidateScore = delimiterScore(candidate);
    if (candidateScore > score) { best = candidate; score = candidateScore; }
  }
  return parseWith(text, best.delimiter);
}

export function normalizeCellRange(range: CellRange): { top: number; bottom: number; left: number; right: number } {
  return {
    top: Math.min(range.anchor.row, range.focus.row),
    bottom: Math.max(range.anchor.row, range.focus.row),
    left: Math.min(range.anchor.col, range.focus.col),
    right: Math.max(range.anchor.col, range.focus.col),
  };
}

export function cellInRange(row: number, col: number, range: CellRange | null): boolean {
  if (!range) return false;
  const r = normalizeCellRange(range);
  return row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;
}

function tsvCell(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Clipboard shape understood by Google Sheets, Excel and LibreOffice. */
export function rangeToTsv(rows: string[][], range: CellRange): string {
  const r = normalizeCellRange(range);
  const out: string[] = [];
  for (let row = r.top; row <= r.bottom; row++) {
    const values: string[] = [];
    for (let col = r.left; col <= r.right; col++) values.push(tsvCell(rows[row]?.[col] ?? ''));
    out.push(values.join('\t'));
  }
  return out.join('\n');
}

export function spreadsheetColumn(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

// ── Editing (§14.112) ───────────────────────────────────────────────────────
// What the table editor needs to write a CSV back the way it came: the same
// delimiter, line endings, BOM and final newline — an edit to one cell must
// not reformat the whole file in the diff.

export type CsvFormat = { bom: boolean; eol: '\r\n' | '\n'; trailingNewline: boolean };

export function detectCsvFormat(text: string): CsvFormat {
  // The first line break decides: a file is CRLF or LF, not a vote.
  const lf = text.indexOf('\n');
  return {
    bom: text.charCodeAt(0) === 0xfeff,
    eol: lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n',
    trailingNewline: /\r?\n$/.test(text),
  };
}

function csvField(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/** Rows → CSV text in the file's own format; trailing empty cells kept. */
export function serializeCsv(rows: string[][], delimiter: CsvTable['delimiter'], format: CsvFormat): string {
  const body = rows.map((row) => row.map((v) => csvField(v ?? '', delimiter)).join(delimiter)).join(format.eol);
  return (format.bom ? '﻿' : '') + body + (format.trailingNewline && rows.length ? format.eol : '');
}

/** Clipboard text (TSV from Sheets/Excel, or one plain value) → rows. */
export function parseClipboard(text: string): string[][] {
  const trimmed = text.replace(/\r?\n$/, '');
  if (!trimmed.includes('\t') && !trimmed.includes('\n')) return [[trimmed]];
  return parseCsv(trimmed, '\t').rows;
}

/**
 * A cell as a number, or null. Accepts what people type in tables: `1234.5`,
 * `-3`, `1e6`, `1,234.5`, `1 234,5` (spaces/NBSP as thousands, a decimal
 * comma when it is the only comma). Never a date or a code like `007`… well,
 * `007` is 7: leading zeros are numbers too, as in every spreadsheet.
 */
export function numericValue(raw: string): number | null {
  let s = (raw ?? '').trim().replace(/[\s  ]/g, '');
  if (!s) return null;
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^[-+]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const collator = typeof Intl !== 'undefined'
  ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  : null;

/** Natural order: numbers as numbers, text with embedded numbers (2 < 10), empties last. */
export function compareCells(a: string, b: string): number {
  const ea = (a ?? '').trim() === '';
  const eb = (b ?? '').trim() === '';
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const na = numericValue(a);
  const nb = numericValue(b);
  if (na != null && nb != null) return na - nb;
  if (na != null) return -1;
  if (nb != null) return 1;
  return collator ? collator.compare(a, b) : a.localeCompare(b);
}

/** A first row of distinct, non-empty, non-numeric labels reads as a header. */
export function looksLikeHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0].map((c) => (c ?? '').trim());
  if (!first.length || first.some((c) => !c || numericValue(c) != null)) return false;
  return new Set(first.map((c) => c.toLowerCase())).size === first.length;
}

/** A column's comfortable width from its content (first rows), in px. */
export function autoColumnWidth(rows: string[][], col: number, sample = 300): number {
  let longest = 0;
  for (let i = 0; i < Math.min(rows.length, sample); i++) {
    const v = rows[i]?.[col] ?? '';
    const firstLine = v.length > 200 ? v.slice(0, 200) : v;
    longest = Math.max(longest, firstLine.split('\n')[0].length);
  }
  return Math.max(64, Math.min(420, Math.round(longest * 7.4 + 24)));
}
