'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { AgentKind, SessionListItem } from '@/lib/types/api';
import AgentLogo from './AgentLogo';
import { accountProfileNumber } from '@/lib/accountProfiles';
import { isWorkingStatus } from './sessionUnread';
import { attentionForRow, isWaitingAttention, rowStatus } from '@/lib/sessionAttention';
import TabNotificationBadge from './TabNotificationBadge';

/**
 * Header shortcut to the sessions you are actually using: a trigger carrying
 * how many are working and how many finished unread, opening a panel with what
 * is running, the last few that finished (and how long ago), and every session
 * under a search box.
 *
 * It reads the SAME projection of the session list the sidebar already holds —
 * no new request, no second source of truth. The only field added for it is
 * `lastActivityMs` (sessions route): "finished 4 minutes ago" cannot be ordered
 * from `unreadStop` (a flag) or `createdAt` (the launch).
 */

/** How many finished sessions the dedicated section shows. The rest are one
 *  scroll away in the full list, which is the point of having both. */
const FINISHED_SHOWN = 5;

/** The pointer leaving the trigger AND the panel closes it — after a grace long
 *  enough to walk the gap between the two. The CSS bridge (`.hnav-panel::before`)
 *  covers that gap geometrically; this covers the pointer that cuts a corner. */
const HOVER_CLOSE_MS = 160;

/** One reading per row, computed once: the CSS class, the word in the tooltip
 *  and whether the unread pulse applies all come from it. */
type NavState = 'needs-you' | 'working' | 'background' | 'error' | 'idle' | 'ready';

export type NavRow = {
  s: SessionListItem;
  state: NavState;
  working: boolean;
  waiting: boolean;
  /** The wait is an async question (answerable any time), not a parked turn. */
  question: boolean;
  unread: boolean;
  /** When this session last did anything; the launch for one that never spoke. */
  when: number;
};

function stateOf(s: SessionListItem, working: boolean, waiting: boolean): NavState {
  if (waiting) return 'needs-you';
  // `liveStatus ?? status`: an SSR row or an older hub's row may lack the live
  // field, and reading it alone painted every such row 'ready' (R5 D-1).
  const live = rowStatus(s);
  // Still counted as working (its tasks are), but in the sidebar's violet: the
  // turn is over, only what it launched runs on (§14.91).
  if (live === 'background') return 'background';
  if (working) return 'working';
  if (live === 'error' || live === 'failed') return 'error';
  if (live === 'sleeping') return 'idle';
  return 'ready';
}

export function rowOf(s: SessionListItem, viewedId: string | null): NavRow {
  // THE attention predicate (lib/sessionAttention.ts), shared with the sidebar,
  // the tab bar, the filter chip and the desk: one session, one reading.
  // `viewedHere` = selected AND visible: a finish on the session this tab
  // shows while hidden is still news for the badge (§14.47).
  const attention = attentionForRow(s, { viewedHere: s.id === viewedId });
  // The rows ARE the summary store (§14.108): gates and attention arrive in
  // the same frame, no side feed to union.
  const waiting = isWaitingAttention(attention);
  // A turn parked on a blocking gate is still a running turn; a paused session
  // holding an async question is not "working".
  const working = isWorkingStatus(rowStatus(s)) || attention === 'blocked';
  return {
    s,
    state: stateOf(s, working, waiting),
    working,
    waiting,
    question: attention === 'question',
    unread: !waiting && attention === 'unread',
    when: s.lastActivityMs ?? (s.createdAt ? s.createdAt * 1000 : 0),
  };
}

/** The panel's top sections. Every session the badge counts as waiting has a
 *  row there: a waiting one that is NOT working (an async question on an idle
 *  or paused session, a gate the live feed knows before the list) gets its own
 *  "Waiting on you" section, above Working (which keeps its spec'd count). */
