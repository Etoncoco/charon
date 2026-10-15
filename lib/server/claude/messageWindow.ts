import 'server-only';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db, claudeSessionMessages } from '@/lib/db';
import type { ClaudeSessionMessage } from '@/lib/db/schema';
import {
  CONVERSATION_EVENT_TYPES, RENDER_NULL_ROLES, TECHNICAL_ROLES, type TranscriptView,
} from '@/lib/transcriptRows';

// Side-channel roles ride with the chronological chat page that owns them,
// but never consume one of the requested chat slots.
export const NON_PAGINATED_ROLES: string[] = ['edit_snapshot', 'event'];

// Conversation view ("tools hidden", CLAUDE.md §14.25): a slot is a row the
// clean transcript renders. Generated from lib/transcriptRows.ts — classify a
// new role THERE, never here.
export const CONVERSATION_NON_SLOT_ROLES: string[] = [
  ...NON_PAGINATED_ROLES, ...TECHNICAL_ROLES, ...RENDER_NULL_ROLES,
];

/** Rows that take one of the `limit` slots of a page in `view`. */
function slotRows(view: TranscriptView): SQL {
  return notInArray(claudeSessionMessages.role, view === 'full' ? NON_PAGINATED_ROLES : CONVERSATION_NON_SLOT_ROLES);
}

/** Rows a page of `view` carries: its slots plus the side channels riding
 *  with them — every non-snapshot row in `full`; in `conversation` only the
 *  CONVERSATION_EVENT_TYPES events (no tool, thinking or plan rows). The
 *  `role = 'event'` test runs first, so only event rows are parsed. */
function pageRows(view: TranscriptView): SQL {
  if (view === 'full') return notInArray(claudeSessionMessages.role, ['edit_snapshot']);
  const eventType = sql`(CASE WHEN json_valid(${claudeSessionMessages.content}) THEN json_extract(${claudeSessionMessages.content}, '$.type') END)`;
  return or(
    slotRows(view),
    and(eq(claudeSessionMessages.role, 'event'), inArray(eventType, [...CONVERSATION_EVENT_TYPES])),
  )!;
}

// One canonical, indexed chronology. ts_ms is populated by every current
// writer and migration 0026 backfilled old rows; created_at + id is the safe
// legacy fallback/tie-breaker.
const orderTs = sql<number>`coalesce(${claudeSessionMessages.tsMs}, ${claudeSessionMessages.createdAt} * 1000)`;

// Never select the lossless heavyweight payload for the looping chat route.
// wire_content contains edit metadata / bounded tool previews where needed.
export const publicMessageColumns = {
  id: claudeSessionMessages.id,
  sessionId: claudeSessionMessages.sessionId,
  role: claudeSessionMessages.role,
  content: sql<string>`coalesce(${claudeSessionMessages.wireContent}, ${claudeSessionMessages.content})`,
  model: claudeSessionMessages.model,
  assistantFinal: claudeSessionMessages.assistantFinal,
  seq: claudeSessionMessages.seq,
  tsMs: claudeSessionMessages.tsMs,
  // The CLI transcript entry this row came from — the anchor "fork from here"
  // branches at. Cheap (a uuid string) and only ever set on assistant rows.
  cliUuid: claudeSessionMessages.cliUuid,
  createdAt: claudeSessionMessages.createdAt,
};

type Key = { id: number; ts: number };

function latestSnapshotMetadata(sessionId: string): ClaudeSessionMessage[] {
  const ids = db.select({ id: sql<number>`max(${claudeSessionMessages.id})` })
    .from(claudeSessionMessages)
    .where(and(
      eq(claudeSessionMessages.sessionId, sessionId),
      eq(claudeSessionMessages.role, 'edit_snapshot'),
      isNotNull(claudeSessionMessages.snapshotFilePath),
    ))
    .groupBy(claudeSessionMessages.snapshotFilePath, claudeSessionMessages.snapshotPhase)
    .all().map((r) => r.id);
  const out: ClaudeSessionMessage[] = [];
  // Stay below SQLite's common 999-variable ceiling for pathological repos.
  for (let i = 0; i < ids.length; i += 900) {
    out.push(...db.select(publicMessageColumns).from(claudeSessionMessages)
      .where(inArray(claudeSessionMessages.id, ids.slice(i, i + 900)))
      .all());
  }
  return out;
}

function sortMessages(rows: ClaudeSessionMessage[]): ClaudeSessionMessage[] {
  return rows.sort((a, b) =>
    ((a.tsMs ?? a.createdAt * 1000) - (b.tsMs ?? b.createdAt * 1000)) || (a.id - b.id));
}

// The keyset bounds carry a REDUNDANT sargable `orderTs <= / >= key.ts` (same
// rows): SQLite cannot turn the OR alone into a range on the chrono expression
// index (idx_…_session_chrono_id), so a `?before=` page walked down from the
// session's NEWEST row to the cursor (cost grew with page depth) and the
// window query scanned the whole session — or, under production statistics,
// split into MULTI-INDEX OR + TEMP B-TREE. Same rule as peerReplyContext.ts.
function beforeKey(key: Key): SQL {
  return and(
    lte(orderTs, key.ts),
    or(lt(orderTs, key.ts), and(eq(orderTs, key.ts), lt(claudeSessionMessages.id, key.id))),
  )!;
}

