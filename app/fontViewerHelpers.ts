// Pure helpers of the font pane (FontViewer.tsx, §14.112): what a font file
// is, the names and character map it declares, and the glyph grid's
// contents. No React, no DOM — vitest runs them in node. Only TrueType/CFF
// (`sfnt`) and WOFF 1 tables are read: WOFF2 is one Brotli stream the
// browser offers no decoder for, so its names stay unknown and its coverage
// is measured instead (FontViewer).

export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2';

/** Extensions the font pane accepts (lower case, no dot). */
export const FONT_EXTENSIONS: readonly FontFormat[] = ['ttf', 'otf', 'woff', 'woff2'];

export function fontFormatFromName(name: string): FontFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (FONT_EXTENSIONS as readonly string[]).includes(ext ?? '') ? ext as FontFormat : null;
}

/** What the bytes say they are — the extension can lie. */
export type FontKind = 'truetype' | 'cff' | 'woff' | 'woff2' | 'collection';

export function sniffFont(bytes: Uint8Array): FontKind | null {
  if (bytes.length < 4) return null;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag === '\0\x01\0\0' || tag === 'true') return 'truetype';
  if (tag === 'OTTO') return 'cff';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'ttcf') return 'collection';
  return null;
}

export function fontKindLabel(kind: FontKind | null, fallback: FontFormat | null): string {
  switch (kind) {
    case 'truetype': return 'TrueType';
    case 'cff': return 'OpenType (CFF)';
    case 'woff': return 'WOFF';
    case 'woff2': return 'WOFF2';
    case 'collection': return 'font collection';
    default: return fallback ? fallback.toUpperCase() : 'font';
  }
}

// ── Tables ──────────────────────────────────────────────────────────────────

/** Where a table sits; `compLength` < `length` = zlib-compressed (WOFF). */
export type TableRef = { offset: number; length: number; compLength?: number };

/** The table directory of an sfnt or WOFF 1 file, null for anything else. */
export function tableDirectory(buf: ArrayBuffer): Map<string, TableRef> | null {
  const bytes = new Uint8Array(buf);
  const kind = sniffFont(bytes);
  if (kind !== 'truetype' && kind !== 'cff' && kind !== 'woff') return null;
  try {
    const v = new DataView(buf);
    const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const out = new Map<string, TableRef>();
    if (kind === 'woff') {
      const n = v.getUint16(12);
      for (let i = 0; i < n; i++) {
        const at = 44 + i * 20;
        out.set(tag(at), { offset: v.getUint32(at + 4), compLength: v.getUint32(at + 8), length: v.getUint32(at + 12) });
      }
    } else {
      const n = v.getUint16(4);
      for (let i = 0; i < n; i++) {
        const at = 12 + i * 16;
        out.set(tag(at), { offset: v.getUint32(at + 8), length: v.getUint32(at + 12) });
      }
    }
    return out;
  } catch {
    return null;
  }
}

export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

/** zlib (RFC 1950, what WOFF stores) via the platform's DecompressionStream. */
export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The bytes of the wanted tables, decompressed. A table that is absent,
 * out of bounds or fails to inflate is simply missing from the result: the
 * pane then shows less, never an error — the browser already accepted the
 * font.
 */
export async function readTables(
  buf: ArrayBuffer, tags: readonly string[], inflate: Inflate = inflateZlib,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const dir = tableDirectory(buf);
  if (!dir) return out;
  for (const tag of tags) {
    const ref = dir.get(tag);
    if (!ref) continue;
    const stored = ref.compLength ?? ref.length;
    if (ref.offset + stored > buf.byteLength) continue;
    const raw = new Uint8Array(buf, ref.offset, stored);
    if (ref.compLength !== undefined && ref.compLength < ref.length) {
      try { out.set(tag, await inflate(raw)); } catch { /* skipped */ }
    } else {
      out.set(tag, raw);
    }
  }
  return out;
}

function viewOf(t: Uint8Array): DataView {
  return new DataView(t.buffer, t.byteOffset, t.byteLength);
}

// ── name ────────────────────────────────────────────────────────────────────

export type FontNames = {
  family?: string;
  subfamily?: string;
  fullName?: string;
  version?: string;
  manufacturer?: string;
  designer?: string;
  copyright?: string;
};

const NAME_IDS: Record<number, keyof FontNames> = {
  0: 'copyright', 1: 'family', 2: 'subfamily', 4: 'fullName', 5: 'version', 8: 'manufacturer', 9: 'designer',
};

function utf16be(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return s;
}

let macDecoder: TextDecoder | null | undefined;
function macRoman(b: Uint8Array): string {
  if (macDecoder === undefined) {
    try { macDecoder = new TextDecoder('macintosh'); } catch { macDecoder = null; }
  }
  return macDecoder ? macDecoder.decode(b) : String.fromCharCode(...b);
}

