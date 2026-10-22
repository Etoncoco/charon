import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  GLYPH_GROUPS, describeFontError, extraCodes, fontFormatFromName, fontKindLabel, formatCodepoint,
  isVisibleCode, parseCmap, parseGlyphCount, parseNameTable, readTables, shortVersion, sniffFont,
  tableDirectory,
} from '../app/fontViewerHelpers';
import { FileFetchError } from '../app/modelViewerHelpers';

// §14.112: the font pane's pure helpers, against hand-built font tables.

/** Big-endian byte writer — every OpenType structure is big-endian. */
class W {
  private out: number[] = [];
  u8(v: number) { this.out.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v >> 8).u8(v); }
  u32(v: number) { return this.u16(v >>> 16).u16(v & 0xffff); }
  tag(t: string) { for (const ch of t) this.u8(ch.charCodeAt(0)); return this; }
  bytes(b: Uint8Array) { for (const x of b) this.u8(x); return this; }
  get length() { return this.out.length; }
  done() { return new Uint8Array(this.out); }
}

const utf16be = (s: string) => {
  const w = new W();
  for (let i = 0; i < s.length; i++) w.u16(s.charCodeAt(i));
  return w.done();
};
const latin1 = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

type NameRec = { platform: number; encoding: number; language: number; id: number; text: string };

function nameTable(recs: NameRec[]): Uint8Array {
  const strings = recs.map((r) => (r.platform === 1 ? latin1(r.text) : utf16be(r.text)));
  const w = new W().u16(0).u16(recs.length).u16(6 + recs.length * 12);
  let offset = 0;
  recs.forEach((r, i) => {
    w.u16(r.platform).u16(r.encoding).u16(r.language).u16(r.id).u16(strings[i].length).u16(offset);
    offset += strings[i].length;
  });
  strings.forEach((s) => w.bytes(s));
  return w.done();
}

/**
 * A format-4 subtable: A–C through idDelta (glyphs 1–3), é/ê through the
 * glyph array (é → 5, ê → 0 = missing), then the 0xFFFF terminator.
 */
function cmap4(): Uint8Array {
  const segs = 3;
  const w = new W().u16(4).u16(0).u16(0).u16(segs * 2).u16(4).u16(1).u16(2);
  [0x43, 0xea, 0xffff].forEach((e) => w.u16(e));
  w.u16(0);
  [0x41, 0xe9, 0xffff].forEach((s) => w.u16(s));
  [(1 - 0x41) & 0xffff, 0, 1].forEach((d) => w.u16(d));
  // Segment 1 points (segs - 1) words ahead: the first glyph-array entry.
  [0, (segs - 1) * 2, 0].forEach((r) => w.u16(r));
  [5, 0].forEach((g) => w.u16(g));
  return w.done();
}

/** A format-12 subtable: A–B and one emoji. */
function cmap12(): Uint8Array {
  const groups: [number, number, number][] = [[0x41, 0x42, 1], [0x1f600, 0x1f600, 9]];
  const w = new W().u16(12).u16(0).u32(16 + groups.length * 12).u32(0).u32(groups.length);
  for (const [s, e, g] of groups) w.u32(s).u32(e).u32(g);
  return w.done();
}

function cmapTable(subs: { platform: number; encoding: number; data: Uint8Array }[]): Uint8Array {
  const w = new W().u16(0).u16(subs.length);
  let offset = 4 + subs.length * 8;
  for (const s of subs) { w.u16(s.platform).u16(s.encoding).u32(offset); offset += s.data.length; }
  for (const s of subs) w.bytes(s.data);
  return w.done();
}

const maxp = (glyphs: number) => new W().u32(0x00005000).u16(glyphs).done();

function sfnt(tables: Record<string, Uint8Array>, signature: number | string = 0x00010000): ArrayBuffer {
  const tags = Object.keys(tables).sort();
  const w = new W();
  if (typeof signature === 'string') w.tag(signature); else w.u32(signature);
  w.u16(tags.length).u16(0).u16(0).u16(0);
  let offset = 12 + tags.length * 16;
  const padded = (n: number) => (n + 3) & ~3;
  for (const t of tags) { w.tag(t).u32(0).u32(offset).u32(tables[t].length); offset += padded(tables[t].length); }
  for (const t of tags) {
    w.bytes(tables[t]);
    for (let i = tables[t].length; i < padded(tables[t].length); i++) w.u8(0);
  }
  return w.done().buffer as ArrayBuffer;
}

/**
 * WOFF 1: tables zlib-compressed unless `stored` names them or compression
 * would not shrink them (the spec then stores them as they are).
 */
