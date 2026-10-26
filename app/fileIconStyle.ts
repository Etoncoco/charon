/**
 * How file icons are drawn (`app.file_icons`), hub-wide like the theme: one
 * server-side setting, rendered onto `<html data-file-icons>` by the layout
 * (no flash), followed by every tab and device through `settings_changed`.
 *
 *  · `colored` — a glyph per language/role, each in its family's hue;
 *  · `mono`    — the same glyphs in the row's colour (git status included);
 *  · `classic` — the generic shapes (code / text / image…), the original set.
 *
 * Plain on purpose (no hook, no 'use client'): the layout reads it server-side.
 * The React hook lives in fileIcons.tsx.
 */
export const FILE_ICON_STYLES = ['colored', 'mono', 'classic'] as const;
export type FileIconStyle = (typeof FILE_ICON_STYLES)[number];
export const DEFAULT_FILE_ICONS: FileIconStyle = 'colored';

export function isFileIconStyle(value: unknown): value is FileIconStyle {
  return typeof value === 'string' && (FILE_ICON_STYLES as readonly string[]).includes(value);
}

export function resolveFileIcons(value: unknown): FileIconStyle {
  return isFileIconStyle(value) ? value : DEFAULT_FILE_ICONS;
}

export function currentFileIcons(): FileIconStyle {
  return typeof document === 'undefined'
    ? DEFAULT_FILE_ICONS
    : resolveFileIcons(document.documentElement.dataset.fileIcons);
}

const g = globalThis as unknown as { __charonFileIconSubs?: Set<() => void> };
const subs = (g.__charonFileIconSubs ??= new Set<() => void>());

/** Apply (settings refresh, settings preview) and tell every icon. */
export function applyFileIcons(value: unknown): void {
  const next = resolveFileIcons(value);
  if (document.documentElement.dataset.fileIcons === next) return;
  document.documentElement.dataset.fileIcons = next;
  for (const fn of subs) fn();
}

export function subscribeFileIcons(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
