// Map files → one GeoJSON FeatureCollection (GeoViewer.tsx): GeoJSON, GPX and
// KML, plus the numbers the toolbar and the popups show. PLAIN module, zero
// imports and no DOM: the XML formats are read through `GeoElement`, which a
// browser `Element` satisfies and a test builds by hand.

// ── GeoJSON shapes (the subset drawn; positions are [lon, lat, ele?]) ───────

export type Position = number[];
export type GeoGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] }
  | { type: 'GeometryCollection'; geometries: GeoGeometry[] };
export type GeoProperties = Record<string, unknown>;
export type GeoFeature = {
  type: 'Feature';
  geometry: GeoGeometry;
  properties: GeoProperties;
  id?: string | number;
};
export type GeoFeatureCollection = { type: 'FeatureCollection'; features: GeoFeature[] };

/** A parsed file. `skipped` = entries dropped for malformed coordinates. */
export type ParsedGeo = { collection: GeoFeatureCollection; skipped: number };

/** A reason meant for the user ("not valid JSON: …"), shown as the pane's note. */
export class GeoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoParseError';
  }
}

export type GeoFormat = 'geojson' | 'gpx' | 'kml';

/** `.json` is NOT here: most JSON is not geographic, and sniffing is the pane's call. */
export function geoFormatOf(name: string): GeoFormat | null {
  const m = /\.(geojson|gpx|kml)$/i.exec(name);
  return m ? (m[1].toLowerCase() as GeoFormat) : null;
}

export function isGeoName(name: string): boolean {
  return geoFormatOf(name) != null;
}

/**
 * One entry point for the three formats. `parseXml` is the browser's
 * DOMParser in the viewer (it throws a GeoParseError on malformed XML) and a
 * fake in the tests.
 */
export function parseGeoText(text: string, format: GeoFormat, parseXml: (text: string) => GeoElement): ParsedGeo {
  if (!text.trim()) throw new GeoParseError('this file is empty');
  if (format === 'geojson') {
    let value: unknown;
    try { value = JSON.parse(text); } catch (e) {
      throw new GeoParseError(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    return normalizeGeoJson(value);
  }
  const root = parseXml(text);
  return format === 'gpx' ? gpxToGeoJson(root) : kmlToGeoJson(root);
}

/**
 * The browser's `<parsererror>` text → one line. Chrome wraps the reason in
 * boilerplate ("This page contains the following errors: … Below is a
 * rendering …"); Firefox starts with "XML Parsing Error:".
 */
export function xmlErrorMessage(raw: string): string {
  // Newer Chrome names tags `{http://www.topografix.com/GPX/1/1}trk`.
  const flat = raw.replace(/\{[a-z][\w+.-]*:[^{}\s]*\}/gi, '').replace(/\s+/g, ' ').trim();
  const chrome = /error on line (\d+) at column (\d+):\s*(.*?)\s*(?=Below is a rendering|$)/i.exec(flat);
  if (chrome) return `not valid XML: ${chrome[3].slice(0, 200)} (line ${chrome[1]}, column ${chrome[2]})`;
  const firefox = /XML Parsing Error:\s*([^\n]*)/i.exec(raw);
  if (firefox) {
    const where = /Line Number (\d+), Column (\d+)/i.exec(raw);
    return `not valid XML: ${firefox[1].trim().slice(0, 200)}${where ? ` (line ${where[1]}, column ${where[2]})` : ''}`;
  }
  return `not valid XML${flat ? `: ${flat.slice(0, 200)}` : ''}`;
}

// ── GeoJSON ─────────────────────────────────────────────────────────────────

type Ctx = { skipped: number; outOfRange: boolean };
/** Valid GeoJSON with nothing to draw (`[]` coordinates): dropped, not "skipped". */
const EMPTY = Symbol('empty');

function position(v: unknown, ctx: Ctx): Position | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const [lon, lat, ele] = v as unknown[];
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  // Metres from a projected CRS are finite numbers too — they just are not degrees.
  if (Math.abs(lat) > 90 || Math.abs(lon) > 360) { ctx.outOfRange = true; return null; }
  return typeof ele === 'number' && Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat];
}

