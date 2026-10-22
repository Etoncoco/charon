// Jupyter notebooks (.ipynb) → a flat, render-ready model for NotebookViewer.
// PLAIN module, no React/DOM: vitest covers it. Reads nbformat 4 and
// tolerates nbformat 3 (`worksheets`, `input`, `pyout`/`pyerr`, MIME keys
// written as short names on the output itself).

export type NbOutput =
  | { kind: 'stream'; name: string; text: string }
  /** `text` is ready to render: images = whitespace-free base64, JSON pretty-printed. */
  | {
    kind: 'data'; mime: string; text: string; result: boolean;
    executionCount: number | null; width?: number; height?: number;
  }
  | { kind: 'error'; ename: string; evalue: string; traceback: string }
  | { kind: 'unsupported'; mimes: string[] };

export type NbCell =
  /** `attachments`: name → data: URI, for `![](attachment:name)`. */
  | { type: 'markdown'; source: string; attachments: Record<string, string> }
  | { type: 'code'; source: string; executionCount: number | null; outputs: NbOutput[] }
  | { type: 'raw'; source: string };

export type Notebook = {
  nbformat: number;
  /** Lower-case language name (`python`, `r`, `julia`…). */
  language: string;
  /** The kernel's display name when the notebook records one. */
  kernel: string | null;
  cells: NbCell[];
};

export type NotebookParse = { ok: true; notebook: Notebook } | { ok: false; error: string };

/** Display preference, richest first. Anything else falls back to `unsupported`. */
export const MIME_ORDER = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'text/html', 'text/markdown', 'application/json', 'text/plain', 'text/latex',
] as const;

/** nbformat 3 wrote MIME bundles flat on the output under these short names. */
const V3_MIME: Record<string, string> = {
  png: 'image/png', jpeg: 'image/jpeg', svg: 'image/svg+xml', html: 'text/html',
  markdown: 'text/markdown', json: 'application/json', text: 'text/plain',
  latex: 'text/latex', javascript: 'application/javascript', pdf: 'application/pdf',
};

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A multiline string: nbformat stores it as one string or a list of lines. */
export function joinSource(src: unknown): string {
  if (typeof src === 'string') return src;
  if (Array.isArray(src)) return src.map((s) => (typeof s === 'string' ? s : '')).join('');
  return '';
}

// CSI (colours, cursor moves), OSC (titles, hyperlinks) terminated by BEL or
// ST, DCS/SOS/PM/APC strings, charset selection, the remaining two-byte
// escapes (keypad modes, resets…), the 8-bit CSI, and finally any stray ESC.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[()*+][0-9A-Za-z]|\x1b[0-Z\\-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b/g;

/** Terminal escape sequences out: tracebacks and streams are coloured for a TTY. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/**
 * What a terminal would SHOW: escapes stripped, `\b` erases, and `\r`
 * overwrites the line from its start — a progress bar printing `\r 40%`
 * fifty times ends as its last state, the way Jupyter itself shows it.
 */
export function cleanTerminalText(s: string): string {
  let t = stripAnsi(s);
  if (t.includes('\b')) {
    const out: string[] = [];
    for (const ch of t) {
      if (ch === '\b') { if (out.length && out[out.length - 1] !== '\n') out.pop(); } else out.push(ch);
    }
    t = out.join('');
  }
  if (t.includes('\r')) {
    t = t.replace(/\r+\n/g, '\n').split('\n').map((line) => {
      if (!line.includes('\r')) return line;
      let shown = '';
      for (const part of line.split('\r')) shown = part + shown.slice(part.length);
      return shown;
    }).join('\n');
  }
  return t;
}

/** The MIME type to display from a bundle, or null when none is displayable. */
export function pickMime(bundle: Json): string | null {
  for (const mime of MIME_ORDER) if (bundle[mime] != null) return mime;
  return null;
}

function bundleText(mime: string, value: unknown): string {
  if (mime === 'application/json') {
    if (typeof value === 'string' || Array.isArray(value)) {
      const raw = joinSource(value);
      try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
    }
    return JSON.stringify(value, null, 2) ?? '';
  }
  const text = joinSource(value);
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return text.replace(/\s+/g, '');
  if (mime === 'text/plain' || mime === 'text/latex') return cleanTerminalText(text);
  return text;
}