/**
 * The human names of an OpenType `name` table. Windows English records win,
 * then any Windows/Unicode record, then Mac Roman. The typographic family
 * and style (IDs 16/17) beat the legacy ones (1/2), which squeeze every
 * weight past Bold into the family: "Inter SemiBold" / "Regular" instead of
 * "Inter" / "SemiBold".
 */
export function parseNameTable(t: Uint8Array): FontNames {
  const out: FontNames = {};
  try {
    const v = viewOf(t);
    const count = v.getUint16(2);
    const strings = v.getUint16(4);
    const best = new Map<number, { score: number; text: string }>();
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 12;
      if (at + 12 > t.length) break;
      const platform = v.getUint16(at);
      const encoding = v.getUint16(at + 2);
      const language = v.getUint16(at + 4);
      const id = v.getUint16(at + 6);
      const length = v.getUint16(at + 8);
      const offset = v.getUint16(at + 10);
      if (!(id in NAME_IDS) && id !== 16 && id !== 17) continue;
      let score = 0;
      if (platform === 3 && (encoding === 1 || encoding === 10)) score = language === 0x409 ? 4 : 3;
      else if (platform === 0) score = 2;
      else if (platform === 1 && encoding === 0) score = language === 0 ? 1.5 : 1;
      if (!score || score <= (best.get(id)?.score ?? 0)) continue;
      const start = strings + offset;
      if (start + length > t.length) continue;
      const raw = t.subarray(start, start + length);
      const text = (platform === 1 ? macRoman(raw) : utf16be(raw)).replace(/\0/g, '').trim();
      if (text) best.set(id, { score, text });
    }
    for (const [id, key] of Object.entries(NAME_IDS)) {
      const hit = best.get(Number(id));
      if (hit) out[key] = hit.text;
    }
    const family = best.get(16)?.text;
    const style = best.get(17)?.text;
    if (family) out.family = family;
    if (style) out.subfamily = style;
  } catch { /* a truncated table yields what was read */ }
  return out;
}

/** `Version 2.001;hotconv 1.0.109` → `2.001`. */
export function shortVersion(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.split(';')[0].replace(/^version\s*/i, '').trim();
  return s || null;
}

// ── cmap / maxp ─────────────────────────────────────────────────────────────

/**
 * Every code point the `cmap` maps to a real glyph (format 12 full-Unicode,
 * else format 4 BMP; a symbol-encoded table as a last resort). Null when no
 * readable subtable exists — the caller then measures instead. Bounded by
 * `cap`: a pathological format-12 group must not allocate a million entries.
 */
