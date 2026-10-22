// Pure helpers of the 3D model pane (ModelViewer.tsx, §14.112): which files
// it reads, how a glTF's side files resolve on the VPS, camera/grid maths and
// the facts the toolbar prints. No React, no DOM, no three.js — vitest runs
// them in node. The byte helpers are shared with FontViewer.
import { resolveDocPath } from './fileViews';

export type ModelFormat = 'glb' | 'gltf' | 'stl' | 'obj' | 'ply';

/** Extensions the model pane accepts (lower case, no dot). */
export const MODEL_EXTENSIONS: readonly ModelFormat[] = ['glb', 'gltf', 'stl', 'obj', 'ply'];

export function modelFormat(name: string): ModelFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (MODEL_EXTENSIONS as readonly string[]).includes(ext ?? '') ? ext as ModelFormat : null;
}

// ── glTF side files ─────────────────────────────────────────────────────────

/**
 * The fake base path GLTFLoader.parse() is given. three.js glues it in front
 * of every RELATIVE uri (`scene.bin` → `charon-model:scene.bin`) and leaves
 * data:, blob: and http(s): ones alone — so the URL modifier knows exactly
 * which requests are side files to fetch from the VPS.
 */
export const MODEL_BASE = 'charon-model:';

/** The model's absolute path on the VPS. */
export function modelAbsPath(root: string, path: string): string {
  return `${root.replace(/\/+$/, '')}/${path}`;
}

/**
 * A uri inside a glTF → the absolute path of that file on the VPS, or null
 * when it is not a local file. Relative to the MODEL's folder, the way every
 * glTF tool reads it; `./`, `../` and percent-encoding resolve, `?query` and
 * `#fragment` are dropped. Backslashes (some Windows exporters write
 * `textures\a.png`) count as separators.
 */
export function resolveModelUri(modelAbs: string, uri: string): string | null {
  const dir = modelAbs.slice(0, modelAbs.lastIndexOf('/')) || '/';
  const abs = resolveDocPath(dir, uri.replace(/\\/g, '/'));
  if (!abs) return null;
  const hash = abs.indexOf('#');
  const clean = hash >= 0 ? abs.slice(0, hash) : abs;
  return clean === '/' ? null : clean;
}

/**
 * Images the file route serves INLINE with their real content type (§14.73's
 * allow-list). Everything else comes as raw bytes — a buffer does not care,
 * an `<img>` fallback loader would.
 */
export function isInlineImage(path: string): boolean {
  return /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(path);
}

export type GltfExtensions = { used: string[]; required: string[] };

/**
 * `extensionsUsed`/`extensionsRequired` of a .glb or .gltf, read before the
 * loader runs: a Draco or KTX2 asset gets a sentence instead of a stack
 * trace, and the meshopt decoder is only fetched when a file needs it.
 * Null when the bytes are not glTF JSON at all.
 */
export function gltfExtensions(buf: ArrayBuffer): GltfExtensions | null {
  try {
    const bytes = new Uint8Array(buf);
    let json: string;
    if (bytes.length >= 20 && String.fromCharCode(...bytes.subarray(0, 4)) === 'glTF') {
      const view = new DataView(buf);
      const len = view.getUint32(12, true);
      if (view.getUint32(16, true) !== 0x4e4f534a) return null; // 'JSON'
      json = new TextDecoder().decode(bytes.subarray(20, 20 + len));
    } else {
      json = new TextDecoder().decode(bytes);
    }
    const doc = JSON.parse(json) as { extensionsUsed?: unknown; extensionsRequired?: unknown };
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { used: list(doc.extensionsUsed), required: list(doc.extensionsRequired) };
  } catch {
    return null;
  }
}

export function needsMeshopt(ext: GltfExtensions | null): boolean {
  return !!ext?.used.some((e) => e === 'EXT_meshopt_compression' || e === 'KHR_meshopt_compression');
}

/** Why this glTF cannot be shown here, or null when it can. */
export function gltfUnsupported(ext: GltfExtensions | null): string | null {
  if (!ext) return null;
  if (ext.used.includes('KHR_draco_mesh_compression')) {
    return 'this glTF is Draco-compressed, which this viewer does not decode — export it without mesh compression to view it here';
  }
  if (ext.required.includes('KHR_texture_basisu')) {
    return 'this glTF requires KTX2 (Basis) textures, which this viewer does not decode';
  }
  return null;
}