function positions(v: unknown, min: number, ctx: Ctx): Position[] | null {
  if (!Array.isArray(v) || v.length < min) return null;
  const out: Position[] = [];
  for (const p of v) {
    const q = position(p, ctx);
    if (!q) return null;
    out.push(q);
  }
  return out;
}

function nested<T>(v: unknown, each: (x: unknown) => T | null): T[] | null | typeof EMPTY {
  if (!Array.isArray(v)) return null;
  if (!v.length) return EMPTY;
  const out: T[] = [];
  for (const x of v) {
    const y = each(x);
    if (!y) return null;
    out.push(y);
  }
  return out;
}

/** `null` = malformed; strict per geometry, so a half-valid one is never drawn wrong. */
function geometry(v: unknown, ctx: Ctx): GeoGeometry | null | typeof EMPTY {
  if (!v || typeof v !== 'object') return null;
  const g = v as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  const c = g.coordinates;
  const ring = (r: unknown) => positions(r, 3, ctx);
  const wrap = <T>(r: T[] | null | typeof EMPTY, make: (x: T[]) => GeoGeometry) =>
    r === null || r === EMPTY ? r : make(r);
  switch (g.type) {
    case 'Point': {
      if (Array.isArray(c) && !c.length) return EMPTY;
      const p = position(c, ctx);
      return p && { type: 'Point', coordinates: p };
    }
    case 'MultiPoint':
      return wrap(nested(c, (p) => position(p, ctx)), (coordinates) => ({ type: 'MultiPoint', coordinates }));
    case 'LineString': {
      if (Array.isArray(c) && !c.length) return EMPTY;
      const line = positions(c, 2, ctx);
      return line && { type: 'LineString', coordinates: line };
    }
    case 'MultiLineString':
      return wrap(nested(c, (l) => positions(l, 2, ctx)), (coordinates) => ({ type: 'MultiLineString', coordinates }));
    case 'Polygon':
      return wrap(nested(c, ring), (coordinates) => ({ type: 'Polygon', coordinates }));
    case 'MultiPolygon':
      return wrap(nested(c, (p) => { const r = nested(p, ring); return r === EMPTY ? null : r; }),
        (coordinates) => ({ type: 'MultiPolygon', coordinates }));
    case 'GeometryCollection': {
      if (!Array.isArray(g.geometries)) return null;
      const out: GeoGeometry[] = [];
      for (const child of g.geometries) {
        const n = geometry(child, ctx);
        if (n === null) return null;
        if (n !== EMPTY) out.push(n);
      }
      return out.length ? { type: 'GeometryCollection', geometries: out } : EMPTY;
    }
    default:
      return null;
  }
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const GEOMETRY_TYPES = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection',
]);

function pushFeature(out: GeoFeature[], v: unknown, ctx: Ctx): void {
  if (!plainObject(v)) { ctx.skipped++; return; }
  // A bare geometry inside `features` is wrong but unambiguous.
  const isFeature = v.type === 'Feature';
  if (!isFeature && !GEOMETRY_TYPES.has(String(v.type))) { ctx.skipped++; return; }
  const raw = isFeature ? v.geometry : v;
  // `geometry: null` is a valid unlocated feature: nothing to draw, nothing wrong.
  if (raw == null) return;
  const g = geometry(raw, ctx);
  if (g === EMPTY) return;
  if (!g) { ctx.skipped++; return; }
  const f: GeoFeature = { type: 'Feature', geometry: g, properties: isFeature && plainObject(v.properties) ? v.properties : {} };
  if (isFeature && (typeof v.id === 'string' || typeof v.id === 'number')) f.id = v.id;
  out.push(f);
}

/** Old (2008) GeoJSON could name a projected CRS; RFC 7946 is lon/lat only. */
function checkCrs(v: Record<string, unknown>): void {
  const crs = v.crs;
  if (!plainObject(crs) || !plainObject(crs.properties)) return;
  const name = crs.properties.name;
  if (typeof name !== 'string' || /CRS84|EPSG:+4326\b/i.test(name)) return;
  throw new GeoParseError(`this file uses the coordinate system "${name}" — only longitude/latitude (WGS 84) can be drawn`);
}