export function parseCmap(t: Uint8Array, cap = 200_000): Set<number> | null {
  try {
    const v = viewOf(t);
    const n = v.getUint16(2);
    let pick: { off: number; format: number; rank: number } | null = null;
    for (let i = 0; i < n; i++) {
      const p = v.getUint16(4 + i * 8);
      const e = v.getUint16(6 + i * 8);
      const off = v.getUint32(8 + i * 8);
      if (off + 4 > t.length) continue;
      const format = v.getUint16(off);
      const unicode = p === 0 || (p === 3 && (e === 1 || e === 10));
      const rank = format === 12 && unicode ? 3
        : format === 4 && unicode ? 2
        : format === 4 && p === 3 && e === 0 ? 1
        : 0;
      if (rank > (pick?.rank ?? 0)) pick = { off, format, rank };
    }
    if (!pick) return null;
    const out = new Set<number>();
    const { off } = pick;
    if (pick.format === 12) {
      const groups = v.getUint32(off + 12);
      for (let g = 0; g < groups; g++) {
        const at = off + 16 + g * 12;
        const start = v.getUint32(at);
        const end = Math.min(v.getUint32(at + 4), 0x10ffff);
        const glyph = v.getUint32(at + 8);
        for (let c = start; c <= end; c++) {
          if (glyph + (c - start) !== 0) out.add(c);
          if (out.size >= cap) return out;
        }
      }
      return out;
    }
    const segX2 = v.getUint16(off + 6);
    const ends = off + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = v.getUint16(ends + i * 2);
      const start = v.getUint16(starts + i * 2);
      const delta = v.getUint16(deltas + i * 2);
      const rangeAt = ranges + i * 2;
      const range = v.getUint16(rangeAt);
      for (let c = start; c <= Math.min(end, 0xfffe); c++) {
        let glyph: number;
        if (range === 0) {
          glyph = (c + delta) & 0xffff;
        } else {
          const at = rangeAt + range + (c - start) * 2;
          glyph = at + 2 <= t.length ? v.getUint16(at) : 0;
          if (glyph) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph) out.add(c);
        if (out.size >= cap) return out;
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** `maxp.numGlyphs`, null when unreadable. */
export function parseGlyphCount(maxp: Uint8Array): number | null {
  return maxp.length >= 6 ? viewOf(maxp).getUint16(4) : null;
}

// ── The glyph grid ──────────────────────────────────────────────────────────

export type GlyphGroup = { label: string; codes: readonly number[] };

const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const sorted = (codes: number[]) => [...new Set(codes)].sort((a, b) => a - b);

/** What every Latin text font is checked for, in reading order. */
export const GLYPH_GROUPS: readonly GlyphGroup[] = [
  { label: 'Basic Latin', codes: span(0x21, 0x7e) },
  // U+00A0 (no-break space) and U+00AD (soft hyphen) draw nothing.
  { label: 'Latin-1 Supplement', codes: span(0xa1, 0xff).filter((c) => c !== 0xad) },
  { label: 'Latin Extended-A', codes: span(0x100, 0x17f) },
  {
    label: 'Punctuation',
    codes: sorted([
      ...span(0x2010, 0x2015), ...span(0x2018, 0x201f), 0x2020, 0x2021, 0x2022, 0x2026, 0x2030,
      0x2032, 0x2033, 0x2039, 0x203a, 0x203d, 0x2044, 0x2116, 0x2122, 0x02c6, 0x02c7,
      ...span(0x02d8, 0x02dd), 0xfb01, 0xfb02,
    ]),
  },
  {
    label: 'Currency',
    codes: sorted([
      0x20a1, 0x20a3, 0x20a4, 0x20a6, 0x20a8, 0x20a9, 0x20aa, 0x20ab, 0x20ac, 0x20ad, 0x20ae,
      0x20b1, 0x20b4, 0x20b5, 0x20b8, 0x20b9, 0x20ba, 0x20bc, 0x20bd, 0x20be, 0x20bf,
    ]),
  },
  {
    label: 'Arrows & math',
    codes: sorted([
      ...span(0x2190, 0x2199), 0x21a9, 0x21aa, 0x21b5, ...span(0x21d0, 0x21d4), 0x2202, 0x2206,
      0x220f, 0x2211, 0x2212, 0x2215, 0x2219, 0x221a, 0x221e, 0x222b, 0x2248, 0x2260, 0x2264,
      0x2265, 0x25ca,
    ]),
  },
];

/** A code point that draws something by itself in a grid cell. */
export function isVisibleCode(c: number): boolean {
  if (c < 0x21 || (c >= 0x7f && c <= 0xa0) || c === 0xad) return false; // controls, spaces
  if (c >= 0xd800 && c <= 0xdfff) return false; // surrogates
  if ((c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe) return false; // noncharacters
  if ((c >= 0x2000 && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || (c >= 0x205f && c <= 0x206f)) return false;
  if (c === 0x1680 || c === 0x180e || c === 0x3000 || c === 0xfeff || (c >= 0xfff9 && c <= 0xfffb)) return false;
  if ((c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0000 && c <= 0xe0fff)) return false; // selectors, tags
  return c <= 0x10ffff;
}

/**
 * The font's characters the standard groups do not show — an icon font's
 * private-use glyphs, a CJK or Cyrillic repertoire — ascending, at most
 * `cap` of them; `more` counts the rest.
 */
export function extraCodes(
  covered: ReadonlySet<number>, groups: readonly GlyphGroup[] = GLYPH_GROUPS, cap = 1500,
): { codes: number[]; more: number } {
  const known = new Set(groups.flatMap((g) => g.codes));
  const all = [...covered].filter((c) => !known.has(c) && isVisibleCode(c)).sort((a, b) => a - b);
  return { codes: all.slice(0, cap), more: Math.max(0, all.length - cap) };
}

/** `0xe9` → `U+00E9`. */
export function formatCodepoint(c: number): string {
  return `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
}

export const DEFAULT_SAMPLE = 'Portez ce vieux whisky au juge blond qui fume — à côté, ça coûte 12 € · 0123456789';
export const WATERFALL_SIZES: readonly number[] = [12, 16, 20, 24, 32, 48, 72];

/** One sentence for the error note. */
export function describeFontError(e: unknown): string {
  const err = e as { name?: string; message?: string } | null;
  const msg = String(err?.message ?? e ?? '');
  if (err?.name === 'FileFetchError') {
    return msg.startsWith('the file') ? msg : `could not read this file from the VPS: ${msg}`;
  }
  return 'could not decode this font — the file is damaged or not a TTF, OTF, WOFF or WOFF2 font';
}
