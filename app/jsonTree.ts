// The JSON tree view's pure half (§14.112). PLAIN module, zero imports.

export type JsonPath = (string | number)[];
export type ParsedJson =
  | { ok: true; value: unknown; lines?: number; loose?: boolean }
  | { ok: false; error: string };

/**
 * Comments (`//`, `/* *\/`) and trailing commas out, strings untouched — what
 * tsconfig.json, VS Code settings and .jsonc files need before JSON.parse.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  // A comma right before a closing bracket (whitespace between allowed).
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** JSON, JSONC, or one JSON value per line (.jsonl/.ndjson → an array). */
export function parseJsonDoc(text: string, name: string): ParsedJson {
  if (/\.(jsonl|ndjson)$/i.test(name)) {
    const values: unknown[] = [];
    const lines = text.split('\n');
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n].trim();
      if (!line) continue;
      try { values.push(JSON.parse(line)); } catch (e: unknown) {
        return { ok: false, error: `line ${n + 1}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    return { ok: true, value: values, lines: values.length };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (strict: unknown) {
    try {
      return { ok: true, value: JSON.parse(stripJsonComments(text)), loose: true };
    } catch {
      return { ok: false, error: strict instanceof Error ? strict.message : String(strict) };
    }
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** jq-style path: `.users[0].name`, `.["content-type"]`, `.` for the root. */
export function jqPath(path: JsonPath): string {
  if (!path.length) return '.';
  const out = path.map((p) => (typeof p === 'number' ? `[${p}]`
    : IDENT.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`)).join('');
  return out.startsWith('[') ? `.${out}` : out;
}

/** Stable key of a path (Set/Map member). */
export function pathKey(path: JsonPath): string {
  return JSON.stringify(path);
}

/**
 * Paths of nodes whose KEY or primitive VALUE contains `query`
 * (case-insensitive), and every ancestor of them (what must be open to show
 * them). Bounded: a filter on a huge document stops at `cap` matches.
 */
export function searchJson(value: unknown, query: string, cap = 2000): {
  matches: Set<string>; open: Set<string>; truncated: boolean;
} {
  const q = query.trim().toLowerCase();
  const matches = new Set<string>();
  const open = new Set<string>();
  let truncated = false;
  if (!q) return { matches, open, truncated };
  const visit = (v: unknown, path: JsonPath, key: string | null): boolean => {
    if (matches.size >= cap) { truncated = true; return false; }
    let hit = key != null && key.toLowerCase().includes(q);
    let below = false;
    if (v && typeof v === 'object') {
      const entries = Array.isArray(v) ? v.map((x, i) => [i, x] as const) : Object.entries(v);
      for (const [k, child] of entries) {
        if (visit(child, [...path, k], typeof k === 'number' ? null : k)) below = true;
      }
    } else if (!hit) {
      hit = String(v).toLowerCase().includes(q);
    }
    if (hit) matches.add(pathKey(path));
    if (below) open.add(pathKey(path));
    return hit || below;
  };
  visit(value, [], null);
  return { matches, open, truncated };
}

/** Containers under `value`, up to `limit` (for Expand all). */
export function containerPaths(value: unknown, limit = 5000): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: JsonPath) => {
    if (out.length >= limit || !v || typeof v !== 'object') return;
    out.push(pathKey(path));
    const entries = Array.isArray(v) ? v.map((x, i) => [i, x] as const) : Object.entries(v);
    for (const [k, child] of entries) walk(child, [...path, k]);
  };
  walk(value, []);
  return out;
}

/** `{…} 12 keys` / `[…] 3 items` — a collapsed node's one-line summary. */
export function summarize(v: unknown): string {
  if (Array.isArray(v)) return `[…] ${v.length} item${v.length === 1 ? '' : 's'}`;
  const n = Object.keys(v as object).length;
  return `{…} ${n} key${n === 1 ? '' : 's'}`;
}