/**
 * Any GeoJSON object (a bare Geometry, a Feature, a FeatureCollection — or an
 * array of those, which Leaflet accepts too) → a FeatureCollection whose every
 * geometry is safe to hand to Leaflet. Throws only when the whole input is not
 * GeoJSON; a malformed feature is dropped and counted.
 */
export function normalizeGeoJson(value: unknown): ParsedGeo {
  const ctx: Ctx = { skipped: 0, outOfRange: false };
  const features: GeoFeature[] = [];
  if (Array.isArray(value)) {
    for (const v of value) pushFeature(features, v, ctx);
  } else if (!plainObject(value)) {
    throw new GeoParseError('not a GeoJSON object');
  } else {
    checkCrs(value);
    if (value.type === 'FeatureCollection') {
      if (!Array.isArray(value.features)) throw new GeoParseError('a FeatureCollection needs a "features" array');
      for (const v of value.features) pushFeature(features, v, ctx);
    } else if (value.type === 'Feature' || GEOMETRY_TYPES.has(String(value.type))) {
      pushFeature(features, value, ctx);
      if (!features.length && ctx.skipped) {
        throw new GeoParseError(ctx.outOfRange ? OUT_OF_RANGE : `this ${String(value.type)} has invalid coordinates`);
      }
    } else if (value.type === undefined) {
      throw new GeoParseError('not GeoJSON: no "type" member');
    } else {
      throw new GeoParseError(`not GeoJSON: unknown type "${String(value.type)}"`);
    }
  }
  if (!features.length && ctx.outOfRange) throw new GeoParseError(OUT_OF_RANGE);
  return { collection: { type: 'FeatureCollection', features }, skipped: ctx.skipped };
}

const OUT_OF_RANGE = 'coordinates are not longitude/latitude degrees — is this file in a projected coordinate system?';

// ── XML (GPX, KML) ──────────────────────────────────────────────────────────

/**
 * The part of a DOM `Element` the converters read. Names are matched on the
 * LOCAL name, case-insensitively: GPX and KML use default namespaces and KML
 * is often written with a `kml:` (or `gx:`) prefix.
 */
export interface GeoElement {
  readonly localName?: string | null;
  readonly tagName?: string;
  readonly textContent?: string | null;
  readonly children: ArrayLike<GeoElement>;
  getAttribute(name: string): string | null;
}

function rawName(el: GeoElement): string {
  return el.localName || el.tagName || '';
}

function nameOf(el: GeoElement): string {
  const n = rawName(el);
  return n.slice(n.indexOf(':') + 1).toLowerCase();
}

function kids(el: GeoElement, name?: string): GeoElement[] {
  const out: GeoElement[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (!name || nameOf(c) === name) out.push(c);
  }
  return out;
}

function kid(el: GeoElement, name: string): GeoElement | undefined {
  for (let i = 0; i < el.children.length; i++) {
    if (nameOf(el.children[i]) === name) return el.children[i];
  }
  return undefined;
}

function kidText(el: GeoElement, name: string): string | undefined {
  const t = kid(el, name)?.textContent?.trim();
  return t || undefined;
}

/** `Number('')` is 0: an absent value must stay absent. */
function num(s: string | null | undefined): number {
  return s == null || !s.trim() ? NaN : Number(s);
}

function validLonLat(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 360;
}

function textProps(el: GeoElement, names: readonly string[]): GeoProperties {
  const props: GeoProperties = {};
  for (const n of names) {
    const t = kidText(el, n);
    if (t !== undefined) props[n] = t;
  }
  return props;
}

function line(coords: Position[]): GeoGeometry {
  return { type: 'LineString', coordinates: coords };
}

// GPX ────────────────────────────────────────────────────────────────────────

function gpxPoint(pt: GeoElement): Position | null {
  const lat = num(pt.getAttribute('lat'));
  const lon = num(pt.getAttribute('lon'));
  if (!validLonLat(lon, lat)) return null;
  const ele = num(kidText(pt, 'ele'));
  return Number.isFinite(ele) ? [lon, lat, ele] : [lon, lat];
}

