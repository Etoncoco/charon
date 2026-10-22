import { describe, expect, it } from 'vitest';
import { viewerFor } from '../app/fileViews';
import {
  cutToLineStart, filterLines, fromBase64, hexDump, looksLikeText, sniffMagic, stripAnsi,
} from '../app/byteText';
import { jqPath, parseJsonDoc, searchJson, stripJsonComments, containerPaths, pathKey } from '../app/jsonTree';
import {
  compareCells, detectCsvFormat, looksLikeHeader, numericValue, parseClipboard, parseCsv, serializeCsv,
} from '../app/csvTable';

// §14.112: one table decides the viewer; the pure halves of the log, hex,
// JSON and table views.

describe('which viewer opens a file', () => {
  const kind = (n: string) => viewerFor(n)?.kind ?? null;

  it('routes every format to its viewer', () => {
    expect(kind('index.HTML')).toBe('live');
    expect(kind('README.md')).toBe('markdown');
    expect(kind('logo.svg')).toBe('svg');
    expect(kind('flow.mmd')).toBe('mermaid');
    expect(kind('deps.dot')).toBe('graphviz');
    expect(kind('tsconfig.json')).toBe('json');
    expect(kind('events.jsonl')).toBe('json');
    expect(kind('analysis.ipynb')).toBe('notebook');
    expect(kind('route.gpx')).toBe('geo');
    expect(kind('server.log')).toBe('log');
    expect(kind('scan.TIFF')).toBe('convert-image');
    expect(kind('IMG_0001.heic')).toBe('convert-image');
    expect(kind('deck.pptx')).toBe('office');
    expect(kind('report.docx')).toBe('docx');
    expect(kind('budget.xlsx')).toBe('spreadsheet');
    expect(kind('app.sqlite3')).toBe('sqlite');
    expect(kind('site.tar.gz')).toBe('archive');
    expect(kind('site.tar.xz')).toBe('archive');
    expect(kind('font.woff2')).toBe('font');
    expect(kind('part.stl')).toBe('model3d');
  });

  it('fixes the media that used to open in a dead player', () => {
    expect(kind('clip.m4v')).toBe('video');
    expect(kind('movie.mkv')).toBe('video');
    expect(kind('old.avi')).toBe('video');
    expect(kind('photo.tif')).toBe('convert-image');
  });

  it('leaves the rest to the editor (text) or the hex view (binary)', () => {
    for (const n of ['main.py', 'Makefile', 'data.csv', 'notes.txt', 'blob.bz2', 'x.xz', '.env', 'noext']) {
      expect(kind(n), n).toBeNull();
    }
  });

  it('opens visual formats on their view, documents on their source', () => {
    expect(viewerFor('a.svg')?.startInView).toBe(true);
    expect(viewerFor('a.log')?.startInView).toBe(true);
    expect(viewerFor('a.md')?.startInView).toBe(false);
    expect(viewerFor('a.json')?.startInView).toBe(false);
    expect(viewerFor('a.json')?.label).toBe('Tree');
  });
});