// ── PLY ─────────────────────────────────────────────────────────────────────

/**
 * Faces a PLY header declares (`element face N`), 0 for a point cloud, null
 * when the header cannot be read. A scan with no faces is shown as points —
 * three.js would otherwise draw nothing at all.
 */
export function plyFaceCount(head: Uint8Array): number | null {
  const text = new TextDecoder('latin1').decode(head.subarray(0, 64 * 1024));
  if (!text.startsWith('ply')) return null;
  const end = text.indexOf('end_header');
  if (end < 0) return null;
  const m = /^element\s+face\s+(\d+)\s*$/m.exec(text.slice(0, end));
  return m ? Number(m[1]) : 0;
}

// ── Scene maths ─────────────────────────────────────────────────────────────

/**
 * Camera distance at which a sphere of `radius` fits the view, whichever of
 * the vertical or horizontal field of view is tighter (a tall pane narrows
 * the horizontal one).
 */
export function fitDistance(radius: number, vFovDeg: number, aspect: number, margin = 1.15): number {
  const v = (vFovDeg * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * (aspect > 0 ? aspect : 1));
  return (Math.max(radius, 1e-9) * margin) / Math.sin(Math.min(v, h) / 2);
}

/** 1, 2 or 5 × 10ⁿ: the nearest round step at or above `x`. */
export function niceStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  const k = m <= 1 + 1e-9 ? 1 : m <= 2 + 1e-9 ? 2 : m <= 5 + 1e-9 ? 5 : 10;
  return k * p;
}

/**
 * A floor grid for a model whose footprint spans `extent`: about 1.6× wider,
 * in round cells (1/2/5 × 10ⁿ), an even count so a line passes the centre.
 */
export function gridSpec(extent: number): { size: number; divisions: number; step: number } {
  const total = Math.max(extent, 1e-6) * 1.6;
  const step = niceStep(total / 10);
  let divisions = Math.ceil(total / step - 1e-9);
  if (divisions % 2) divisions++;
  return { size: step * divisions, divisions, step };
}

/**
 * World size of one dot of a point cloud: about the spacing of `count`
 * points spread over the surface of its bounding sphere, so a dense scan
 * reads as a surface and a sparse one as dots — never a blob.
 */
export function pointSize(radius: number, count: number): number {
  const r = Math.max(radius, 1e-9);
  const spacing = Math.sqrt((4 * Math.PI * r * r) / Math.max(count, 1));
  return Math.min(r / 40, Math.max(r / 2000, spacing * 1.2));
}

// ── Colours (theme tokens → WebGL, §14.99) ─────────────────────────────────

export type Rgb = [number, number, number];

/**
 * A computed CSS colour → sRGB components in 0..1. Reads the forms a token
 * resolves to (`#rgb`, `#rrggbb(aa)`, `rgb()`/`rgba()`, `color(srgb …)`);
 * null for anything else, so the caller can try its next token.
 */
export function parseCssColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    const h = m[1];
    const full = h.length <= 4 ? [...h.slice(0, 3)].map((c) => c + c).join('') : h.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb;
  }
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/.exec(s);
  if (m) {
    const ch = (v: string) => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / 255);
    const rgb = [ch(m[1]), ch(m[2]), ch(m[3])];
    return rgb.every(Number.isFinite) ? rgb.map((v) => Math.min(1, Math.max(0, v))) as Rgb : null;
  }
  m = /^color\(\s*srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*[\d.]+%?)?\s*\)$/.exec(s);
  if (m) {
    const rgb = [m[1], m[2], m[3]].map(Number);
    return rgb.every(Number.isFinite) ? rgb.map((v) => Math.min(1, Math.max(0, v))) as Rgb : null;
  }
  return null;
}