function size(meta: unknown, mime: string): { width?: number; height?: number } {
  const m = isObj(meta) ? (isObj(meta[mime]) ? meta[mime] as Json : meta) : null;
  if (!m) return {};
  const num = (v: unknown) => (typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : undefined);
  return { width: num(m.width), height: num(m.height) };
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseOutput(raw: unknown): NbOutput | null {
  if (!isObj(raw)) return null;
  const type = raw.output_type;
  if (type === 'stream') {
    const name = typeof raw.name === 'string' ? raw.name : typeof raw.stream === 'string' ? raw.stream : 'stdout';
    return { kind: 'stream', name, text: joinSource(raw.text) };
  }
  if (type === 'error' || type === 'pyerr') {
    const ename = typeof raw.ename === 'string' ? raw.ename : 'Error';
    const evalue = typeof raw.evalue === 'string' ? raw.evalue : '';
    const lines = Array.isArray(raw.traceback) ? raw.traceback.filter((l): l is string => typeof l === 'string') : [];
    const traceback = lines.length ? cleanTerminalText(lines.join('\n')) : `${ename}: ${evalue}`;
    return { kind: 'error', ename: stripAnsi(ename), evalue: stripAnsi(evalue), traceback };
  }
  if (type === 'execute_result' || type === 'display_data' || type === 'pyout' || type === 'update_display_data') {
    let bundle: Json;
    if (isObj(raw.data)) bundle = raw.data;
    else {
      bundle = {};
      for (const [short, mime] of Object.entries(V3_MIME)) if (raw[short] != null) bundle[mime] = raw[short];
    }
    const result = type === 'execute_result' || type === 'pyout';
    const mime = pickMime(bundle);
    if (!mime) return { kind: 'unsupported', mimes: Object.keys(bundle) };
    return {
      kind: 'data', mime, text: bundleText(mime, bundle[mime]), result,
      executionCount: result ? count(raw.execution_count ?? raw.prompt_number) : null,
      ...(mime.startsWith('image/') ? size(raw.metadata, mime) : {}),
    };
  }
  return null;
}

/**
 * Outputs as the notebook front-ends show them: consecutive chunks of the
 * same stream are ONE block (a loop printing per iteration writes many), and
 * carriage returns apply across the chunk boundaries they straddle.
 */
export function parseOutputs(raw: unknown): NbOutput[] {
  if (!Array.isArray(raw)) return [];
  const out: NbOutput[] = [];
  for (const item of raw) {
    const o = parseOutput(item);
    if (!o) continue;
    const prev = out[out.length - 1];
    if (o.kind === 'stream' && prev?.kind === 'stream' && prev.name === o.name) prev.text += o.text;
    else out.push(o);
  }
  for (const o of out) if (o.kind === 'stream') o.text = cleanTerminalText(o.text);
  return out;
}

/** Cell attachments → data: URIs, images only (they end up in an `<img>`). */
function attachmentUris(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(raw)) return out;
  for (const [name, bundle] of Object.entries(raw)) {
    if (!isObj(bundle)) continue;
    const mime = Object.keys(bundle).find((m) => m.startsWith('image/'));
    if (!mime) continue;
    out[name] = `data:${mime};base64,${joinSource(bundle[mime]).replace(/\s+/g, '')}`;
  }
  return out;
}

function parseCell(raw: unknown, v3: boolean): NbCell | null {
  if (!isObj(raw)) return null;
  const source = joinSource(raw.source ?? raw.input);
  switch (raw.cell_type) {
    case 'markdown':
      return { type: 'markdown', source, attachments: attachmentUris(raw.attachments) };
    case 'heading': {
      // nbformat 3 only: headings were their own cell type.
      const level = Math.min(6, Math.max(1, count(raw.level) ?? 1));
      return { type: 'markdown', source: `${'#'.repeat(level)} ${source.replace(/\n/g, ' ')}`, attachments: {} };
    }
    case 'code':
      return {
        type: 'code', source,
        executionCount: count(v3 ? raw.prompt_number : raw.execution_count),
        outputs: parseOutputs(raw.outputs),
      };
    case 'raw':
      return { type: 'raw', source };
    default:
      return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function parseNotebook(text: string): NotebookParse {
  if (!text.trim()) return { ok: false, error: 'this notebook is empty' };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObj(doc)) return { ok: false, error: 'not a Jupyter notebook: the top level is not an object' };
  const nbformat = count(doc.nbformat) ?? (Array.isArray(doc.worksheets) ? 3 : 4);
  const ws = Array.isArray(doc.worksheets) ? doc.worksheets[0] : null;
  const rawCells = Array.isArray(doc.cells) ? doc.cells : isObj(ws) && Array.isArray(ws.cells) ? ws.cells : null;
  if (!rawCells) return { ok: false, error: 'not a Jupyter notebook: no cells' };
  const v3 = !Array.isArray(doc.cells);
  const meta = isObj(doc.metadata) ? doc.metadata : {};
  const spec = isObj(meta.kernelspec) ? meta.kernelspec : {};
  const info = isObj(meta.language_info) ? meta.language_info : {};
  const firstCodeLang = rawCells.find((c) => isObj(c) && c.cell_type === 'code' && typeof c.language === 'string') as Json | undefined;
  const language = (str(spec.language) ?? str(info.name) ?? str(meta.language)
    ?? str(firstCodeLang?.language) ?? 'python').toLowerCase();
  const cells = rawCells.map((c) => parseCell(c, v3)).filter((c): c is NbCell => c != null);
  return { ok: true, notebook: { nbformat, language, kernel: str(spec.display_name), cells } };
}

/** highlight.js names for kernel languages that spell themselves otherwise. */
const HLJS_ALIASES: Record<string, string> = {
  'c++': 'cpp', 'c#': 'csharp', 'f#': 'fsharp', ipython: 'python', ipython3: 'python',
  python3: 'python', python2: 'python', sage: 'python', octave: 'matlab', 'q#': 'qsharp',
};

/** A fence info string for a kernel language: no spaces, no backticks. */
export function highlightLanguage(language: string): string {
  const lang = language.trim().toLowerCase();
  return (HLJS_ALIASES[lang] ?? lang).replace(/[^a-z0-9_+#-]/g, '');
}

/**
 * Source as a fenced Markdown code block, so it goes through the chat's
 * renderer (highlighting + copy button). The fence outgrows any backtick run
 * inside the code: a cell that itself writes ``` must not close it early.
 */
export function fenceCode(code: string, language: string): string {
  const longest = (code.match(/`+/g) ?? []).reduce((m, run) => Math.max(m, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${highlightLanguage(language)}\n${code.replace(/\n$/, '')}\n${fence}`;
}

/** Jupyter's own heading anchor: the text, spaces → `-`, case kept. */
export function jupyterAnchor(text: string): string {
  return text.trim().replace(/ /g, '-');
}

/** Whether an HTML output relies on scripts (which the sandbox never runs). */
export function htmlNeedsScripts(html: string): boolean {
  return /<script\b/i.test(html);
}