function atOrAfterKey(key: Key): SQL {
  return and(
    gte(orderTs, key.ts),
    or(gt(orderTs, key.ts), and(eq(orderTs, key.ts), gte(claudeSessionMessages.id, key.id))),
  )!;
}

/**
 * Load a keyset-paginated chronological window.
 *
 * The old implementation selected every row in a session, allocated maps and
 * sorted it in JS for every five-second catch-up GET. Large transcripts spent
 * hundreds of milliseconds blocking Node even though the UI only wanted 200
 * rows. `(session_id, ts_ms, id)` now lets SQLite seek the exact page.
 *
 * Page ownership is half-open: a chat row owns side-channel rows after it up
 * to the next chat row. Thus older + newer pages concatenate without gaps or
 * duplicates, including attachments exactly on a page boundary.
 *
 * `view` (§14.25): `full` = every row (tool/thinking rows are chat slots);
 * `conversation` = only conversation rows are slots (`slotRows`) and only
 * conversation events ride along (`pageRows`) — a heavy session's window
 * spans far more dialogue and ships no technical row. Same partition and
 * cursor semantics in both: `oldestChatId` of a conversation page is a chat
 * row of the full view too, so a cursor stays valid across a view switch.
 */
export function loadMessageWindow(
  sessionId: string,
  limit: number,
  before: number | null,
  view: TranscriptView = 'full',
): { messages: ClaudeSessionMessage[]; hasMore: boolean; oldestChatId: number | null } {
  let cursor: Key | null = null;
  if (before != null) {
    const row = db.select({ id: claudeSessionMessages.id, ts: orderTs })
      .from(claudeSessionMessages)
      .where(and(
        eq(claudeSessionMessages.sessionId, sessionId),
        eq(claudeSessionMessages.id, before),
      ))
      .get();
    if (row) cursor = row;
  }

  const chatWhere: SQL[] = [
    eq(claudeSessionMessages.sessionId, sessionId),
    slotRows(view),
  ];
  if (cursor) chatWhere.push(beforeKey(cursor));
  else if (before != null) chatWhere.push(lt(claudeSessionMessages.id, before));

  const chatDesc = db.select({ id: claudeSessionMessages.id, ts: orderTs })
    .from(claudeSessionMessages)
    .where(and(...chatWhere))
    .orderBy(desc(orderTs), desc(claudeSessionMessages.id))
    .limit(limit + 1)
    .all();

  if (chatDesc.length === 0) {
    // Preserve the side-channel-only behavior: return a bounded newest tail
    // (of the rows this view carries: never a technical row in conversation).
    if (before != null) return { messages: [], hasMore: false, oldestChatId: null };
    const tail = db.select(publicMessageColumns).from(claudeSessionMessages)
      .where(and(
        eq(claudeSessionMessages.sessionId, sessionId),
        pageRows(view),
      ))
      .orderBy(desc(orderTs), desc(claudeSessionMessages.id))
      .limit(limit + 1)
      .all();
    const hasMore = tail.length > limit;
    if (hasMore) tail.pop();
    tail.reverse();
    const snapshots = latestSnapshotMetadata(sessionId);
    return { messages: sortMessages([...tail, ...snapshots]), hasMore, oldestChatId: null };
  }

  const hasMore = chatDesc.length > limit;
  if (hasMore) chatDesc.pop();
  const first = chatDesc[chatDesc.length - 1];

  const windowWhere: SQL[] = [eq(claudeSessionMessages.sessionId, sessionId)];
  // If this is not the oldest page, the preceding page owns everything before
  // our first chat row. The oldest page extends to -infinity and gets leading
  // side-channel rows.
  if (hasMore) windowWhere.push(atOrAfterKey(first));
  // Cursor is the first chat row of the newer page. Excluding it includes the
  // boundary attachments owned by our final (older) chat row.
  if (cursor) windowWhere.push(beforeKey(cursor));
  else if (before != null) windowWhere.push(lt(claudeSessionMessages.id, before));

  const messages = db.select(publicMessageColumns).from(claudeSessionMessages)
    .where(and(
      ...windowWhere,
      pageRows(view),
    ))
    .orderBy(asc(orderTs), asc(claudeSessionMessages.id))
    .all();

  // The chat only needs the latest before/after skeleton for each changed
  // file; sending every historical snapshot in a page was hundreds of
  // duplicate JSON objects. Older pages omit them because the newest page
  // already seeds the global per-session diff registry. Both views: the
  // files panel reads it whatever the transcript shows.
  if (before == null) messages.push(...latestSnapshotMetadata(sessionId));

  return { messages: sortMessages(messages), hasMore, oldestChatId: first.id };
}
