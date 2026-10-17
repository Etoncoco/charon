'use client';

import { useEffect, useRef, useState } from 'react';
import { renderMermaid } from './mermaidRenderer';

// Mermaid's root says width="100%": a small diagram blows up to the bubble
// width, a wide one shrinks into illegible labels. Pin its measured width in
// the MARKUP: a DOM patch after insertion was lost when switching back to a
// cached session. The wrapper scrolls instead.
function atActualSize(svg: string): string {
  const template = document.createElement('template');
  template.innerHTML = svg;
  const root = template.content.querySelector('svg');
  const width = Number(root?.getAttribute('viewBox')?.trim().split(/[\s,]+/)[2]);
  if (!root || !(width > 0)) return svg;
  root.style.width = `${width}px`;
  return template.innerHTML;
}

export default function MermaidDiagram({ source }: { source: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? '');
  const [result, setResult] = useState<{ source: string; theme: string; svg?: string; failed?: boolean }>();

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(root.dataset.theme ?? '');
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;
    const style = getComputedStyle(container.current);
    const token = (name: string) => style.getPropertyValue(name).trim();
    void renderMermaid(source, {
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
      fontFamily: style.fontFamily,
    }).then(
      (svg) => { if (!cancelled) setResult({ source, theme, svg: atActualSize(svg) }); },
      () => { if (!cancelled) setResult({ source, theme, failed: true }); },
    );
    return () => { cancelled = true; };
  }, [source, theme]);

  const current = result?.source === source && result.theme === theme ? result : undefined;

  return (
    <div ref={container}>
      {current?.svg ? (
        <>
          {/* Mermaid sanitizes the SVG in strict mode; never bind callbacks. */}
          <div className="mermaid-output" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: current.svg }} />
          <details className="mermaid-source">
            <summary>View source</summary>
            <pre><code className="language-mermaid">{source}</code></pre>
          </details>
        </>
      ) : (
        <>
          <p className="mermaid-status" role="status">
            {current?.failed ? 'Unable to render this diagram. Source shown below.' : 'Rendering diagram…'}
          </p>
          <pre><code className="language-mermaid">{source}</code></pre>
        </>
      )}
    </div>
  );
}
