import './claude.css';
import './density.css';
import { db, vps as vpsTable, vpsFolders as vpsFoldersTable, vpsPaths as vpsPathsTable } from '@/lib/db';
import { requireSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { asc } from 'drizzle-orm';
import ClaudePanel from './ClaudePanel';
import { listTabs } from '@/lib/server/claude/tabs';
import { getBuiltPyzSha, getBuiltAgentVersion } from '@/lib/server/agent/builtPyzSha';
import { latestVersionsByKey, refreshAllLatestsIfStale } from '@/lib/server/claude/sdkSync';
import { reconcileAllSummaries } from '@/lib/server/sync/sessionSummaries';
import { currentRev, flushSummaries } from '@/lib/server/sync/syncBus';
import { buildId } from '@/lib/server/sync/buildId';

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
  // The session SUMMARIES (§14.108), the list GET's builder: live status,
  // gate counts and attention right from the first paint (the header and the
  // favicon no longer wait for the first list poll), stamped with the bus
  // revision read in the SAME synchronous section (I2) — the client's first
  // SSE connect resumes from it.
  flushSummaries();
  const sessionRows = reconcileAllSummaries();
  const initialSync = { ...currentRev(), buildId: buildId() };
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
      initialSummaries={sessionRows}
      initialSync={initialSync}
      builtPyzSha={builtPyzSha}
      builtAgentVersion={builtAgentVersion}
      staleness={staleness}
      initialTabs={initialTabs}
    />
  );
}
