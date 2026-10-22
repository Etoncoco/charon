'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cutToLineStart, filterLines, stripAnsi } from './byteText';
import { readRange } from './readRange';
import { fmtSize } from './sessionAttachments';

/** One read: the tail on open, then this much per "earlier" click. */
const CHUNK = 256 * 1024;
/** What the view holds at most — past it, earlier text needs the download. */
const MAX_HELD = 8 * 1024 * 1024;
const FOLLOW_MS = 2000;
/** Further behind than this while following ⇒ jump to the tail, do not replay. */
const CATCH_UP_MAX = 2 * 1024 * 1024;

type Props = {
  vpsId: string;
  root: string;
  path: string;
  /** Start following (a `.log`); a big file of another kind starts still. */
  follow?: boolean;
  active: boolean;
};

/**
 * The END of a file, live (§14.112): opens on the last lines, reads earlier
 * chunks on demand, follows what is appended (like `tail -f`), survives a
 * truncation or a rotation, and filters lines. No size limit — only what is
 * on screen is read. Terminal escape sequences are stripped.
 */
export default function LogViewer({ vpsId, root, path, follow: followInit = false, active }: Props) {
  const [text, setText] = useState('');
  // Byte window held: [start, end) of a file of `size` bytes.
  const [start, setStart] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const endRef = useRef(0);
  const decoder = useRef(new TextDecoder('utf-8'));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [follow, setFollow] = useState(followInit);
  const [wrap, setWrap] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stickToEnd = useRef(true);

  const loadTail = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await readRange(vpsId, root, path, -CHUNK, CHUNK);
      const { bytes, dropped } = r.offset > 0 ? cutToLineStart(r.bytes) : { bytes: r.bytes, dropped: 0 };
      decoder.current = new TextDecoder('utf-8');
      setText(stripAnsi(decoder.current.decode(bytes, { stream: true })));
      setStart(r.offset + dropped);
      endRef.current = r.offset + r.bytes.length;
      setSize(r.size);
      stickToEnd.current = true;
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [vpsId, root, path]);

  useEffect(() => { void loadTail(); }, [loadTail]);

  const loadEarlier = useCallback(async () => {
    if (start <= 0 || busy) return;
    setBusy(true);
    try {
      const from = Math.max(0, start - CHUNK);
      const r = await readRange(vpsId, root, path, from, start - from);
      const { bytes, dropped } = from > 0 ? cutToLineStart(r.bytes) : { bytes: r.bytes, dropped: 0 };
      const el = scroller.current;
      const before = el ? el.scrollHeight - el.scrollTop : 0;
      setText((t) => stripAnsi(new TextDecoder('utf-8').decode(bytes)) + t);
      setStart(from + dropped);
      // Keep the line the reader was on where it was.
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - before; });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [vpsId, root, path, start, busy]);

  // Following: append what was written since the last read, only while the
  // pane is on screen (§14.111).
  useEffect(() => {
    if (!follow || !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await readRange(vpsId, root, path, endRef.current, CHUNK);
        if (stopped) return;
        setSize(r.size);
        if (r.size < endRef.current || r.size - endRef.current > CATCH_UP_MAX) {
          // Truncated, rotated, or far behind: start over from the tail.
          await loadTail();
        } else if (r.bytes.length) {
          endRef.current = r.offset + r.bytes.length;
          const added = stripAnsi(decoder.current.decode(r.bytes, { stream: true }));
          setText((t) => {
            const next = t + added;
            // Hold at most MAX_HELD characters: drop whole lines off the top.
            if (next.length <= MAX_HELD) return next;
            const cut = next.indexOf('\n', next.length - MAX_HELD);
            return cut < 0 ? next.slice(-MAX_HELD) : next.slice(cut + 1);
          });
          if (r.size > endRef.current) { timer = setTimeout(tick, 50); return; }
        }
      } catch {
        // A blip: the next tick tries again; the VPS badge owns connectivity.
      }
      if (!stopped) timer = setTimeout(tick, FOLLOW_MS);
    };
    timer = setTimeout(tick, FOLLOW_MS);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [follow, active, vpsId, root, path, loadTail]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(t);
  }, [query]);
  const shown = useMemo(() => filterLines(text, debounced), [text, debounced]);

  // New lines keep the view at the bottom only if it already was.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToEnd.current) el.scrollTop = el.scrollHeight;
  }, [shown.text]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stickToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const heldBytes = Math.max(0, endRef.current - start);
  return (
    <div className="logv">
      <div className="viewer-bar">
        <span className="viewer-bar-note">
          {size == null ? 'loading…'
            : start > 0 ? `${fmtSize(size)} · last ${fmtSize(heldBytes)} shown`
            : fmtSize(size)}
          {shown.count >= 0 && ` · ${shown.count} matching line${shown.count === 1 ? '' : 's'}`}
        </span>
        <input
          className="logv-filter"
          type="search"
          placeholder="filter lines"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter lines"
        />
        <span className="viewer-bar-spacer" />
        <button type="button" onClick={() => void loadEarlier()}
                disabled={start <= 0 || busy || heldBytes >= MAX_HELD}
                title={heldBytes >= MAX_HELD ? 'Download the file for the rest' : 'Read the previous chunk'}>
          Earlier
        </button>
        <button type="button" className={wrap ? 'on' : ''} onClick={() => setWrap((w) => !w)}
                title="Wrap long lines">Wrap</button>
        <button type="button" className={follow ? 'on' : ''}
                onClick={() => { setFollow((f) => !f); stickToEnd.current = true; }}
                title="Follow new lines as they are written (tail -f)">Follow</button>
        <button type="button" onClick={() => void loadTail()} disabled={busy} title="Reload the end of the file">
          End
        </button>
      </div>
      {err && <div className="dvm-note err">{err}</div>}
      <div className="logv-scroll" ref={scroller} onScroll={onScroll}>
        <pre className={`logv-text${wrap ? ' wrap' : ''}`}>{shown.text}</pre>
      </div>
    </div>
  );
}