export function navSections(rows: NavRow[]): { waitingOnly: NavRow[]; running: NavRow[]; finished: NavRow[] } {
  return {
    waitingOnly: rows.filter((r) => r.waiting && !r.working),
    running: rows.filter((r) => r.working),
    // "Recently finished" is the short list you act on, so it holds sessions
    // you can still walk into: a PAUSED one finished too, but reading it means
    // waking it first, and there are enough of them to push every live session
    // out of a five-row window. They stay one scroll away, under "All
    // sessions". A failed one is still connected and idle (§14.68) — it just
    // finished badly, which is the last thing a list of what finished should
    // hide.
    finished: rows.filter((r) => r.state === 'ready' || r.state === 'error').slice(0, FINISHED_SHOWN),
  };
}

function label(s: SessionListItem): string {
  return s.name || s.firstUserMessage?.slice(0, 40) || '(unnamed)';
}

function ago(ms: number): string {
  if (!ms) return '';
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function stateWord(r: NavRow): string {
  switch (r.state) {
    case 'needs-you': return r.question ? 'question' : 'needs you';
    case 'working': return 'working';
    case 'background': return 'background';
    case 'error': return 'error';
    case 'idle': return 'paused';
    default: return r.unread ? 'finished, unread' : 'ready';
  }
}

/** `document.visibilityState === 'visible'`, kept live (SSR: visible). */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    on();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/**
 * What a click on the trigger does. A hover already opened the panel on a
 * desktop, and reaching for the trigger then clicking it is the natural
 * gesture: that click PINS the panel (and focuses its search) instead of
 * toggling it shut. Only a click on a panel the user opened by clicking
 * closes it.
 */
export function triggerClickOutcome(open: boolean, openedBy: 'hover' | 'click'): 'open' | 'close' | 'pin' {
  if (!open) return 'open';
  return openedBy === 'hover' ? 'pin' : 'close';
}

/** The trigger's attention class over a set of rows: orange outranks green
 *  (one is a question blocking a session, the other a page waiting to be
 *  read — the card's precedence). Shared by the global trigger and every
 *  account button (app/AccountNav.tsx), so they light up from ONE reading. */
export type NavAttentionClass = '' | 'has-waiting' | 'has-unread';
export function navAttentionClass(rows: readonly NavRow[]): NavAttentionClass {
  if (rows.some((r) => r.waiting)) return 'has-waiting';
  if (rows.some((r) => r.unread)) return 'has-unread';
  return '';
}


/** Phase-lock the attention pulse on the DOCUMENT TIMELINE: every surface
 *  carrying it beats together, whenever it lit up (the global nav and the
 *  account buttons light up from different renders). The CSS animation is
 *  re-anchored at timeline 0 — a wall-clock `animation-delay` set from an
 *  effect stayed off by each element's own commit→effect latency. */
export function lockPulsePhase(el: Element | null | undefined): void {
  if (!el || typeof el.getAnimations !== 'function') return;
  for (const a of el.getAnimations()) {
    const name = (a as Animation & { animationName?: string }).animationName;
    if (name && name.startsWith('row-pulse') && a.startTime !== 0) a.startTime = 0;
  }
}

/** `lockPulsePhase` on `ref` whenever the attention class changes (a new
 *  class is a new CSS animation). Before paint: no first frame off-beat. */
export function usePulsePhase(ref: RefObject<Element | null>, cls: NavAttentionClass): void {
  useLayoutEffect(() => { if (cls) lockPulsePhase(ref.current); }, [ref, cls]);
}

/** A coarse pointer synthesizes `mouseenter` on TAP, so hover-to-open would
 *  open the panel and let the tap's own click close it again. Hovering is a
 *  fine-pointer gesture; touch keeps the click toggle. */
function hoverOpens() {
  return !window.matchMedia?.('(pointer: coarse)').matches;
}

/** The hover/click menu machinery: hover opens on fine pointers (closing after
 *  a grace), a click pins or toggles (`triggerClickOutcome`), Escape and a
 *  press outside `wrapRef` dismiss. */
export function useHoverMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // How the panel opened decides whether the keyboard follows it: a hover is
  // not a request for focus.
  const opened = useRef<'hover' | 'click'>('click');

  function cancelClose() {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }
  function onPointerEnter() {
    if (!hoverOpens()) return;
    cancelClose();
    if (!open) { opened.current = 'hover'; setOpen(true); }
  }
  function onPointerLeave() {
    if (!hoverOpens()) return;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  }
  /** Returns 'pin' when the click pinned a hover-opened panel. */
  function onTriggerClick(): 'open' | 'close' | 'pin' {
    cancelClose();
    const next = triggerClickOutcome(open, opened.current);
    opened.current = 'click';
    if (next !== 'pin') setOpen(next === 'open');
    return next;
  }
  useEffect(() => cancelClose, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return { open, setOpen, wrapRef, opened, cancelClose, onPointerEnter, onPointerLeave, onTriggerClick, hoverOpens };
}

/** Rows as a nav panel lists them: newest activity first; unread hidden on
 *  the session this tab visibly shows. */
export function useNavRows(sessions: readonly SessionListItem[], selectedId: string | null): NavRow[] {
  const visible = useDocumentVisible();
  const viewedId = visible ? selectedId : null;
  return useMemo(
    () => sessions.map((session) => rowOf(session, viewedId)).sort((a, b) => b.when - a.when),
    [sessions, viewedId],
  );
}

/** The panel's sections when no search runs — the global nav and every
 *  account panel render the SAME ones. */
export function NavSections({ rows, ...rowProps }: RowProps & { rows: NavRow[] }) {
  const { waitingOnly, running, finished } = navSections(rows);
  return (
    <>
      <Section title={`Waiting on you (${waitingOnly.length})`} rows={waitingOnly}
        empty="" {...rowProps} />
      <Section title={`Working (${running.length})`} rows={running}
        empty="nothing running" {...rowProps} />
      <Section title="Recently finished" rows={finished}
        empty="no finished session yet" {...rowProps} />
      <Section title={`All sessions (${rows.length})`} rows={rows}
        empty="" scroll {...rowProps} />
    </>
  );
}

type Props = {
  sessions: SessionListItem[];
  vpsName: (vpsId: string) => string;
  selectedId: string | null;
  onOpen: (id: string) => void;
};

export default function HeaderSessionNav({ sessions, vpsName, selectedId, onOpen }: Props) {
  const menu = useHoverMenu();
  const { open, setOpen, opened } = menu;
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  // Opening ON PURPOSE lands on the search box; closing forgets the query, so
  // the panel always reopens on the live picture rather than on an old filter.
  // A hover opens nothing the keyboard asked for — the pointer can cross the
  // trigger while you are typing in the chat box, and pulling focus out of it
  // would eat the next keystrokes. A coarse pointer never auto-focuses: the
  // virtual keyboard would cover the very list the tap opened (vpsSearch.ts).
  useEffect(() => {
    if (!open) { setQuery(''); return; }
    if (opened.current === 'click' && menu.hoverOpens()) search.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rows = useNavRows(sessions, selectedId);
  const { running } = navSections(rows);
  const unreadCount = rows.filter((r) => r.unread).length;
  // The other durable "go and look" count, and the louder one: a session is
  // BLOCKED on you until you answer. Same apparatus as the unread green —
  // a count on the trigger, a pulse, a row you click to land on the card.
  const waitingCount = rows.filter((r) => r.waiting).length;
  const attention = navAttentionClass(rows);
  const trigger = useRef<HTMLButtonElement>(null);
  usePulsePhase(trigger, attention);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return rows;
    const terms = q.split(/\s+/);
    return rows.filter((r) => {
      const hay = [
        label(r.s), r.s.handle ?? '', r.s.cwd, vpsName(r.s.vpsId), String(r.s.kind),
      ].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [rows, q, vpsName]);

  function pick(id: string) { onOpen(id); setOpen(false); }
  const rowProps = { onPick: pick, selectedId, vpsName };

  return (
    // The panel is a CHILD of the wrapper, so walking from the trigger into the
    // list never leaves this element: one enter/leave pair drives both.
    <div className={`hnav${open ? ' is-open' : ''}`} ref={menu.wrapRef}
      onMouseEnter={menu.onPointerEnter} onMouseLeave={menu.onPointerLeave}>
      <TabNotificationBadge count={unreadCount + waitingCount} />
      <button
        type="button"
        ref={trigger}
        className={`hnav-trigger${open ? ' is-open' : ''}${attention ? ` ${attention}` : ''}`}
        onClick={() => {
          if (menu.onTriggerClick() === 'pin') search.current?.focus({ preventScroll: true });
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        title={[
          `${running.length} working`,
          ...(waitingCount ? [`${waitingCount} waiting on you`] : []),
          `${unreadCount} finished, unread`,
          `${rows.length} sessions`,
        ].join(' · ')}
      >
        {/* Violet only when background work is ALL that runs; a live turn or a
            waiting gate is the louder fact. */}
        <span className={`hnav-dot ${!running.length ? 'idle'
          : running.every((r) => r.state === 'background') ? 'background' : 'working'}`} aria-hidden />
        <span className="hnav-trigger-count">{running.length}</span>
        <span className="hnav-trigger-word">working</span>
        {/* Blocked sessions are counted on the left too (a turn parked on
            you still runs); an async question on a paused session is not
            working, so this is not always a subset (lib/sessionAttention.ts). */}
        {!!waitingCount && (
          <span className="hnav-trigger-waiting" title={`${waitingCount} waiting for your answer`}>
            <span className="hnav-dot waiting" aria-hidden />{waitingCount}
          </span>
        )}
        {!!unreadCount && (
          <span className="hnav-trigger-unread" title={`${unreadCount} finished and not opened yet`}>
            <span className="hnav-dot unread" aria-hidden />{unreadCount}
          </span>
        )}
        <span className="hnav-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="hnav-panel" role="menu">
          <div className="hnav-search">
            <input
              ref={search}
              className="hnav-search-input"
              value={query}
              placeholder="search sessions — name, path, machine…"
              onChange={(e) => setQuery(e.target.value)}
            />
            {!!query && (
              <button type="button" className="hnav-search-clear" onClick={() => setQuery('')}
                aria-label="clear search">×</button>
            )}
          </div>
          {q ? (
            <Section title={`Matches (${matches.length})`} rows={matches}
              empty="nothing matches" scroll {...rowProps} />
          ) : (
            <NavSections rows={rows} {...rowProps} />
          )}
        </div>
      )}
    </div>
  );
}

type RowProps = {
  onPick: (id: string) => void;
  selectedId: string | null;
  vpsName: (id: string) => string;
};

function Section({ title, rows, empty, scroll, ...rowProps }: RowProps & {
  title: string; rows: NavRow[]; empty: string; scroll?: boolean;
}) {
  if (!rows.length && !empty) return null;
  return (
    <div className={`hnav-section${scroll ? ' is-scroll' : ''}`}>
      <div className="hnav-section-title">{title}</div>
      {rows.length === 0 && <div className="hnav-empty">{empty}</div>}
      <div className="hnav-section-rows">
        {rows.map((r) => <Row key={r.s.id} r={r} {...rowProps} />)}
      </div>
    </div>
  );
}

function Row({ r, onPick, selectedId, vpsName }: RowProps & { r: NavRow }) {
  const machine = vpsName(r.s.vpsId);
  return (
    <button
      type="button"
      role="menuitem"
      data-nav-id={r.s.id}
      className={`hnav-row ${r.state}${r.unread ? ' unread' : ''}${r.s.id === selectedId ? ' is-open' : ''}`}
      onClick={() => onPick(r.s.id)}
      title={`${label(r.s)} — ${stateWord(r)} · ${machine} · ${r.s.cwd}`}
    >
      <span className="hnav-dot" aria-hidden />
      <AgentLogo kind={r.s.kind as AgentKind} profileNumber={accountProfileNumber(r.s)} size={13} />
      <span className="hnav-row-name">{label(r.s)}</span>
      {/* Machine and path are TWO facts, joined the way the session subtitle
          joins them (`CwdSubtitle`). Glued with a colon, a machine whose name
          ends in a word — "chalco - new" — read as a prefix of the path. */}
      <span className="hnav-row-where">
        <span className="hnav-row-vps">{machine}</span>
        <span className="hnav-row-cwd">{r.s.cwd}</span>
      </span>
      <span className="hnav-row-when">{ago(r.when)}</span>
    </button>
  );
}