/** Valid points of a list; a malformed one is dropped and counted. */
function gpxPoints(pts: GeoElement[], ctx: Ctx): Position[] {
  const out: Position[] = [];
  for (const pt of pts) {
    const p = gpxPoint(pt);
    if (p) out.push(p); else ctx.skipped++;
  }
  return out;
}

function firstTime(segs: GeoElement[][]): string | undefined {
  for (const seg of segs) {
    for (const pt of seg) {
      const t = kidText(pt, 'time');
      if (t) return t;
    }
  }
  return undefined;
}

const GPX_TEXT = ['name', 'desc', 'cmt', 'type'] as const;

/**
 * GPX 1.0/1.1 → features: tracks (`trk`, one LineString per track, or a
 * MultiLineString when it has several segments), routes (`rte`) and
 * waypoints (`wpt`) — points last so they draw on top of the lines.
 */
export function gpxToGeoJson(root: GeoElement): ParsedGeo {
  if (nameOf(root) !== 'gpx') throw new GeoParseError(`not a GPX file: the root element is <${rawName(root)}>`);
  const ctx: Ctx = { skipped: 0, outOfRange: false };
  const features: GeoFeature[] = [];

  for (const trk of kids(root, 'trk')) {
    const segs = kids(trk, 'trkseg').map((s) => kids(s, 'trkpt'));
    const props = textProps(trk, GPX_TEXT);
    // A track has no time of its own: its first timed point is when it started.
    const time = firstTime(segs);
    if (time) props.time = time;
    const lines = segs.map((pts) => gpxPoints(pts, ctx)).filter((l) => l.length >= 2);
    if (!lines.length) continue;
    features.push({
      type: 'Feature',
      geometry: lines.length === 1 ? line(lines[0]) : { type: 'MultiLineString', coordinates: lines },
      properties: props,
    });
  }

  for (const rte of kids(root, 'rte')) {
    const pts = gpxPoints(kids(rte, 'rtept'), ctx);
    if (pts.length >= 2) features.push({ type: 'Feature', geometry: line(pts), properties: textProps(rte, GPX_TEXT) });
  }

  for (const wpt of kids(root, 'wpt')) {
    const p = gpxPoint(wpt);
    if (!p) { ctx.skipped++; continue; }
    const props = textProps(wpt, [...GPX_TEXT, 'sym']);
    if (p.length > 2) props.ele = p[2];
    const time = kidText(wpt, 'time');
    if (time) props.time = time;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: props });
  }

  return { collection: { type: 'FeatureCollection', features }, skipped: ctx.skipped };
}

// KML ────────────────────────────────────────────────────────────────────────

/**
 * A KML `<coordinates>` body: `lon,lat[,alt]` tuples separated by whitespace.
 * Writers in the wild put spaces after the commas too. `null` = malformed.
 */
export function parseKmlCoordinates(text: string | null | undefined): Position[] | null {
  const tuples = (text ?? '').trim().replace(/\s*,\s*/g, ',').split(/\s+/).filter(Boolean);
  const out: Position[] = [];
  for (const t of tuples) {
    const [lon, lat, alt] = t.split(',').map(num);
    if (!validLonLat(lon, lat)) return null;
    out.push(Number.isFinite(alt) ? [lon, lat, alt] : [lon, lat]);
  }
  return out;
}

/** GeoJSON rings are closed; KML writers sometimes forget. */
function closeRing(ring: Position[]): Position[] {
  const [a, z] = [ring[0], ring[ring.length - 1]];
  return a[0] === z[0] && a[1] === z[1] ? ring : [...ring, a];
}

function kmlRing(el: GeoElement | undefined): Position[] | null {
  const ring = el && parseKmlCoordinates(kid(el, 'coordinates')?.textContent);
  return ring && ring.length >= 3 ? closeRing(ring) : null;
}

