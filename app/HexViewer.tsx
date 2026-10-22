'use client';
import { useCallback, useEffect, useState } from 'react';
import { hexDump, sniffMagic } from './byteText';
import { readRange } from './readRange';
import { fmtSize } from './sessionAttachments';

const CHUNK = 64 * 1024;
const MAX_SHOWN = 4 * 1024 * 1024;

/**
 * A binary nothing else can show (§14.112): offset · hex · ASCII, 64 KB at a
 * time, with what its first bytes say it is. Read-only.
 */
export default function HexViewer({ vpsId, root, path, rev = 0 }: {
  vpsId: string; root: string; path: string; rev?: number;
}) {
  const [dump, setDump] = useState('');
  const [loaded, setLoaded] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [magic, setMagic] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (from: number) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await readRange(vpsId, root, path, from, CHUNK);
      if (from === 0) setMagic(sniffMagic(r.bytes));
      const part = hexDump(r.bytes, r.offset);
      setDump((d) => (from === 0 ? part : `${d}\n${part}`));
      setLoaded(r.offset + r.bytes.length);
      setSize(r.size);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [vpsId, root, path]);

  useEffect(() => { void load(0); }, [load, rev]);

  const more = size != null && loaded < size && loaded < MAX_SHOWN;
  return (
    <div className="hexv">
      <div className="viewer-bar">
        <span className="viewer-bar-note">
          {magic ?? 'binary data'}{size != null && ` · ${fmtSize(size)}`}
          {size != null && loaded < size && ` · first ${fmtSize(loaded)} shown`}
        </span>
        <span className="viewer-bar-spacer" />
        <button type="button" disabled={!more || busy} onClick={() => void load(loaded)}
                title={loaded >= MAX_SHOWN ? 'Download the file for the rest' : 'Show the next 64 KB'}>
          More
        </button>
      </div>
      {err && <div className="dvm-note err">{err}</div>}
      <div className="hexv-scroll">
        <pre className="hexv-text">{dump}</pre>
      </div>
    </div>
  );
}
