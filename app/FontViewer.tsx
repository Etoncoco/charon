'use client';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ByteViewerProps } from './fileViews';
import { formatBytes, formatCount, readFileBytes } from './modelViewerHelpers';
import {
  DEFAULT_SAMPLE, GLYPH_GROUPS, WATERFALL_SIZES, describeFontError, extraCodes, fontFormatFromName,
  fontKindLabel, formatCodepoint, parseCmap, parseGlyphCount, parseNameTable, readTables, shortVersion,
  sniffFont, tableDirectory, type FontKind, type FontNames,
} from './fontViewerHelpers';

// The font pane (§14.112): TTF, OTF, WOFF, WOFF2. The file is loaded as a
// FontFace under a family name of its own — several fonts can be open at
// once, and none may shadow a family the hub itself uses — and removed from
// `document.fonts` when the pane goes or the file is reloaded.

/** CJK fonts weigh tens of MB; past this a font is not worth a tab's memory. */
const MAX_FONT_BYTES = 100 * 1024 * 1024;

let faceSeq = 0;
// A newly opened font starts with the text the reader last typed: comparing
// two fonts means the same words in both.
let lastSample = DEFAULT_SAMPLE;

type Loaded = {
  family: string;
  face: FontFace;
  bytes: number;
  kind: FontKind | null;
  names: FontNames;
  glyphs: number | null;
  variable: boolean;
  /** From the cmap; null = unknown (WOFF2), measured instead. */
  covered: Set<number> | null;
};

/**
 * Which of `codes` the font draws itself, for a font whose cmap cannot be
 * read. A character the font lacks falls back to another font, and three
 * different fallbacks give it different widths; one it has measures the same
 * under all three. The test can only err towards "present" (a character no
 * fallback has either), never hide a real glyph.
 */
function measureCoverage(family: string, codes: readonly number[]): Set<number> | null {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const widths = (fallback: string) => {
    ctx.font = `40px "${family}", ${fallback}`;
    return codes.map((c) => ctx.measureText(String.fromCodePoint(c)).width);
  };
  const a = widths('monospace');
  const b = widths('serif');
  const s = widths('sans-serif');
  const out = new Set<number>();
  codes.forEach((c, i) => { if (a[i] === b[i] && b[i] === s[i]) out.add(c); });
  return out;
}