function woff(tables: Record<string, Uint8Array>, stored: string[] = []): ArrayBuffer {
  const tags = Object.keys(tables).sort();
  const data = tags.map((t) => {
    const z = new Uint8Array(deflateSync(tables[t]));
    return stored.includes(t) || z.length >= tables[t].length ? tables[t] : z;
  });
  const w = new W().tag('wOFF').u32(0x00010000).u32(0).u16(tags.length).u16(0).u32(0).u16(1).u16(0)
    .u32(0).u32(0).u32(0).u32(0).u32(0);
  let offset = 44 + tags.length * 20;
  tags.forEach((t, i) => { w.tag(t).u32(offset).u32(data[i].length).u32(tables[t].length).u32(0); offset += data[i].length; });
  data.forEach((d) => w.bytes(d));
  return w.done().buffer as ArrayBuffer;
}

const NAMES = nameTable([
  { platform: 1, encoding: 0, language: 0, id: 1, text: 'Mac Family' },
  { platform: 3, encoding: 1, language: 0x40c, id: 1, text: 'Famille' },
  { platform: 3, encoding: 1, language: 0x409, id: 1, text: 'Test Sans SemiBold' },
  { platform: 3, encoding: 1, language: 0x409, id: 2, text: 'Regular' },
  { platform: 3, encoding: 1, language: 0x409, id: 16, text: 'Test Sans' },
  { platform: 3, encoding: 1, language: 0x409, id: 17, text: 'SemiBold' },
  { platform: 3, encoding: 1, language: 0x409, id: 5, text: 'Version 2.001;hotconv 1.0' },
  { platform: 1, encoding: 0, language: 0, id: 9, text: 'Ada Lovelace' },
  { platform: 3, encoding: 1, language: 0x409, id: 0, text: '© 2026 Example\0' },
]);

describe('what a font file is', () => {
  it('reads the extension', () => {
    expect(fontFormatFromName('Inter.WOFF2')).toBe('woff2');
    expect(fontFormatFromName('a.otf')).toBe('otf');
    expect(fontFormatFromName('a.ttc')).toBeNull();
  });

  it('trusts the magic over the name', () => {
    const tag = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    expect(sniffFont(new Uint8Array([0, 1, 0, 0, 9]))).toBe('truetype');
    expect(sniffFont(tag('OTTO'))).toBe('cff');
    expect(sniffFont(tag('wOFF'))).toBe('woff');
    expect(sniffFont(tag('wOF2'))).toBe('woff2');
    expect(sniffFont(tag('ttcf'))).toBe('collection');
    expect(sniffFont(tag('<htm'))).toBeNull();
    expect(fontKindLabel('cff', 'otf')).toBe('OpenType (CFF)');
    expect(fontKindLabel(null, 'ttf')).toBe('TTF');
  });
});

describe('the table directory', () => {
  it('lists sfnt tables and reads them', async () => {
    const buf = sfnt({ name: NAMES, maxp: maxp(321) }, 'OTTO');
    expect([...tableDirectory(buf)!.keys()].sort()).toEqual(['maxp', 'name']);
    const tables = await readTables(buf, ['name', 'maxp', 'cmap']);
    expect(tables.has('cmap')).toBe(false);
    expect(parseGlyphCount(tables.get('maxp')!)).toBe(321);
    expect(parseNameTable(tables.get('name')!).family).toBe('Test Sans');
  });

  it('inflates WOFF tables, stored ones read as they are', async () => {
    const buf = woff({ name: NAMES, maxp: maxp(7), cmap: cmapTable([{ platform: 3, encoding: 1, data: cmap4() }]) }, ['maxp']);
    const dir = tableDirectory(buf)!;
    expect(dir.get('maxp')).toMatchObject({ length: 6, compLength: 6 });
    expect(dir.get('name')!.compLength).toBeLessThan(dir.get('name')!.length);
    const tables = await readTables(buf, ['name', 'maxp', 'cmap']);
    expect(parseGlyphCount(tables.get('maxp')!)).toBe(7);
    expect(parseNameTable(tables.get('name')!).subfamily).toBe('SemiBold');
    expect([...parseCmap(tables.get('cmap')!)!].sort((a, b) => a - b)).toEqual([0x41, 0x42, 0x43, 0xe9]);
  });

  it('skips a table that fails to inflate instead of failing', async () => {
    const buf = woff({ name: NAMES, maxp: maxp(7) });
    const tables = await readTables(buf, ['name', 'maxp'], async () => { throw new Error('corrupt'); });
    expect(tables.has('name')).toBe(false);
    expect(parseGlyphCount(tables.get('maxp')!)).toBe(7);
  });

  it('is null for WOFF2 and junk, and survives a truncated directory', async () => {
    expect(tableDirectory(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0]).buffer)).toBeNull();
    expect(tableDirectory(new Uint8Array(8).buffer)).toBeNull();
    const cut = sfnt({ name: NAMES }).slice(0, 20);
    expect(tableDirectory(cut)).toBeNull();
    expect((await readTables(cut, ['name'])).size).toBe(0);
  });
});

