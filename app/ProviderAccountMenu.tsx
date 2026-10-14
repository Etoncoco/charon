'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Vps } from '@/lib/db/schema';
import { api } from '@/lib/api';
import type { ProviderAccountResponse, AgentKind } from '@/lib/types/api';
import { providerBackendState } from '@/lib/sessionCapabilities';
import { accountAuthLabel, PROVIDER_ACCOUNT_LINKS, providerName } from '@/lib/providerText';
import SessionContextMenu from './SessionContextMenu';

type Props = {
  profile?: import("@/lib/accountProfiles").AccountProfile;
  onAdd?: () => void; onRename?: () => void; onRemove?: () => Promise<void>;
  vps: Vps; provider: AgentKind; x: number; y: number; signingOut: boolean;
  onLogin: () => void; onLogout: () => void; onClose: () => void;
  onChecked: (loggedIn: boolean, checkedAt: number) => void;
};

export default function ProviderAccountMenu({
  vps, provider, x, y, signingOut, onLogin, onLogout, onClose, onChecked, profile, onAdd, onRename, onRemove,
}: Props) {
  const [account, setAccount] = useState<ProviderAccountResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const checked = useRef(onChecked);
  checked.current = onChecked;
  const available = vps.agentStatus === 'ok';
  const loggedIn = account?.loggedIn ?? (profile && profile.number > 1 ? profile.loggedIn : providerBackendState(vps, provider).loggedIn);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.getProviderAccount(vps.id, provider, profile?.id);
      if (id !== request.current) return;
      if (!r.ok) throw new Error(r.error ?? 'Account information unavailable');
      setAccount(r);
      if (typeof r.loggedIn === 'boolean' && r.checkedAt) checked.current(r.loggedIn, r.checkedAt);
    } catch (e: unknown) {
      if (id === request.current) setError(e instanceof Error ? e.message : 'Account information unavailable');
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [vps.id, provider, profile?.id]);
  useEffect(() => {
    if (available) void refresh();
    return () => { request.current += 1; };
  }, [refresh, available]);

  const reason = signingOut ? 'Logging out…' : !available ? 'Agent unavailable' : undefined;
  const details = loggedIn && account ? [
    ['Account', account.name], ['Email', account.email],
    ['Plan', account.subscriptionType?.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())], ['Organization', account.organization],
    ['Connection', account.authMethod && accountAuthLabel(account.authMethod)],
    ['Credential expires', account.expiresAtMs && new Date(account.expiresAtMs).toLocaleString()],
  ].filter((row) => row[1]) : [];

  return <SessionContextMenu
    title={`${providerName(provider)}${profile && profile.number > 1 ? ` ${profile.number}` : ""}`} subtitle={`${vps.name}${profile?.name ? ` · ${profile.name}` : ""}`} x={x} y={y}
    showRename={false} showColor={false} showDelete={false} onClose={onClose}
  >
    <div className="ctx-account" aria-live="polite" aria-busy={loading}>
      <div className="ctx-account-status">{loggedIn === true || loggedIn === 1 ? 'Connected'
        : loggedIn === false || loggedIn === 0 ? 'Not connected' : 'Connection unknown'}</div>
      {details.length > 0 && <dl>{details.map(([label, value]) => <div key={String(label)}>
        <dt>{label}</dt><dd>{value}</dd>
      </div>)}</dl>}
      {loading && <div className="ctx-account-note">Checking account…</div>}
      {error && <div className="ctx-account-error">{error}</div>}
      {!available && <div className="ctx-account-note">Agent unavailable</div>}
    </div>
    <button type="button" disabled={loading || !!reason} onClick={() => void refresh()}>Refresh account</button>
    {provider !== 'cursor' && onAdd && <button type="button" disabled={!!reason} onClick={() => { onAdd(); onClose(); }}>Add account…</button>}
    {onRename && <button type="button" onClick={() => { onRename(); onClose(); }}>Name account…</button>}
    {onRemove && <button type="button" disabled={loading || !!reason} onClick={async () => {
      setLoading(true); setError(null);
      try { await onRemove(); onClose(); } catch (e) { setError((e as Error).message); setLoading(false); }
    }}>Remove profile</button>}
    <a role="menuitem" href={PROVIDER_ACCOUNT_LINKS[provider]} target="_blank" rel="noopener noreferrer"
      onClick={onClose}>Open account & billing ↗</a>
    {loggedIn === false || loggedIn === 0
      ? <button type="button" disabled={loading || !!reason} onClick={() => { onLogin(); onClose(); }}>Login</button>
      : <button type="button" disabled={loading || !!reason || loggedIn == null} onClick={() => { onLogout(); onClose(); }}>
        Logout{reason && <span className="ctx-hint"> · {reason}</span>}
      </button>}
  </SessionContextMenu>;
}
