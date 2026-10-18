ALTER TABLE `claude_pending_permissions` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `claude_pending_permissions` ADD `suggestions` text;--> statement-breakpoint
-- Codex modes are now the CLI's three /approvals presets. The retired
-- `full-access` rung (no sandbox, still asking) lands on the default preset:
-- the agent would load it there anyway, and the tighter side is the safe one.
UPDATE claude_sessions SET permission_mode = 'workspace-write'
  WHERE kind = 'codex' AND permission_mode = 'full-access';--> statement-breakpoint
UPDATE claude_settings SET value = 'workspace-write'
  WHERE key = 'codex.default_permission_mode' AND value = 'full-access';