describe('bytes for the log and hex views', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('cuts a mid-file chunk at its first line start', () => {
    const r = cutToLineStart(enc('tial line\nline 2\nline 3'));
    expect(new TextDecoder().decode(r.bytes)).toBe('line 2\nline 3');
    expect(r.dropped).toBe(10);
    expect(cutToLineStart(enc('no newline at all')).bytes.length).toBe(0);
  });

  it('strips terminal escapes and filters lines', () => {
    expect(stripAnsi('\x1b[31mERROR\x1b[0m done \x1b]0;title\x07ok')).toBe('ERROR done ok');
    expect(filterLines('a error\nb ok\nc ERROR', 'error')).toEqual({ text: 'a error\nc ERROR', count: 2 });
    expect(filterLines('x', '  ').count).toBe(-1);
  });

  it('dumps hex with offsets and ASCII', () => {
    const dump = hexDump(enc('Hello, world!\n\x00\x01'), 0x20);
    expect(dump.split('\n')[0]).toBe('00000020  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a 00 01  |Hello, world!...|');
  });

  it('names binaries by their signature and tells text from binary', () => {
    expect(sniffMagic(enc('\x7fELF\x02\x01'))).toMatch(/ELF/);
    expect(sniffMagic(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('PNG image');
    expect(sniffMagic(enc('SQLite format 3\x00…'))).toBe('SQLite database');
    expect(sniffMagic(enc('plain'))).toBeNull();
    expect(looksLikeText(enc('héllo\nwörld'))).toBe(true);
    expect(looksLikeText(Uint8Array.from([0x68, 0x00, 0x69]))).toBe(false);
    // A UTF-8 character cut by the 8 KB window is still text.
    const big = enc('é'.repeat(5000));
    expect(looksLikeText(big)).toBe(true);
    expect(fromBase64(btoa('abc'))).toEqual(enc('abc'));
  });
});

describe('the JSON tree', () => {
  it('reads JSONC (tsconfig) and JSON Lines', () => {
    const tsconfig = '{\n  // comment\n  "a": "x // not a comment", /* block */ "b": [1, 2,],\n}';
    expect(stripJsonComments(tsconfig)).not.toContain('block');
    const p = parseJsonDoc(tsconfig, 'tsconfig.json');
    expect(p).toMatchObject({ ok: true, loose: true, value: { a: 'x // not a comment', b: [1, 2] } });
    expect(parseJsonDoc('{"a":1}\n\n{"a":2}\n', 'e.jsonl')).toMatchObject({ ok: true, lines: 2, value: [{ a: 1 }, { a: 2 }] });
    expect(parseJsonDoc('{"a":1}\n{oops}', 'e.ndjson')).toMatchObject({ ok: false });
    expect(parseJsonDoc('{"a":', 'x.json').ok).toBe(false);
  });

  it('writes jq paths', () => {
    expect(jqPath([])).toBe('.');
    expect(jqPath(['users', 0, 'name'])).toBe('.users[0].name');
    expect(jqPath(['content-type'])).toBe('.["content-type"]');
    expect(jqPath([3, 'a b'])).toBe('.[3]["a b"]');
  });

  it('finds keys and values, and what must open to show them', () => {
    const doc = { users: [{ name: 'Ada' }, { name: 'Bob', role: 'admin' }], admin: false };
    const r = searchJson(doc, 'admin');
    expect([...r.matches].sort()).toEqual([pathKey(['admin']), pathKey(['users', 1, 'role'])].sort());
    expect(r.open.has(pathKey(['users', 1]))).toBe(true);
    expect(r.open.has(pathKey([]))).toBe(true);
    expect(containerPaths(doc)).toHaveLength(4);
  });
});

describe('the table editor', () => {
  it('writes a CSV back in its own format', () => {
    const crlf = '﻿name;note\r\nada;"a; b"\r\n';
    const t = parseCsv(crlf);
    const fmt = detectCsvFormat(crlf);
    expect(fmt).toEqual({ bom: true, eol: '\r\n', trailingNewline: true });
    expect(serializeCsv(t.rows, t.delimiter, fmt)).toBe(crlf);
    const rows = [['a', 'say "hi"'], ['multi\nline', ' padded ']];
    expect(serializeCsv(rows, ',', { bom: false, eol: '\n', trailingNewline: false }))
      .toBe('a,"say ""hi"""\n"multi\nline"," padded "');
    expect(parseCsv(serializeCsv(rows, ',', { bom: false, eol: '\n', trailingNewline: false })).rows).toEqual(rows);
  });

  it('reads numbers the way people type them', () => {
    expect(numericValue('1234.5')).toBe(1234.5);
    expect(numericValue('1,234.5')).toBe(1234.5);
    expect(numericValue('1 234,5')).toBe(1234.5);
    expect(numericValue('-3e2')).toBe(-300);
    for (const s of ['', 'abc', '1.2.3', '12a', '2026-10-22']) expect(numericValue(s), s).toBeNull();
  });

  it('sorts naturally, numbers as numbers, empties last', () => {
    const v = ['10', '', 'b', '2', 'a10', 'a2', '1,5'];
    expect([...v].sort(compareCells)).toEqual(['1,5', '2', '10', 'a2', 'a10', 'b', '']);
  });

  it('spots a header row and pastes from Sheets', () => {
    expect(looksLikeHeader([['name', 'age'], ['ada', '36']])).toBe(true);
    expect(looksLikeHeader([['1', '2'], ['3', '4']])).toBe(false);
    expect(looksLikeHeader([['name', 'name'], ['a', 'b']])).toBe(false);
    expect(parseClipboard('a\tb\nc\td\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseClipboard('one value')).toEqual([['one value']]);
  });
});
