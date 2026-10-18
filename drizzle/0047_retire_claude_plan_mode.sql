-- Claude's `plan` permission mode was retired (Cursor keeps its own `plan`).
-- A stored one would match no button and resume as the agent's fallback, so
-- land it on that fallback explicitly: `normal` asks before every tool.
UPDATE claude_sessions SET permission_mode = 'normal'
  WHERE kind = 'claude' AND permission_mode = 'plan';--> statement-breakpoint
UPDATE claude_settings SET value = 'normal'
  WHERE key = 'claude.default_permission_mode' AND value = 'plan';
