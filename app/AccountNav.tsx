'use client';
// Header account buttons (CLAUDE.md §11): one per LOGIN across every VPS
// (lib/accountGroups.ts). Each reads [logo · label · 5h/7d rings] — a click
// opens the SAME usage popover the session header uses (`UsageRings`), Cursor
// keeps its dashboard link — plus a ▾ that opens that account's sessions with
// the global nav's own sections and rows (`NavSections`). The button carries
// the global trigger's attention class (`navAttentionClass` over THE
// predicate, lib/sessionAttention.ts), phase-locked to the wall clock, so the
// account that just finished pulses together with the global nav.
import type { AccountUsage } from '@/lib/server/claude/types';
import type { SessionProvider } from '@/lib/sessionCapabilities';
import type { AccountGroup } from '@/lib/accountGroups';
import { providerText } from '@/lib/providerText';
import AgentLogo from './AgentLogo';
import { UsageRings } from './UsageMeter';
import {
  NavSections, navAttentionClass, navSections, useHoverMenu, useNavRows, usePulsePhase,
} from './HeaderSessionNav';

/** THE account button's mark — the one place to change it. */
export function AccountLogo({ provider, size = 14 }: { provider: SessionProvider; size?: number }) {
  return <AgentLogo kind={provider} size={size} title="" />;
}

type ItemProps = {
  group: AccountGroup;
  usage: AccountUsage | null;
  onRefresh: () => void;
  vpsName: (vpsId: string) => string;
  selectedId: string | null;
  onOpen: (id: string) => void;
};

export function AccountNavItem({ group, usage, onRefresh, vpsName, selectedId, onOpen }: ItemProps) {
  const menu = useHoverMenu();
  const { open, setOpen } = menu;
  const rows = useNavRows(group.sessions, selectedId);
  const attention = navAttentionClass(rows);
  const phase = usePulsePhase(attention);
  const { running } = navSections(rows);

  // The strip scrolls sideways, so its popovers hang off the HEADER (they
  // would be clipped inside the strip): place them under this item.
  function place() {
    const el = menu.wrapRef.current;
    const head = el?.closest('.claude-head');
    if (!el || !head) return;
    const x = el.getBoundingClientRect().left - head.getBoundingClientRect().left;
    el.style.setProperty('--acct-pop-x', `${Math.round(x)}px`);
  }

  return (
    <div
      ref={menu.wrapRef}
      className={`acct-nav-item${open ? ' is-open' : ''}${attention ? ` ${attention}` : ''}`}
      style={phase}
      data-account={group.key}
      title={group.title}
      onMouseEnter={place}
      onPointerDown={place}
      onFocus={place}
      onMouseLeave={menu.onPointerLeave}
    >
      <UsageRings
        usage={usage}
        kind={group.provider}
        accountLabel={group.accountLabel}
        vpsName={group.vpsNames.join(', ')}
        onRefresh={onRefresh}
        className="acct-nav-usage"
        lead={<><AccountLogo provider={group.provider} /><span className="acct-nav-label">{group.label}</span></>}
      />
      <button
        type="button"
        className="acct-nav-caret"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={providerText.accountSessions(group.provider, group.label)}
        title={providerText.accountSessions(group.provider, group.label)}
        onMouseEnter={menu.onPointerEnter}
        onClick={() => { menu.onTriggerClick(); }}
      >
        <span className={`hnav-dot ${!running.length ? 'idle'
          : running.every((r) => r.state === 'background') ? 'background' : 'working'}`} aria-hidden />
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="hnav-panel acct-nav-panel" role="menu" onMouseEnter={menu.cancelClose}>
          <div className="acct-nav-panel-head">
            <AccountLogo provider={group.provider} />
            <span>{group.title}</span>
          </div>
          <NavSections rows={rows} selectedId={selectedId} vpsName={vpsName}
            onPick={(id) => { onOpen(id); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

type Props = {
  groups: readonly AccountGroup[];
  usageFor: (g: AccountGroup) => AccountUsage | null;
  onRefreshUsage: (g: AccountGroup) => void;
  vpsName: (vpsId: string) => string;
  selectedId: string | null;
  onOpen: (id: string) => void;
};

export default function AccountNav({ groups, usageFor, onRefreshUsage, vpsName, selectedId, onOpen }: Props) {
  if (!groups.length) return null;
  return (
    <div className="acct-nav" role="group" aria-label={providerText.accountNavLabel}>
      {groups.map((g) => (
        <AccountNavItem key={g.key} group={g} usage={usageFor(g)} onRefresh={() => onRefreshUsage(g)}
          vpsName={vpsName} selectedId={selectedId} onOpen={onOpen} />
      ))}
    </div>
  );
}