function kmlTrack(el: GeoElement): Position[] | null {
  const out: Position[] = [];
  for (const c of kids(el, 'coord')) {
    // gx:coord separates with SPACES: "lon lat alt".
    const [lon, lat, alt] = (c.textContent ?? '').trim().split(/\s+/).map(num);
    if (!validLonLat(lon, lat)) return null;
    out.push(Number.isFinite(alt) ? [lon, lat, alt] : [lon, lat]);
  }
  return out.length >= 2 ? out : null;
}

const KML_GEOMETRIES = new Set(['point', 'linestring', 'linearring', 'polygon', 'multigeometry', 'track', 'multitrack']);

/** `null` = malformed or empty; a Placemark with only that is skipped. */
function kmlGeometry(el: GeoElement): GeoGeometry | null {
  switch (nameOf(el)) {
    case 'point': {
      const c = parseKmlCoordinates(kid(el, 'coordinates')?.textContent);
      return c && c.length ? { type: 'Point', coordinates: c[0] } : null;
    }
    case 'linestring': {
      const c = parseKmlCoordinates(kid(el, 'coordinates')?.textContent);
      return c && c.length >= 2 ? line(c) : null;
    }
    case 'linearring': {
      const r = kmlRing(el);
      return r && { type: 'Polygon', coordinates: [r] };
    }
    case 'polygon': {
      const outer = kmlRing(kid(kid(el, 'outerboundaryis') ?? el, 'linearring'));
      if (!outer) return null;
      // One innerBoundaryIs per hole is the schema; several rings in one is common.
      const holes = kids(el, 'innerboundaryis').flatMap((b) => kids(b, 'linearring')).map(kmlRing);
      if (holes.some((h) => !h)) return null;
      return { type: 'Polygon', coordinates: [outer, ...(holes as Position[][])] };
    }
    case 'track': {
      const t = kmlTrack(el);
      return t && line(t);
    }
    case 'multitrack': {
      const lines = kids(el, 'track').map(kmlTrack);
      if (!lines.length || lines.some((l) => !l)) return null;
      return lines.length === 1 ? line(lines[0]!) : { type: 'MultiLineString', coordinates: lines as Position[][] };
    }
    case 'multigeometry': {
      const parts: GeoGeometry[] = [];
      for (const child of kids(el)) {
        if (!KML_GEOMETRIES.has(nameOf(child))) continue;
        const g = kmlGeometry(child);
        if (!g) return null;
        if (g.type === 'GeometryCollection') parts.push(...g.geometries); else parts.push(g);
      }
      if (!parts.length) return null;
      return parts.length === 1 ? parts[0] : { type: 'GeometryCollection', geometries: parts };
    }
    default:
      return null;
  }
}

function kmlProps(pm: GeoElement): GeoProperties {
  const props: GeoProperties = {};
  const ext = kid(pm, 'extendeddata');
  if (ext) {
    for (const d of kids(ext, 'data')) {
      const key = d.getAttribute('name');
      if (key) props[key] = kidText(d, 'value') ?? '';
    }
    for (const sd of kids(ext, 'schemadata')) {
      for (const d of kids(sd, 'simpledata')) {
        const key = d.getAttribute('name');
        if (key) props[key] = d.textContent?.trim() ?? '';
      }
    }
  }
  // The Placemark's own fields win over ExtendedData of the same name.
  Object.assign(props, textProps(pm, ['name', 'description', 'address']));
  const when = kid(pm, 'timestamp');
  const time = when && kidText(when, 'when');
  if (time) props.time = time;
  return props;
}

function placemarks(el: GeoElement, out: GeoElement[]): GeoElement[] {
  for (const c of kids(el)) {
    if (nameOf(c) === 'placemark') out.push(c); else placemarks(c, out);
  }
  return out;
}

/**
 * KML → features: every Placemark at any depth (Document/Folder nesting) with
 * Point, LineString, LinearRing, Polygon (outer + inner boundaries),
 * MultiGeometry or gx:Track/MultiTrack. Styles, overlays and network links
 * are not read.
 */
