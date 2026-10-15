// STUB(C14): the spec-exact subset of C12's `lib/transcriptRows.ts` (SPEC §6
// C12) that the conversation view reads. C12 owns this module and adds the
// rest (`RENDERED_EVENT_TYPES`, `isRenderedRow`, `FRAME_SNAPSHOT_CLASS`,
// `isTechnicalFrame`); the integrator replaces this file with C12's.
//
// Shared and browser-safe (no imports): which persisted rows a transcript
// VIEW carries. "Tools hidden" in the browser (`app/chatVisibility.ts`) asks
// the session GET for `view=conversation`, whose window counts and returns
// conversation rows only (CLAUDE.md §14.25).

export type TranscriptView = 'full' | 'conversation';

/** Rows the conversation view never fetches (rendered only with tools shown). */
export const TECHNICAL_ROLES = ['tool_use', 'tool_result', 'thinking'] as const;

/** Rows that render nothing in either view (their state rides on gate queues). */
export const RENDER_NULL_ROLES = ['user_question', 'exit_plan_request'] as const;

/** `event` rows that ride along with their page in conversation view: they
 *  render a message (compaction, structured output, fork point, peer traffic)
 *  or carry state the conversation still needs (bg tasks, async-question
 *  resolutions). */
export const CONVERSATION_EVENT_TYPES = ['compaction', 'structured_output', 'fork_point', 'external_message',
  'peer_message_status', 'bg_task', 'interaction_resolved'] as const;

const NON_SLOT_ROLES: ReadonlySet<string> = new Set<string>([
  'edit_snapshot', 'event', ...TECHNICAL_ROLES, ...RENDER_NULL_ROLES,
]);

/** A row that takes one of the conversation window's `limit` slots: not a
 *  side channel (edit_snapshot/event), not technical, not render-null. */
export function isConversationSlotRole(role: string): boolean {
  return !NON_SLOT_ROLES.has(role);
}
