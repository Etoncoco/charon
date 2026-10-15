'use client';
import { useEffect, useState } from 'react';

// Shared desktop/mobile type defined in `./sessionTypes`. Re-exported here
// to preserve historical imports.
export type { PermissionRequest } from './sessionTypes';
import type { PermissionRequest } from './sessionTypes';
import ApprovalDeadline from './ApprovalDeadline';

type Props = {
  queue: PermissionRequest[];
  currentSessionId: string | null;
  onRespond: (sessionId: string, permId: string, allow: boolean, always: boolean) => void;
  onSwitchSession: (sessionId: string) => void;
};

export default function PermissionPopup({ queue: fullQueue, currentSessionId, onRespond, onSwitchSession }: Props) {
  // The session open in this tab already shows its request inline (PendingZone
  // card): a second copy here is noise (R5 D-15). `currentSessionId` is only
  // set while the main pane shows a session.
  const queue = currentSessionId ? fullQueue.filter((q) => q.sessionId !== currentSessionId) : fullQueue;
  if (queue.length === 0) return null;
  const top = queue[0];
  return (
    <div className="perm-popup">
      <div className="perm-card">
        <header>
          <span className="badge">{queue.length}</span>
          <span className="title">permission requested</span>
          <button className="switch" onClick={() => onSwitchSession(top.sessionId)} title="open this session">
            ↗ session {top.sessionId.slice(0, 6)}
          </button>
        </header>
        <div className="tool-name">{top.tool}</div>
        <ApprovalDeadline expiresAt={top.expiresAt} />
        <pre className="input-preview">{JSON.stringify(top.input, null, 2).slice(0, 600)}</pre>
        <div className="actions">
          <button className="allow" onClick={() => onRespond(top.sessionId, top.id, true, false)}>allow once</button>
          <button className="always" onClick={() => onRespond(top.sessionId, top.id, true, true)}>allow always (session)</button>
          <button className="deny" onClick={() => onRespond(top.sessionId, top.id, false, false)}>deny</button>
        </div>
        {queue.length > 1 && (
          <ul className="queue">
            {queue.filter((q) => q.id !== top.id).slice(0, 5).map((q) => (
              <li key={q.id}>
                <span className="t">{q.tool}</span>
                <button onClick={() => onSwitchSession(q.sessionId)}>session {q.sessionId.slice(0, 6)}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