export function kmlToGeoJson(root: GeoElement): ParsedGeo {
  const rootName = nameOf(root);
  if (!['kml', 'document', 'folder', 'placemark'].includes(rootName)) {
    throw new GeoParseError(`not a KML file: the root element is <${rawName(root)}>`);
  }
  const ctx: Ctx = { skipped: 0, outOfRange: false };
  const features: GeoFeature[] = [];
  const marks = rootName === 'placemark' ? [root] : placemarks(root, []);
  for (const pm of marks) {
    const geoms = kids(pm).filter((c) => KML_GEOMETRIES.has(nameOf(c)));
    if (!geoms.length) continue;
    const parsed = geoms.map(kmlGeometry);
    if (parsed.some((g) => !g)) { ctx.skipped++; continue; }
    const geometry = parsed.length === 1 ? parsed[0]! : { type: 'GeometryCollection' as const, geometries: parsed as GeoGeometry[] };
    features.push({ type: 'Feature', geometry, properties: kmlProps(pm) });
  }
  return { collection: { type: 'FeatureCollection', features }, skipped: ctx.skipped };
}

// ── Measures ────────────────────────────────────────────────────────────────

/** IUGG mean Earth radius. */
const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres between two [lon, lat] positions. */
export function haversineMeters(a: Position, b: Position): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Length of a polyline in metres (elevation ignored, as every map app does). */
export function lineLengthMeters(coords: readonly Position[]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversineMeters(coords[i - 1], coords[i]);
  return m;
}

export type GeoStats = { points: number; lines: number; polygons: number; lengthM: number };

function addStats(g: GeoGeometry, s: GeoStats): void {
  switch (g.type) {
    case 'Point': s.points++; break;
    case 'MultiPoint': s.points += g.coordinates.length; break;
    case 'LineString': s.lines++; s.lengthM += lineLengthMeters(g.coordinates); break;
    case 'MultiLineString':
      s.lines++;
      for (const l of g.coordinates) s.lengthM += lineLengthMeters(l);
      break;
    case 'Polygon': case 'MultiPolygon': s.polygons++; break;
    case 'GeometryCollection': for (const c of g.geometries) addStats(c, s); break;
  }
}

/** A multi-part geometry counts once: a track with three segments is one track. */
export function geoStats(fc: GeoFeatureCollection): GeoStats {
  const s: GeoStats = { points: 0, lines: 0, polygons: 0, lengthM: 0 };
  for (const f of fc.features) addStats(f.geometry, s);
  return s;
}

export function geometryLengthMeters(g: GeoGeometry): number {
  const s: GeoStats = { points: 0, lines: 0, polygons: 0, lengthM: 0 };
  addStats(g, s);
  return s.lengthM;
}

