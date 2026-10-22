'use client';
import { useEffect, useRef, useState } from 'react';
import ImageViewer from './ImageViewer';
import { renderMermaid } from './mermaidRenderer';
import type { TextViewerProps } from './fileViews';

type Kind = 'svg' | 'mermaid' | 'graphviz';

/**
 * SVG, Mermaid and Graphviz files as pictures (§14.112): each source becomes
 * an SVG shown through an <img> — never inline — so a script, an event
 * handler or a `javascript:` URL in the file (or in a graph's URL attribute)
 * can never run. The image viewer brings zoom and pan. Rendering follows the
 * buffer (unsaved edits too), debounced; a source that stops rendering keeps
 * the last good picture beside the error.
 */
export default function DiagramViewer({ name, text, kind }: TextViewerProps & { kind: Kind }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void renderSvg(kind, text).then((svg) => {
        if (cancelled) return;
        const url = URL.createObjectURL(new Blob([withIntrinsicSize(svg)], { type: 'image/svg+xml' }));
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setSrc(url);
        setErr(null);
      }, (e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }).finally(() => { if (!cancelled) setBusy(false); });
    }, src ? 300 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  // `src` only decides the first render's debounce.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, text]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  if (!src) {
    return (
      <div className="imgv">
        {busy && !err && <div className="dvm-note">rendering…</div>}
        {err && <div className="dvm-note err">cannot render this {label(kind)}: {err}</div>}
      </div>
    );
  }
  return (
    <ImageViewer src={src} name={name} plate={kind !== 'mermaid'}
                 note={err ? `last good render — ${err}` : null} />
  );
}

function label(kind: Kind): string {
  return kind === 'svg' ? 'SVG' : kind === 'mermaid' ? 'Mermaid diagram' : 'Graphviz graph';
}

async function renderSvg(kind: Kind, text: string): Promise<string> {
  if (kind === 'svg') {
    if (!/<svg[\s>]/i.test(text)) throw new Error('no <svg> element');
    return text;
  }
  if (kind === 'graphviz') {
    const { instance } = await import('@viz-js/viz');
    const viz = await instance();
    const r = viz.render(text, { format: 'svg' });
    if (r.status !== 'success') throw new Error(r.errors.map((e) => e.message).join('; ') || 'invalid DOT');
    return r.output;
  }
  // Mermaid, themed by the tokens like the chat's diagrams — but measured in a
  // system font: an <img> cannot use the page's web fonts, and labels sized
  // for another font would overflow their boxes.
  const style = getComputedStyle(document.documentElement);
  const token = (n: string) => style.getPropertyValue(n).trim();
  return renderMermaid(text, {
    background: token('--bg-inset'),
    primaryColor: token('--bg-raised'),
    primaryTextColor: token('--text'),
    primaryBorderColor: token('--accent'),
    secondaryColor: token('--bg-elevated'),
    tertiaryColor: token('--bg-inset'),
    textColor: token('--text'),
    lineColor: token('--text-muted'),
    mainBkg: token('--bg-raised'),
    nodeBorder: token('--accent'),
    clusterBkg: token('--bg-elevated'),
    clusterBorder: token('--border'),
    edgeLabelBackground: token('--bg-inset'),
    fontFamily: 'sans-serif',
  });
}

/**
 * An <img> sizes an SVG from its width/height attributes; a `100%` or a
 * missing one (Mermaid, many hand-written files) leaves it 300×150. Pin them
 * to the viewBox so the viewer's 100% is the drawing's own size.
 */
function withIntrinsicSize(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return svg;
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const fixed = (v: string | null) => !!v && /^\d+(\.\d+)?(px)?$/.test(v.trim());
  if (box.length === 4 && box[2] > 0 && box[3] > 0) {
    if (!fixed(root.getAttribute('width'))) root.setAttribute('width', String(box[2]));
    if (!fixed(root.getAttribute('height'))) root.setAttribute('height', String(box[3]));
  }
  // Mermaid caps the root with `max-width`; the viewer does the sizing.
  const style = (root.getAttribute('style') ?? '').replace(/max-width\s*:[^;]*;?/i, '').trim();
  if (style) root.setAttribute('style', style); else root.removeAttribute('style');
  return new XMLSerializer().serializeToString(root);
}
