'use client';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TextViewerProps } from './fileViews';
import {
  containerPaths, jqPath, parseJsonDoc, pathKey, searchJson, summarize, type JsonPath,
} from './jsonTree';

/** Children shown per container before "show more". */
const PAGE = 200;

type Ctx = {
  open: ReadonlySet<string>;
  matches: ReadonlySet<string>;
  limits: ReadonlyMap<string, number>;
  toggle: (key: string) => void;
  more: (key: string) => void;
  copy: (text: string, what: string) => void;
};

/**
 * JSON as a tree (§14.112): fold/unfold, filter on keys and values, click a
 * key to copy its jq path, a value to copy the value. Tolerates comments and
 * trailing commas (tsconfig.json), reads .jsonl/.ndjson as one array.
 */
export default function JsonViewer({ name, text }: TextViewerProps) {
  const parsed = useMemo(() => parseJsonDoc(text, name), [text, name]);
  const value = parsed.ok ? parsed.value : undefined;
  const [open, setOpen] = useState<Set<string>>(() => initialOpen(value));
  const [limits, setLimits] = useState<Map<string, number>>(new Map());
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new document (not a re-render of the same one) starts folded again.
  const shape = parsed.ok ? summarizeRoot(parsed.value) : '';
  const lastShape = useRef(shape);
  useEffect(() => {
    if (lastShape.current === shape) return;
    lastShape.current = shape;
    setOpen(initialOpen(value));
  }, [shape, value]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);
  const found = useMemo(() => searchJson(value, debounced), [value, debounced]);
  const filtering = debounced.trim() !== '';
  const effectiveOpen = filtering ? found.open : open;

  const copy = useCallback((t: string, what: string) => {
    void navigator.clipboard?.writeText(t).then(
      () => flash(`copied ${what}`), () => flash('could not copy'));
    function flash(msg: string) {
      if (noteTimer.current) clearTimeout(noteTimer.current);
      setNote(msg);
      noteTimer.current = setTimeout(() => setNote(null), 2500);
    }
  }, []);
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);

  const ctx: Ctx = useMemo(() => ({
    open: effectiveOpen,
    matches: found.matches,
    limits,
    toggle: (key) => {
      if (filtering) return;
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      });
    },
    more: (key) => setLimits((prev) => new Map(prev).set(key, (prev.get(key) ?? PAGE) + PAGE)),
    copy,
  }), [effectiveOpen, found.matches, limits, filtering, copy]);

  if (!parsed.ok) {
    return (
      <div className="jsonv">
        <div className="dvm-note err">not valid JSON — {parsed.error}. Switch to Code to fix it.</div>
      </div>
    );
  }
  return (
    <div className="jsonv">
      <div className="viewer-bar">
        <span className="viewer-bar-note">
          {note ?? (filtering
            ? `${found.matches.size}${found.truncated ? '+' : ''} match${found.matches.size === 1 ? '' : 'es'}`
            : `${shape}${parsed.loose ? ' · with comments' : ''}`)}
        </span>
        <input className="logv-filter" type="search" placeholder="filter keys and values"
               value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter keys and values" />
        <span className="viewer-bar-spacer" />
        <button type="button" disabled={filtering}
                onClick={() => setOpen(new Set(containerPaths(value)))}>Expand all</button>
        <button type="button" disabled={filtering} onClick={() => setOpen(new Set([pathKey([])]))}>Collapse</button>
        <button type="button" onClick={() => copy(JSON.stringify(value, null, 2), 'the document')}>Copy</button>
      </div>
      <div className="jsonv-scroll">
        <ul className="jsonv-tree" role="tree">
          <JsonNode label={null} value={value} path={[]} ctx={ctx} />
        </ul>
      </div>
    </div>
  );
}

function summarizeRoot(v: unknown): string {
  if (Array.isArray(v)) return `array · ${v.length} item${v.length === 1 ? '' : 's'}`;
  if (v && typeof v === 'object') {
    const n = Object.keys(v).length;
    return `object · ${n} key${n === 1 ? '' : 's'}`;
  }
  return v === null ? 'null' : typeof v;
}

function initialOpen(v: unknown): Set<string> {
  // The root, and its children when they are few: the shape at a glance.
  const out = new Set([pathKey([])]);
  if (v && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [i, x] as const) : Object.entries(v);
    if (entries.length <= 30) for (const [k, child] of entries) {
      if (child && typeof child === 'object') out.add(pathKey([k]));
    }
  }
  return out;
}

const JsonNode = memo(function JsonNode({ label, value, path, ctx }: {
  label: string | number | null; value: unknown; path: JsonPath; ctx: Ctx;
}) {
  const key = pathKey(path);
  const hit = ctx.matches.has(key);
  const keyEl = label == null ? null : (
    <button type="button" className={`jsonv-key${hit && typeof label === 'string' ? ' hit' : ''}`}
            onClick={() => ctx.copy(jqPath(path), jqPath(path))} title={`${jqPath(path)} — click to copy the path`}>
      {typeof label === 'number' ? label : JSON.stringify(label)}
    </button>
  );
  if (value && typeof value === 'object') {
    const isOpen = ctx.open.has(key);
    const entries = Array.isArray(value)
      ? value.map((x, i) => [i, x] as const)
      : Object.entries(value as Record<string, unknown>);
    const limit = ctx.limits.get(key) ?? PAGE;
    return (
      <li role="treeitem" aria-expanded={isOpen}>
        <span className="jsonv-row">
          <button type="button" className="jsonv-twisty" onClick={() => ctx.toggle(key)}
                  aria-label={isOpen ? 'collapse' : 'expand'}>{isOpen ? '▾' : '▸'}</button>
          {keyEl}{keyEl && <span className="jsonv-colon">:</span>}
          {isOpen
            ? <span className="jsonv-brace">{Array.isArray(value) ? `[ ${entries.length}` : `{ ${entries.length}`}</span>
            : <button type="button" className="jsonv-summary" onClick={() => ctx.toggle(key)}>{summarize(value)}</button>}
        </span>
        {isOpen && (
          <ul role="group">
            {entries.slice(0, limit).map(([k, child]) => (
              <JsonNode key={String(k)} label={k} value={child} path={[...path, k]} ctx={ctx} />
            ))}
            {entries.length > limit && (
              <li><button type="button" className="jsonv-more" onClick={() => ctx.more(key)}>
                show {Math.min(PAGE, entries.length - limit)} more of {entries.length - limit}
              </button></li>
            )}
          </ul>
        )}
      </li>
    );
  }
  const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return (
    <li role="treeitem">
      <span className="jsonv-row">
        <span className="jsonv-twisty-pad" />
        {keyEl}{keyEl && <span className="jsonv-colon">:</span>}
        <button type="button" className={`jsonv-val t-${value === null ? 'null' : typeof value}${hit ? ' hit' : ''}`}
                onClick={() => ctx.copy(typeof value === 'string' ? value : shown, 'the value')}
                title="click to copy the value">
          {shown.length > 2000 ? `${shown.slice(0, 2000)}…` : shown}
        </button>
      </span>
    </li>
  );
});
