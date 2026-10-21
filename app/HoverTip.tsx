'use client';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A themed tooltip for icon-only controls, in place of the browser's `title`
 * (late, unstyled, one line). VS Code's rhythm: the first one waits, the next
 * ones — the pointer sliding along a toolbar — show at once; a press hides it.
 *
 * Portaled to <body>: the controls that need it live in columns that clip
 * their overflow. Positioned beside the control's rect, on the requested side,
 * clamped to the viewport.
 */

export type HoverTipContent = {
  title: string;
  /** One line of what the control is / holds. */
  detail?: string;
  /** Shown as a pill beside the title when > 0. */
  count?: number;
  /** Keyboard shortcut, rendered as keys. */
  keys?: string[];
  /** A muted last line: what clicking does right now. */
  hint?: string;
};

const OPEN_DELAY_MS = 450;
/** After one hides, the next opens instantly for this long. */
const WARM_MS = 400;
const GAP_PX = 8;
const EDGE_PX = 8;

type Shown = { rect: DOMRect; content: HoverTipContent; owner: string };

export function useHoverTip(side: 'left' | 'right' = 'left') {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warmUntil = useRef(0);
  const id = useId();

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  /** `key` names the control, for its `aria-describedby`. */
  const show = useCallback((el: HTMLElement, content: HoverTipContent, key: string) => {
    clear();
    const open = () => setShown({ rect: el.getBoundingClientRect(), content, owner: key });
    if (Date.now() < warmUntil.current) open();
    else timer.current = setTimeout(open, OPEN_DELAY_MS);
  }, []);
  const hide = useCallback(() => {
    clear();
    setShown((prev) => {
      if (prev) warmUntil.current = Date.now() + WARM_MS;
      return null;
    });
  }, []);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [shown, hide]);
  useEffect(() => clear, []);

  const node = shown && typeof document !== 'undefined'
    ? createPortal(<HoverTipCard id={id} side={side} rect={shown.rect} content={shown.content} />, document.body)
    : null;
  const describedBy = (key: string) => (shown?.owner === key ? id : undefined);
  return { show, hide, node, describedBy };
}

function HoverTipCard({ id, side, rect, content }: Omit<Shown, 'owner'> & { id: string; side: 'left' | 'right' }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(rect.top + rect.height / 2);
  // Centred on the control, then nudged back inside the viewport once its own
  // height is known (before paint: no visible jump).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const half = el.offsetHeight / 2;
    const centre = rect.top + rect.height / 2;
    setTop(Math.min(window.innerHeight - EDGE_PX - half, Math.max(EDGE_PX + half, centre)));
  }, [rect]);
  const arrow = rect.top + rect.height / 2 - top;
  const style: React.CSSProperties = side === 'left'
    ? { top, right: window.innerWidth - rect.left + GAP_PX }
    : { top, left: rect.right + GAP_PX };
  return (
    <div ref={ref} id={id} role="tooltip" className={`hover-tip ${side}`} style={style}>
      <span className="hover-tip-arrow" style={{ top: `calc(50% + ${arrow}px)` }} aria-hidden />
      <div className="hover-tip-head">
        <span className="hover-tip-title">{content.title}</span>
        {content.count != null && content.count > 0 && <span className="hover-tip-count">{content.count}</span>}
        {content.keys && content.keys.length > 0 && (
          <span className="hover-tip-keys">{content.keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>
        )}
      </div>
      {content.detail && <div className="hover-tip-detail">{content.detail}</div>}
      {content.hint && <div className="hover-tip-hint">{content.hint}</div>}
    </div>
  );
}