/** `850 m`, `12.4 km`, `1,204 km`. */
export function formatDistance(m: number): string {
  // Thresholds sit where ROUNDING crosses over: never "1000 m" or "100.0 km".
  if (m < 999.5) return `${Math.round(m)} m`;
  const km = m / 1000;
  return km < 99.95 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString('en-US')} km`;
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** The toolbar's note: `3 tracks · 41 points · 12.4 km`. Empty for nothing. */
export function geoSummary(s: GeoStats, format: GeoFormat): string {
  const parts: string[] = [];
  if (s.lines) parts.push(format === 'gpx' ? count(s.lines, 'track', 'tracks') : count(s.lines, 'line', 'lines'));
  if (s.polygons) parts.push(count(s.polygons, 'polygon', 'polygons'));
  if (s.points) parts.push(count(s.points, 'point', 'points'));
  if (s.lengthM > 0) parts.push(formatDistance(s.lengthM));
  return parts.join(' · ');
}

export type GeoBounds = { west: number; south: number; east: number; north: number };

function eachPosition(g: GeoGeometry, fn: (p: Position) => void): void {
  switch (g.type) {
    case 'Point': fn(g.coordinates); break;
    case 'MultiPoint': case 'LineString': g.coordinates.forEach(fn); break;
    case 'MultiLineString': case 'Polygon': for (const l of g.coordinates) l.forEach(fn); break;
    case 'MultiPolygon': for (const p of g.coordinates) for (const l of p) l.forEach(fn); break;
    case 'GeometryCollection': for (const c of g.geometries) eachPosition(c, fn); break;
  }
}

/** `null` when there is nothing to frame. */
export function geoBounds(fc: GeoFeatureCollection): GeoBounds | null {
  let b: GeoBounds | null = null;
  for (const f of fc.features) {
    eachPosition(f.geometry, ([lon, lat]) => {
      if (!b) { b = { west: lon, south: lat, east: lon, north: lat }; return; }
      if (lon < b.west) b.west = lon;
      if (lon > b.east) b.east = lon;
      if (lat < b.south) b.south = lat;
      if (lat > b.north) b.north = lat;
    });
  }
  return b;
}

/** ~100 m: a single point (or a tiny edit) still has a size to compare. */
const MIN_SPAN = 0.001;

/**
 * Does new data warrant a refit? The file re-renders on every save or change
 * on disk, and the reader's pan/zoom must survive that — so only a first
 * frame, data that moved away from where the map was last fitted, or data
 * that grew/shrank by more than 4× reframes the map.
 */
export function boundsMoved(fitted: GeoBounds | null, next: GeoBounds | null): boolean {
  if (!next) return false;
  if (!fitted) return true;
  const span = (b: GeoBounds) => Math.max(b.north - b.south, b.east - b.west, MIN_SPAN);
  const [ps, ns] = [span(fitted), span(next)];
  if (ns > ps * 4 || ns < ps / 4) return true;
  const pad = ps / 2;
  return next.west > fitted.east + pad || next.east < fitted.west - pad
    || next.south > fitted.north + pad || next.north < fitted.south - pad;
}

// ── Popups ──────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * KML descriptions (and many GeoJSON properties) are HTML. The popup shows
 * TEXT only — the file is untrusted — so markup is reduced to its words:
 * block ends become line breaks, entities are decoded in ONE pass.
 */
export function plainText(s: string): string {
  if (!/<\/?[a-z][^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(s)) return s;
  return s
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:br\b[^>]*|\/(?:p|div|li|tr|h[1-6]))\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MAX_ROWS = 40;
const MAX_VALUE = 1200;

function clip(s: string): string {
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
}

function displayValue(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return clip(plainText(v));
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return clip(JSON.stringify(v)); } catch { return null; }
}

const TITLE_KEYS = ['name', 'title', 'Name', 'NAME', 'Title'];
const KIND_LABEL: Record<GeoGeometry['type'], string> = {
  Point: 'Point', MultiPoint: 'Points', LineString: 'Line', MultiLineString: 'Line',
  Polygon: 'Polygon', MultiPolygon: 'Polygons', GeometryCollection: 'Feature',
};

export type PopupModel = {
  title: string;
  /** The file's own properties, as text. */
  rows: [string, string][];
  /** Rows beyond MAX_ROWS, not shown. */
  more: number;
  /** Computed from the geometry (length, coordinates), shown apart. */
  facts: [string, string][];
};

/** What a feature's popup lists — strings only, the viewer sets them as textContent. */
export function popupModel(f: GeoFeature): PopupModel {
  const props = f.properties ?? {};
  const titleKey = TITLE_KEYS.find((k) => typeof props[k] === 'string' && (props[k] as string).trim()
    || typeof props[k] === 'number');
  const title = titleKey ? clip(plainText(String(props[titleKey]))) : KIND_LABEL[f.geometry.type];
  const rows: [string, string][] = [];
  let more = 0;
  for (const [k, v] of Object.entries(props)) {
    if (k === titleKey) continue;
    const text = displayValue(v);
    if (text == null) continue;
    if (rows.length < MAX_ROWS) rows.push([k, text]); else more++;
  }
  const facts: [string, string][] = [];
  const g = f.geometry;
  if (g.type === 'Point') {
    const [lon, lat] = g.coordinates;
    facts.push(['coordinates', `${lat.toFixed(5)}, ${lon.toFixed(5)}`]);
  } else {
    const m = geometryLengthMeters(g);
    if (m > 0) facts.push(['length', formatDistance(m)]);
  }
  return { title, rows, more, facts };
}