/** `a` weighted `t` against `b` — what `color-mix(in srgb, a t%, b)` gives. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => a[i] * t + b[i] * (1 - t)) as Rgb;
}

// ── What the toolbar prints ─────────────────────────────────────────────────

/** `12840` → `12 840` (narrow no-break space: never split across lines). */
export function formatCount(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatBytes(n: number): string {
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export type ModelFacts = { triangles: number; points: number; meshes: number; bytes: number };

/** `12 840 triangles · 2 meshes · 3.4 MB`; a point cloud counts its points. */
export function formatModelStats({ triangles, points, meshes, bytes }: ModelFacts): string {
  const parts: string[] = [];
  if (triangles > 0 || points === 0) parts.push(plural(triangles, 'triangle', 'triangles'));
  if (points > 0) parts.push(plural(points, 'point', 'points'));
  if (meshes > 0) parts.push(plural(meshes, 'mesh', 'meshes'));
  if (bytes > 0) parts.push(formatBytes(bytes));
  return parts.join(' · ');
}

/** Bounding-box size in model units, three significant digits per axis. */
export function formatDims([x, y, z]: [number, number, number]): string {
  const f = (v: number) => {
    if (!Number.isFinite(v)) return '?';
    if (v === 0) return '0';
    const p = Number(v.toPrecision(3));
    return Math.abs(p) >= 1e5 || Math.abs(p) < 1e-3 ? p.toExponential(2) : String(p);
  };
  return `${f(x)} × ${f(y)} × ${f(z)}`;
}

// ── Reading the bytes ───────────────────────────────────────────────────────

/** A model past this is more than a browser tab should be asked to hold. */
export const MAX_MODEL_BYTES = 512 * 1024 * 1024;

/** An HTTP or route failure, with the hub's own sentence when it sent one. */
export class FileFetchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'FileFetchError';
  }
}

/**
 * The body of a file-route response as bytes. The route answers some
 * failures (agent offline, old agent) with a 200 JSON envelope, so a JSON
 * content type on a raw read is an error, never the file. `onProgress` gets
 * (loaded, total) — total 0 when the length is unknown.
 */
export async function readFileBytes(
  res: Response,
  onProgress?: (loaded: number, total: number) => void,
  max = MAX_MODEL_BYTES,
): Promise<ArrayBuffer> {
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || type.includes('application/json')) {
    let detail = '';
    try { detail = String(((await res.json()) as { error?: unknown })?.error ?? ''); } catch { /* not JSON */ }
    throw new FileFetchError(detail || `HTTP ${res.status}`, res.status);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (total > max) throw new FileFetchError(`the file is too large to open here (${formatBytes(total)})`, 413);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (loaded > max) {
      void reader.cancel();
      throw new FileFetchError(`the file is too large to open here (over ${formatBytes(max)})`, 413);
    }
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer;
}

/** One sentence for the error note, whatever failed along the way. */
export function describeModelError(e: unknown, format: ModelFormat): string {
  const err = e as { name?: string; message?: string } | null;
  const msg = String(err?.message ?? e ?? '');
  if (err?.name === 'FileFetchError') {
    return msg.startsWith('the file') ? msg : `could not read this file from the VPS: ${msg}`;
  }
  if (err?.name === 'EmptyModel') return 'this file contains no geometry to show';
  if (err?.name === 'UnsupportedModel') return msg;
  if (/DRACOLoader/i.test(msg)) return gltfUnsupported({ used: ['KHR_draco_mesh_compression'], required: [] })!;
  if (/KTX2/i.test(msg)) return gltfUnsupported({ used: [], required: ['KHR_texture_basisu'] })!;
  const buffer = /Failed to load buffer "([^"]*)"/.exec(msg);
  if (buffer) return `could not load "${buffer[1]}", a file this model needs next to it`;
  if (/Unsupported asset/i.test(msg)) return 'only glTF 2.0 files can be shown (this one is older)';
  if (format === 'gltf' || format === 'glb') {
    if (err?.name === 'SyntaxError' || /JSON/.test(msg)) return `this file is not valid ${format === 'glb' ? 'GLB' : 'glTF'}`;
  }
  const label = format.toUpperCase();
  // A binary parser walking off the end of the bytes: the file is cut short.
  if (err?.name === 'RangeError') return `this ${label} file is truncated or damaged`;
  return msg ? `could not read this ${label} file: ${msg}` : `could not read this ${label} file`;
}
