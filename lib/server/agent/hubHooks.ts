import 'server-only';
import type { AgentKind } from './types';
import type { VpsStatusEmitter } from './AgentClient';

// hubHooks — THE injection slots of the hub (CLAUDE.md §14.106).
// ─────────────────────────────────────────────────────────────────────────────
// Next evaluates a server module in several copies (the instrumentation copy
// that boots the agents, the route/RSC copy, the login server-action copy), and
// a module-level `let` exists once PER COPY. The slots below used to be such
// `let`s: a hook wired by one copy (eventConnections' focus checker lives only
// in the route copy) stayed null in the copy that reads it (the boot-attached
// SessionStreams of the instrumentation copy), so every finish of a
// boot-attached session marked itself unread while the user watched it.
//
// One object on `globalThis`, created with `??=`, shared by every copy. Each
// `set*` keeps its historical exported name and writes `hubHooks().x`; every
// reader calls `hubHooks().x?.(…)` at USE time (never caches the function).
// Type-only imports above: this module pulls no runtime dependency, so any
// module may import it without an import cycle.
export type HubHooks = {
  /** "Is this session being watched?" — eventConnections § isBeingWatched. */
  focusChecker?: (sessionId: string) => boolean;
  /** Post-stop Claude account-usage refresh — usagePoll. */
  usagePollTrigger?: (vpsId: string, profile?: string) => void;
  /** Post-stop Codex account-usage refresh — usagePoll. */
  codexUsagePollTrigger?: (vpsId: string, profile?: string) => void;
  /** App-server AccountRateLimitsUpdated push — usagePoll. */
  codexUsagePushHandler?: (vpsId: string, detail: unknown, profile?: string, accountKey?: string | null) => void;
  /** A Claude `rate_limit` event's live 5h/7d windows — usagePoll. */
  usageWindowsHandler?: (vpsId: string, windows: unknown, atMs: number, profile?: string, accountKey?: string | null) => void;
  /** Reset time of an exhausted account window — usagePoll. */
  usageResetResolver?: (vpsId: string, kind: AgentKind, profile?: string) => number | null;
  /** Live `vps_status` push wired by sessionOps for AgentClient (import cycle). */
  vpsStatusEmitter?: VpsStatusEmitter;
  /** AgentClients whose self-healing hooks are wired — autoConnect. */
  armedClients?: WeakSet<object>;
};

export function hubHooks(): HubHooks {
  return ((globalThis as unknown as { __charonHooks?: HubHooks }).__charonHooks ??= {});
}
