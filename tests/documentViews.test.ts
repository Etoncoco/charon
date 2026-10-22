import { describe, expect, it } from 'vitest';
import {
  SHEET_MAX_CELLS, SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, classifyDocHref, countWords, docxErrorText,
  docxFrameCss, frameDocument, isDocxName, isNotebookName, isSpreadsheetName, outputFrameCss, pickSheet,
  sheetWindow, sniffContainer, spreadsheetContainerOk, spreadsheetErrorText, summarizeMessages,
} from '../app/documentViews';

// §14.111: Word/Excel documents and sandboxed HTML (DocxViewer, SpreadsheetViewer, DocFrame).

const range = (r: number, c: number, sr = 0, sc = 0) => ({ s: { r: sr, c: sc }, e: { r, c } });

describe('which files have a view', () => {
  it('matches extensions case-insensitively', () => {
    expect(isNotebookName('a.IPYNB')).toBe(true);
    expect(isDocxName('report.docx')).toBe(true);
    expect(isDocxName('old.doc')).toBe(false);
    for (const n of ['a.xlsx', 'a.XLSM', 'a.xls', 'a.ods']) expect(isSpreadsheetName(n)).toBe(true);
    expect(isSpreadsheetName('a.csv')).toBe(false);
  });
});

describe('what the bytes are', () => {
  it('sniffs ZIP, CFB and anything else', () => {
    expect(sniffContainer(new Uint8Array([0x50, 0x4b, 3, 4, 0]))).toBe('zip');
    expect(sniffContainer(new Uint8Array([0x50, 0x4b, 5, 6]))).toBe('zip');
    expect(sniffContainer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe('cfb');
    expect(sniffContainer(new Uint8Array([0xd0, 0xcf, 0x11]))).toBe('other');
    expect(sniffContainer(new TextEncoder().encode('<html>'))).toBe('other');
    expect(sniffContainer(new Uint8Array())).toBe('other');
  });

  it('accepts anything for .xls (HTML/XML/CSV exports), a real container otherwise', () => {
    expect(spreadsheetContainerOk('a.xls', 'other')).toBe(true);
    expect(spreadsheetContainerOk('a.xlsx', 'other')).toBe(false);
    expect(spreadsheetContainerOk('a.xlsx', 'cfb')).toBe(true); // encrypted: SheetJS says so
    expect(spreadsheetContainerOk('a.ods', 'zip')).toBe(true);
  });

  it('words conversion failures', () => {
    expect(docxErrorText(null, 'cfb')).toMatch(/password-protected or in the old \.doc format/);
    expect(docxErrorText(null, 'other')).toBe('this file is not a valid .docx document');
    expect(docxErrorText(new Error('Could not find main document part. Are you sure this is a valid .docx file?')))
      .toBe('this file is not a valid .docx document');
    expect(docxErrorText(new Error('End of data reached (data length = 3, asked index = 4). Corrupted zip ?')))
      .toBe('this file is not a valid .docx document');
    expect(docxErrorText(new Error('boom'))).toBe('could not read this document: boom');
    expect(spreadsheetErrorText(new Error('File is password-protected'))).toMatch(/^this workbook is password-protected/);
    expect(spreadsheetErrorText(new Error('Unsupported ZIP file'))).toBe('this workbook is damaged or not a spreadsheet');
    expect(spreadsheetErrorText(new Error('Cannot find Workbook stream'))).toBe('this workbook is damaged or not a spreadsheet');
    expect(spreadsheetErrorText('odd')).toBe('could not read this workbook: odd');
  });
});

describe('sandboxed documents', () => {
  it('lets anchors scroll, web links open, and drops everything else', () => {
    expect(classifyDocHref('#footnote-1')).toBe('fragment');
    expect(classifyDocHref(' https://example.com/x')).toBe('external');
    expect(classifyDocHref('HTTP://EXAMPLE.COM')).toBe('external');
    expect(classifyDocHref('mailto:a@b.c')).toBe('external');
    expect(classifyDocHref('javascript:alert(1)')).toBe('blocked');
    expect(classifyDocHref('JavaScript:alert(1)')).toBe('blocked');
    expect(classifyDocHref('data:text/html,<b>')).toBe('blocked');
    expect(classifyDocHref('file:///etc/passwd')).toBe('blocked');
    expect(classifyDocHref('other.docx')).toBe('blocked');
    expect(classifyDocHref('//evil.example')).toBe('blocked');
  });

  it('wraps content in a script-less document with link targets set', () => {
    const doc = frameDocument({ css: 'p{}', head: '<style>x{}</style>', body: '<p>hi</p>' });
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
    expect(doc.indexOf('<style>p{}</style>')).toBeLessThan(doc.indexOf('<style>x{}</style>'));
    expect(doc).toContain('<body><p>hi</p></body>');
  });

  it('paints the paper it is given, never a theme colour', () => {
    expect(docxFrameCss('rgb(255, 255, 255)')).toContain('html{background:rgb(255, 255, 255);');
    expect(outputFrameCss('#fff')).toContain('html{background:#fff;');
    expect(docxFrameCss('#fff')).not.toMatch(/var\(--/);
  });

  it('counts words as a reader would', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('Hello, world!  It’s a well-known fact — 42 times.')).toBe(8);
    expect(countWords('Ça va? Très bien.')).toBe(4);
  });

  it('folds repeated converter warnings', () => {
    expect(summarizeMessages([
      { type: 'warning', message: "Unrecognised paragraph style: 'Body' " },
      { type: 'warning', message: "Unrecognised paragraph style: 'Body'" },
      { type: 'error', message: 'could not open external image' },
      { type: 'warning', message: "Unrecognised paragraph style: 'Body'" },
    ])).toEqual([
      { type: 'warning', message: "Unrecognised paragraph style: 'Body'", count: 3 },
      { type: 'error', message: 'could not open external image', count: 1 },
    ]);
  });
});

describe('spreadsheet window', () => {
  it('counts from A1 and reports the real size when the reader cut rows', () => {
    expect(sheetWindow(range(9, 1, 2, 1), range(29, 1, 2, 1))).toEqual({ rows: 30, cols: 2, shownRows: 10, shownCols: 2 });
    expect(sheetWindow(range(3, 4, 2, 2))).toEqual({ rows: 4, cols: 5, shownRows: 4, shownCols: 5 });
    expect(sheetWindow(null)).toEqual({ rows: 0, cols: 0, shownRows: 0, shownCols: 0 });
  });

  it('stays inside the grid caps', () => {
    const wide = sheetWindow(range(SHEET_MAX_ROWS - 1, 2000));
    expect(wide.shownCols).toBe(SHEET_MAX_COLUMNS);
    expect(wide.shownRows * wide.shownCols).toBeLessThanOrEqual(SHEET_MAX_CELLS);
    expect(wide.cols).toBe(2001);
    const tall = sheetWindow(range(10 * SHEET_MAX_ROWS, 3));
    expect(tall.shownRows).toBe(SHEET_MAX_ROWS);
    expect(tall.shownCols).toBe(4);
  });

  it('picks the sheet to show', () => {
    const names = ['a', 'b', 'c'];
    expect(pickSheet(names, [false, false, false], 'c', 1)).toBe('c');
    expect(pickSheet(names, [false, false, false], 'gone', 1)).toBe('b');
    expect(pickSheet(names, [false, true, false], null, 1)).toBe('a');
    expect(pickSheet(names, [true, false, false], null, null)).toBe('b');
    expect(pickSheet(names, [true, true, true], null, 9)).toBe('a');
    expect(pickSheet([], [], 'a', 0)).toBeNull();
  });
});