describe('the name table', () => {
  it('prefers Windows English, typographic family/style, and falls back to Mac', () => {
    expect(parseNameTable(NAMES)).toEqual({
      family: 'Test Sans',
      subfamily: 'SemiBold',
      version: 'Version 2.001;hotconv 1.0',
      designer: 'Ada Lovelace',
      copyright: '© 2026 Example',
    });
  });

  it('uses the legacy names when no typographic ones exist', () => {
    const t = nameTable([
      { platform: 3, encoding: 1, language: 0x409, id: 1, text: 'Plain' },
      { platform: 3, encoding: 1, language: 0x409, id: 2, text: 'Italic' },
      { platform: 3, encoding: 1, language: 0x409, id: 4, text: 'Plain Italic' },
    ]);
    expect(parseNameTable(t)).toEqual({ family: 'Plain', subfamily: 'Italic', fullName: 'Plain Italic' });
  });

  it('keeps what it read from a truncated table', () => {
    expect(parseNameTable(NAMES.subarray(0, 10))).toEqual({});
  });

  it('shortens versions', () => {
    expect(shortVersion('Version 2.001;hotconv 1.0')).toBe('2.001');
    expect(shortVersion('1.0')).toBe('1.0');
    expect(shortVersion(undefined)).toBeNull();
    expect(shortVersion('Version ')).toBeNull();
  });
});

describe('the character map', () => {
  it('reads format 4 through idDelta and the glyph array, skipping glyph 0', () => {
    const set = parseCmap(cmapTable([{ platform: 3, encoding: 1, data: cmap4() }]))!;
    expect([...set].sort((a, b) => a - b)).toEqual([0x41, 0x42, 0x43, 0xe9]);
  });

  it('prefers format 12 when both exist', () => {
    const set = parseCmap(cmapTable([
      { platform: 3, encoding: 1, data: cmap4() },
      { platform: 3, encoding: 10, data: cmap12() },
    ]))!;
    expect([...set].sort((a, b) => a - b)).toEqual([0x41, 0x42, 0x1f600]);
  });

  it('is bounded, and null without a usable subtable', () => {
    const many = new W().u16(12).u16(0).u32(28).u32(0).u32(1).u32(0x4e00).u32(0x9fff).u32(1).done();
    expect(parseCmap(cmapTable([{ platform: 0, encoding: 4, data: many }]), 100)!.size).toBe(100);
    expect(parseCmap(cmapTable([{ platform: 1, encoding: 0, data: cmap4() }]))).toBeNull();
    expect(parseCmap(new Uint8Array(3))).toBeNull();
  });
});

describe('the glyph grid', () => {
  it('lists every standard character once, visible, ascending', () => {
    const all = GLYPH_GROUPS.flatMap((g) => g.codes);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every(isVisibleCode)).toBe(true);
    for (const g of GLYPH_GROUPS) expect([...g.codes]).toEqual([...g.codes].sort((a, b) => a - b));
    expect(all).toContain(0x41);
    expect(all).toContain(0xe9);
    expect(all).toContain(0x20ac);
    expect(all).toContain(0x2192);
    expect(all).not.toContain(0x20);
    expect(all).not.toContain(0xad);
  });

  it('knows which code points draw nothing', () => {
    for (const c of [0x0a, 0x20, 0x7f, 0x85, 0xa0, 0xad, 0x200b, 0x2028, 0xfeff, 0xfe0f, 0xd800, 0xffff, 0xe0001]) {
      expect(isVisibleCode(c)).toBe(false);
    }
    for (const c of [0x21, 0xe9, 0x4e00, 0xe000, 0x1f600]) expect(isVisibleCode(c)).toBe(true);
  });

  it('shows the rest of the repertoire, capped', () => {
    const covered = new Set([0x41, 0x20, 0xe001, 0xe000, 0x4e00, 0x200b, 0xe002]);
    expect(extraCodes(covered)).toEqual({ codes: [0x4e00, 0xe000, 0xe001, 0xe002], more: 0 });
    expect(extraCodes(covered, GLYPH_GROUPS, 2)).toEqual({ codes: [0x4e00, 0xe000], more: 2 });
  });

  it('prints code points', () => {
    expect(formatCodepoint(0xe9)).toBe('U+00E9');
    expect(formatCodepoint(0x20ac)).toBe('U+20AC');
    expect(formatCodepoint(0x1f600)).toBe('U+1F600');
  });
});

describe('error sentences', () => {
  it('separates a failed read from a bad font', () => {
    expect(describeFontError(new FileFetchError('file not found', 404))).toBe('could not read this file from the VPS: file not found');
    expect(describeFontError(Object.assign(new Error('x'), { name: 'SyntaxError' }))).toMatch(/could not decode this font/);
  });
});
