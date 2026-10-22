'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { wheelFactor } from './fileViews';

const PAD = 16;
const MIN = 0.05;
const MAX = 32;
const STEP = 1.25;

type Anchor = { fx: number; fy: number; cx: number; cy: number };

function clamp(z: number): number {
  return Math.min(MAX, Math.max(MIN, z));
}

/**
 * An image you can look into (§14.111): fit by default, zoom with the
 * buttons, Ctrl/⌘+wheel, a trackpad or two-finger pinch, double-click for
 * fit ↔ 100%; drag or scroll to pan. The point under the cursor stays put
 * through a zoom. State lives in the component — the pane stays mounted
 * across tab switches, so coming back finds the same zoom and position.
 */
export default function ImageViewer({ src, name, plate = false, note }: {
  src: string;
  name: string;
  /** Draw on the white document plate (diagrams, transparent SVGs drawn in black). */
  plate?: boolean;
  /** Extra toolbar note (a conversion, a render error kept beside the last good image). */
  note?: string | null;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [failed, setFailed] = useState(false);
  const anchor = useRef<Anchor | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  useEffect(() => {
    if (!scroller) return;
    const measure = () => setBox({ w: scroller.clientWidth, h: scroller.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    measure();
    return () => ro.disconnect();
  }, [scroller]);

  const fit = nat && box.w > 0 && box.h > 0
    ? Math.min(1, (box.w - 2 * PAD) / nat.w, (box.h - 2 * PAD) / nat.h)
    : 1;
  const scale = zoom === 'fit' ? fit : zoom;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  /** Zoom to `next`, keeping the image point under (cx, cy) where it is. */
  const zoomAt = useCallback((next: number | 'fit', cx?: number, cy?: number) => {
    const img = imgRef.current;
    if (img && scroller) {
      const r = img.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      const x = cx ?? s.left + s.width / 2;
      const y = cy ?? s.top + s.height / 2;
      anchor.current = {
        fx: r.width ? (x - r.left) / r.width : 0.5,
        fy: r.height ? (y - r.top) / r.height : 0.5,
        cx: x, cy: y,
      };
    }
    setZoom(next === 'fit' ? 'fit' : clamp(next));
  }, [scroller]);

  useLayoutEffect(() => {
    const a = anchor.current;
    const img = imgRef.current;
    if (!a || !img || !scroller) return;
    anchor.current = null;
    const r = img.getBoundingClientRect();
    scroller.scrollLeft += r.left + a.fx * r.width - a.cx;
    scroller.scrollTop += r.top + a.fy * r.height - a.cy;
  }, [scale, scroller]);

  // Ctrl/⌘+wheel — what a trackpad pinch reports — zooms the image, not the
  // hub. Native listener: React's wheel handlers are passive.
  useEffect(() => {
    if (!scroller) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(scaleRef.current * wheelFactor(e), e.clientX, e.clientY);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [scroller, zoomAt]);

  const overflowing = !!nat && (nat.w * scale > box.w - 2 * PAD || nat.h * scale > box.h - 2 * PAD);

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        const [p, q] = [...touches.current.values()];
        pinch.current = { dist: Math.hypot(p.x - q.x, p.y - q.y), scale: scaleRef.current };
      }
      return;
    }
    if (e.button !== 0 || !overflowing || !scroller) return;
    drag.current = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      if (!touches.current.has(e.pointerId)) return;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pin = pinch.current;
      if (pin && touches.current.size === 2 && pin.dist > 0) {
        const [p, q] = [...touches.current.values()];
        const dist = Math.hypot(p.x - q.x, p.y - q.y);
        zoomAt(pin.scale * (dist / pin.dist), (p.x + q.x) / 2, (p.y + q.y) / 2);
      }
      return;
    }
    const d = drag.current;
    if (!d || !scroller) return;
    scroller.scrollLeft = d.left - (e.clientX - d.x);
    scroller.scrollTop = d.top - (e.clientY - d.y);
  };
  const onPointerEnd = (e: PointerEvent) => {
    touches.current.delete(e.pointerId);
    if (touches.current.size < 2) pinch.current = null;
    drag.current = null;
  };

  const zoomed = zoom !== 'fit';
  const canZoom = !!nat && !failed;
  return (
    <div className="imgv">
      <div className="viewer-bar">
        {(nat || note) && (
          <span className="viewer-bar-note">{[nat && `${nat.w} × ${nat.h}`, note].filter(Boolean).join(' · ')}</span>
        )}
        <span className="viewer-bar-spacer" />
        <button type="button" disabled={!canZoom} onClick={() => zoomAt(scale / STEP)} title="Zoom out (Ctrl+wheel)">−</button>
        <button type="button" disabled={!canZoom} className={zoomed ? '' : 'on'} onClick={() => zoomAt('fit')}
                title="Fit the image in the pane">{Math.round(scale * 100)}%</button>
        <button type="button" disabled={!canZoom} onClick={() => zoomAt(scale * STEP)} title="Zoom in (Ctrl+wheel)">+</button>
        <button type="button" disabled={!canZoom} className={zoom === 1 ? 'on' : ''} onClick={() => zoomAt(1)}
                title="Actual size">1:1</button>
      </div>
      <div
        className={`imgv-scroll${overflowing ? ' pannable' : ''}`}
        ref={setScroller}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={(e) => { if (canZoom) zoomAt(zoomed ? 'fit' : Math.max(1, fit * 2), e.clientX, e.clientY); }}
      >
        <div className="imgv-stage">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            className={plate ? 'plate' : undefined}
            src={src}
            alt={name}
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              setFailed(false);
              // An SVG without intrinsic size reports 0: it just fits.
              setNat(el.naturalWidth > 0 && el.naturalHeight > 0 ? { w: el.naturalWidth, h: el.naturalHeight } : null);
            }}
            onError={() => setFailed(true)}
            style={nat ? { width: nat.w * scale, height: nat.h * scale } : undefined}
          />
        </div>
      </div>
      {failed && <div className="dvm-note err">could not load this image</div>}
    </div>
  );
}
