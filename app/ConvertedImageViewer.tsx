'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ByteViewerProps } from './fileViews';
import { fromBase64 } from './byteText';
import ImageViewer from './ImageViewer';

/**
 * An image browsers cannot decode — TIFF, HEIC — converted to PNG on the VPS
 * (Pillow, §14.112), then shown by the ordinary image viewer. A missing
 * Pillow / pillow-heif says which package to install.
 */
export default function ConvertedImageViewer({ vpsId, root, path, name, rev }: ByteViewerProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    void api.fsConvert(vpsId, { root, path, to: 'png' }).then((r) => {
      if (!alive) return;
      if (!r.ok || !r.data) { setErr(r.error ?? 'could not convert this image'); return; }
      const url = URL.createObjectURL(new Blob([fromBase64(r.data) as BlobPart], { type: 'image/png' }));
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setSrc(url);
      const parts = [`converted from ${name.split('.').pop()?.toUpperCase()}`];
      if (r.origWidth && (r.origWidth !== r.width)) parts.push(`original ${r.origWidth} × ${r.origHeight}`);
      if ((r.frames ?? 1) > 1) parts.push(`page 1 of ${r.frames}`);
      setNote(parts.join(' · '));
    }, (e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [vpsId, root, path, name, rev]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  if (err) return <div className="imgv"><div className="dvm-note err">{err}</div></div>;
  if (!src) return <div className="imgv"><div className="dvm-note">converting on the VPS…</div></div>;
  return <ImageViewer src={src} name={name} note={note} />;
}
