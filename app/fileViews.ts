// Rendered views of a file (§14.111): which files have one, how a Markdown
// document's links and images resolve, and which file panes stay mounted.
// PLAIN module, zero imports — the pane, the panel and vitest share it.

/** Files the explorer offers a rendered View for (besides HTML's Live). */
export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

/**
 * GitHub-style heading anchor: `## Getting started!` → `getting-started`,
 * repeats get `-1`, `-2`. `seen` is per document render.
 */
export function markdownSlug(text: string, seen: Map<string, number>): string {
  const base = text.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/** Collapse `.`/`..` without touching the filesystem. */
function normalizeAbs(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return `/${out.join('/')}`;
}

/**
 * A Markdown document's link/image reference → an absolute path on the VPS,
 * or null when it is not a local file (a URL, `mailto:`, an in-page `#`).
 * Relative references resolve against the DOCUMENT's folder, the way GitHub
 * and every editor preview read them; `?query` is dropped, `#fragment` kept.
 */
export function resolveDocPath(docDir: string, ref: string): string | null {
  if (!ref || ref.startsWith('#') || ref.startsWith('//')) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(ref)) return null;
  const hashAt = ref.indexOf('#');
  const hash = hashAt >= 0 ? ref.slice(hashAt) : '';
  let path = (hashAt >= 0 ? ref.slice(0, hashAt) : ref).split('?', 1)[0];
  try { path = decodeURIComponent(path); } catch { return null; }
  if (!path) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return null;
  const abs = path.startsWith('/') ? path : `${docDir.replace(/\/+$/, '')}/${path}`;
  return normalizeAbs(abs) + hash;
}

/**
 * The (root, path) pair the file routes take for an absolute path: inside the
 * tab's root when it is, else its own folder — containment is per request.
 */
export function rootedPath(root: string, abs: string): { root: string; path: string } {
  const base = root.replace(/\/+$/, '');
  if (abs.startsWith(`${base}/`)) return { root, path: abs.slice(base.length + 1) };
  const slash = abs.lastIndexOf('/');
  return { root: abs.slice(0, slash) || '/', path: abs.slice(slash + 1) };
}

/**
 * The file panes kept MOUNTED, oldest first (§14.111): the newest `max` that
 * were shown, plus every one holding unsaved edits — eviction would throw
 * the buffer away. `open` is the set of keys that still have a tab; a closed
 * tab's pane goes, dirty or not (closing already asked).
 */
export function nextMountedFiles(
  prev: readonly string[], shown: string | null, open: ReadonlySet<string>,
  dirty: ReadonlySet<string>, max: number,
): string[] {
  const keys = prev.filter((k) => open.has(k) && k !== shown);
  if (shown && open.has(shown)) keys.push(shown);
  let excess = keys.length - max;
  const out: string[] = [];
  for (const k of keys) {
    if (excess > 0 && k !== shown && !dirty.has(k)) { excess--; continue; }
    out.push(k);
  }
  return out;
}

/**
 * Zoom factor of one Ctrl+wheel event. A trackpad pinch sends many small
 * deltas and wants them proportional; a mouse notch sends ~100 at once and
 * must not leap 7×. Capped to ±60 px-equivalent (≈1.6× a notch).
 */
export function wheelFactor(e: { deltaY: number; deltaMode: number }): number {
  const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  return Math.exp(-Math.max(-60, Math.min(60, px)) * 0.008);
}
