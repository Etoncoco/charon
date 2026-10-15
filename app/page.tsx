import './claude.css';
import './density.css';
import { db, vps as vpsTable, vpsFolders as vpsFoldersTable, vpsPaths as vpsPathsTable, claudeSessions } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { asc, desc, eq } from 'drizzle-orm';
import ClaudePanel from './ClaudePanel';
import { listTabs } from '@/lib/server/claude/tabs';
import { getBuiltPyzSha, getBuiltAgentVersion } from '@/lib/server/agent/builtPyzSha';
import { latestVersionsByKey, refreshAllLatestsIfStale } from '@/lib/server/claude/sdkSync';
import { annotateSessionRows } from '@/lib/server/claude/sessionList';
import { sweepExpiredInteractions } from '@/lib/server/agent/sessionOps';

export const dynamic = 'force-dynamic';

export default async function CharonPage() {
  await requireSession();
  seedInitialData();

  // Folders sorted by position (persistent drag-and-drop).
  const folderRows = db.select().from(vpsFoldersTable)
    .orderBy(asc(vpsFoldersTable.position), asc(vpsFoldersTable.createdAt))
    .all();
  // VPSes sorted by position within their folder; the sidebar render groups
  // by folderId and the intra-folder order is preserved.
  const vpsRows = db.select().from(vpsTable).orderBy(asc(vpsTable.position)).all();
  const pathRows = db.select().from(vpsPathsTable).all();
  const sessionRowsRaw = db.select().from(claudeSessions)
    .where(eq(claudeSessions.archived, 0))
    .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
    .all();
  // The SAME annotation as the list GET (live status, gate split, bg count,
  // last activity): the header, tab bar and favicon are right from the first
  // paint instead of after the first list poll (R5 D-1). Expired gates are
  // swept first, as the list route does (the sweep publishes each removal).
  try { sweepExpiredInteractions(); } catch {}
  const sessionRows = annotateSessionRows(sessionRowsRaw);
  const builtPyzSha = getBuiltPyzSha();
  // Version-ordered staleness baseline (§14.6) — the sha is display-only now.
  const builtAgentVersion = getBuiltAgentVersion();
  // Every declared release line's latest (settings cache) → sidebar
  // out-of-date badges and health chips. Kick a background refresh when stale
  // (12h TTL, fire-and-forget). Derived from the registry, so a new backend's
  // package is served to the browser the day it is declared (§14.102).
  const staleness = latestVersionsByKey();
  refreshAllLatestsIfStale();
  const initialTabs = listTabs();

  return (
    <ClaudePanel
      vpsList={vpsRows}
      vpsFolders={folderRows}
      vpsPaths={pathRows}
      initialSessions={sessionRows}
      builtPyzSha={builtPyzSha}
      builtAgentVersion={builtAgentVersion}
      staleness={staleness}
      initialTabs={initialTabs}
    />
  );
}