export default function FontViewer({ name, url, rev }: ByteViewerProps) {
  const [font, setFont] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sample, setSample] = useState(lastSample);
  const [copied, setCopied] = useState<number | null>(null);
  const fontRef = useRef<Loaded | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setErr(null);
    setLoading(true);
    (async () => {
      const res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
      const buf = await readFileBytes(res, undefined, MAX_FONT_BYTES);
      if (!alive) return;
      const family = `charon-font-${++faceSeq}`;
      const face = new FontFace(family, buf);
      await face.load();
      const tables = await readTables(buf, ['name', 'cmap', 'maxp']);
      // Never added to document.fonts: nothing to take back.
      if (!alive) return;
      const nameTable = tables.get('name');
      const cmap = tables.get('cmap');
      const maxp = tables.get('maxp');
      const next: Loaded = {
        family,
        face,
        bytes: buf.byteLength,
        kind: sniffFont(new Uint8Array(buf)),
        names: nameTable ? parseNameTable(nameTable) : {},
        glyphs: maxp ? parseGlyphCount(maxp) : null,
        variable: !!tableDirectory(buf)?.has('fvar'),
        covered: cmap ? parseCmap(cmap) : null,
      };
      document.fonts.add(face);
      // The previous face stays until its replacement is ready: a reload
      // must not flash the page font.
      const prev = fontRef.current;
      fontRef.current = next;
      setFont(next);
      if (prev) document.fonts.delete(prev.face);
    })().catch((e: unknown) => {
      if (alive && !ctrl.signal.aborted) setErr(describeFontError(e));
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; ctrl.abort(); };
  }, [url, rev]);

  useEffect(() => () => {
    if (fontRef.current) document.fonts.delete(fontRef.current.face);
    fontRef.current = null;
  }, []);

  useEffect(() => {
    if (copied == null) return;
    const t = setTimeout(() => setCopied(null), 1000);
    return () => clearTimeout(t);
  }, [copied]);

  const groups = useMemo(() => {
    if (!font) return [];
    const covered = font.covered ?? measureCoverage(font.family, GLYPH_GROUPS.flatMap((g) => g.codes));
    const shown = GLYPH_GROUPS.map((g) => ({
      label: g.label,
      total: g.codes.length,
      codes: covered ? g.codes.filter((c) => covered.has(c)) : [...g.codes],
      more: 0,
    }));
    if (font.covered) {
      const extra = extraCodes(font.covered);
      if (extra.codes.length) {
        shown.push({ label: 'Other characters', total: 0, codes: extra.codes, more: extra.more });
      }
    }
    return shown;
  }, [font]);

  const copy = (c: number) => {
    // Clipboard access can be refused (insecure origin, permissions): the
    // cell then simply does not say "copied".
    navigator.clipboard?.writeText(String.fromCodePoint(c)).then(() => setCopied(c), () => {});
  };

  const changeSample = (text: string) => {
    lastSample = text || DEFAULT_SAMPLE;
    setSample(text);
  };

  const text = sample || DEFAULT_SAMPLE;
  const format = fontFormatFromName(name);
  const facts = font ? [fontKindLabel(font.kind, format), formatBytes(font.bytes)] : [];
  const family = font?.names.family ?? name.replace(/\.[^.]+$/, '');
  const version = shortVersion(font?.names.version);
  const meta = font ? [
    font.names.subfamily,
    version && `version ${version}`,
    font.glyphs != null && `${formatCount(font.glyphs)} glyphs`,
    font.variable && 'variable',
    font.names.designer ?? font.names.manufacturer,
  ].filter(Boolean) as string[] : [];
  const faceStyle = font ? { '--fntv-family': `"${font.family}"` } as CSSProperties : undefined;

  return (
    <div className="fntv" style={faceStyle}>
      <div className="viewer-bar">
        <span className="viewer-bar-note" title={name}>{[name, ...facts].join(' · ')}</span>
        {loading && <span className="viewer-bar-note">loading…</span>}
        <span className="viewer-bar-spacer" />
        <button type="button" disabled={sample === DEFAULT_SAMPLE} onClick={() => changeSample(DEFAULT_SAMPLE)}
                title="Back to the default sample text">
          Reset text
        </button>
      </div>
      {err && <div className="dvm-note err fntv-note">{err}</div>}
      {font && (
        <div className="fntv-scroll">
          <header className="fntv-head">
            <div className="fntv-family fntv-face">{family}</div>
            {meta.length > 0 && <div className="fntv-meta">{meta.join(' · ')}</div>}
            {font.names.copyright && <div className="fntv-copyright">{font.names.copyright}</div>}
          </header>

          <input
            className="fntv-sample"
            value={sample}
            placeholder={DEFAULT_SAMPLE}
            spellCheck={false}
            aria-label="sample text"
            onChange={(e) => changeSample(e.target.value)}
          />

          <section className="fntv-waterfall" aria-label="sizes">
            {WATERFALL_SIZES.map((px) => (
              <div className="fntv-row" key={px}>
                <span className="fntv-size">{px}</span>
                <span className="fntv-text fntv-face" style={{ fontSize: px }}>{text}</span>
              </div>
            ))}
          </section>

          {groups.map((g) => (
            <section className="fntv-group" key={g.label} aria-label={g.label}>
              <div className="fntv-group-head">
                <span>{g.label}</span>
                <span className="fntv-count">
                  {g.total ? `${g.codes.length} / ${g.total}` : formatCount(g.codes.length + g.more)}
                </span>
              </div>
              {g.codes.length === 0 ? (
                <div className="fntv-empty">none of these are in this font</div>
              ) : (
                <div className="fntv-grid">
                  {g.codes.map((c) => (
                    <button
                      type="button"
                      key={c}
                      className={`fntv-cell${copied === c ? ' copied' : ''}`}
                      title={`Copy ${String.fromCodePoint(c)}`}
                      onClick={() => copy(c)}
                    >
                      <span className="fntv-glyph fntv-face">{String.fromCodePoint(c)}</span>
                      <span className="fntv-code">{copied === c ? 'copied' : formatCodepoint(c)}</span>
                    </button>
                  ))}
                </div>
              )}
              {g.more > 0 && <div className="fntv-empty">{formatCount(g.more)} more not shown</div>}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
