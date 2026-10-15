// Where an assistant text bubble ends (CLAUDE.md §7, sync refonte I7).
//
// The HUB cuts assistant bubbles: before persisting/publishing any of these
// events it flushes the open `assistant_text` buffer into its row and
// announces the cut as `assistant_flushed` (`sessionOps.ts § _flushAssistant`),
// so the flush row lands BEFORE the boundary's own row (§14.71) and a browser
// never has to guess where a bubble ends. A replayed boundary whose row
// already exists drops a buffer proven persisted instead
// (`_dropReplayedAssistantBuffer`, announced as `assistant_flushed{duplicate}`).
//
// `effective_model` is a boundary too, but only when the model CHANGES (null →
// X included): text buffered before a mid-turn switch keeps the old label.
//
// Browser-safe, no imports: the legacy client (a hub without the
// `assistant_flushed` feature) flushes its own buffer on the same list.

export const ASSISTANT_FLUSH_EVENTS = [
  'structured_output', 'thinking', 'tool_use', 'permission_request', 'user_question',
  'exit_plan_request', 'stop', 'compaction', 'external_message', 'peer_message_status',
  'plan_update', 'plan_progress',
] as const;

export type AssistantFlushEvent = typeof ASSISTANT_FLUSH_EVENTS[number];

/** Also a boundary, on a CHANGE of model only. */
export const ASSISTANT_FLUSH_ON_CHANGE = 'effective_model' as const;

const FLUSH_SET: ReadonlySet<string> = new Set(ASSISTANT_FLUSH_EVENTS);

/** True for an event type that always closes the assistant bubble. */
export function isAssistantFlushEvent(type: string): type is AssistantFlushEvent {
  return FLUSH_SET.has(type);
}

/** What the session GET advertises in `features` (sync refonte C08): a client
 *  switches to hub-owned boundaries, `rowId`-keyed live rows and
 *  `clientMessageId` reconciliation only when the hub says so. */
export const HUB_TRANSCRIPT_FEATURES = [
  'assistant_flushed', 'thinking_flushed', 'assistant_reopened', 'row_ids', 'client_message_id',
] as const;

export type HubTranscriptFeature = typeof HUB_TRANSCRIPT_FEATURES[number];
