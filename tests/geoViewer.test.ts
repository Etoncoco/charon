import { describe, expect, it } from 'vitest';
import {
  boundsMoved, formatDistance, geoBounds, geoFormatOf, geoStats, geoSummary, gpxToGeoJson, haversineMeters,
  kmlToGeoJson, lineLengthMeters, normalizeGeoJson, parseGeoText, parseKmlCoordinates, plainText, popupModel,
  xmlErrorMessage, GeoParseError, type GeoElement, type GeoFeature,
} from '@/app/geoFormats';

// A hand-built stand-in for a DOM Element: the converters read nothing else.
// `tag` may carry a prefix ("kml:Placemark"); `local` mimics a parsed
// namespaced element whose localName is set and tagName is prefixed.
function el(tag: string, attrs: Record<string, string> = {}, ...children: (GeoElement | string)[]): GeoElement {
  const elements = children.filter((c): c is GeoElement => typeof c !== 'string');
  const text = children.map((c) => (typeof c === 'string' ? c : c.textContent ?? '')).join('');
  return {
    tagName: tag,
    textContent: text,
    children: elements,
    getAttribute: (n) => attrs[n] ?? null,
  };
}
function local(prefixed: string, ...children: (GeoElement | string)[]): GeoElement {
  return { ...el(prefixed, {}, ...children), localName: prefixed.split(':').pop() };
}

const noXml = () => { throw new Error('no XML expected'); };

describe('GeoJSON normalisation', () => {
  it('wraps a bare geometry and a single Feature into a FeatureCollection', () => {
    const a = normalizeGeoJson({ type: 'Point', coordinates: [2.35, 48.85, 35] });
    expect(a.collection).toEqual({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [2.35, 48.85, 35] }, properties: {} }],
    });
    const b = normalizeGeoJson({
      type: 'Feature', id: 7, properties: { name: 'x' },
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    });
    expect(b.collection.features).toEqual([{
      type: 'Feature', id: 7, properties: { name: 'x' },
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    }]);
  });

  it('keeps valid features of a collection and counts the malformed ones', () => {
    const r = normalizeGeoJson({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: null, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ['a', 1] } },
        { type: 'Feature', properties: {}, geometry: null }, // unlocated: valid, nothing to draw
        { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }, // bare geometry in features
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0]] } }, // one vertex
        { type: 'Feature', geometry: { type: 'GeometryCollection', geometries: [
          { type: 'Point', coordinates: [5, 5] }, { type: 'LineString', coordinates: [[5, 5], [6, 6]] },
        ] } },
        'nonsense',
      ],
    });
    expect(r.skipped).toBe(3);
    expect(r.collection.features.map((f) => f.geometry.type)).toEqual(['Polygon', 'MultiPoint', 'GeometryCollection']);
    expect(r.collection.features[0].properties).toEqual({});
  });

  it('rejects what is not GeoJSON, with a reason', () => {
    expect(() => normalizeGeoJson(null)).toThrow(GeoParseError);
    expect(() => normalizeGeoJson('x')).toThrow(/not a GeoJSON object/);
    expect(() => normalizeGeoJson({ foo: 1 })).toThrow(/no "type"/);
    expect(() => normalizeGeoJson({ type: 'Topology' })).toThrow(/unknown type "Topology"/);
    expect(() => normalizeGeoJson({ type: 'FeatureCollection', features: 3 })).toThrow(/"features" array/);
    expect(() => normalizeGeoJson({ type: 'Point', coordinates: [1] })).toThrow(/invalid coordinates/);
  });

  it('refuses projected coordinates instead of drawing them off the planet', () => {
    expect(() => normalizeGeoJson({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [261_878, 6_250_000] } }],
    })).toThrow(/projected/);
    expect(() => normalizeGeoJson({
      type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } }, features: [],
    })).toThrow(/EPSG::3857/);
    expect(normalizeGeoJson({
      type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features: [],
    }).collection.features).toEqual([]);
  });

  it('parses text: empty file and broken JSON become readable reasons', () => {
    expect(() => parseGeoText('  \n', 'geojson', noXml)).toThrow('this file is empty');
    expect(() => parseGeoText('{"type": ', 'geojson', noXml)).toThrow(/^not valid JSON: /);
    expect(parseGeoText('{"type":"Point","coordinates":[1,2]}', 'geojson', noXml).collection.features).toHaveLength(1);
  });

  it('routes by extension only', () => {
    expect(['a.geojson', 'B.GPX', 'c.kml', 'd.json', 'e.kmz'].map(geoFormatOf)).toEqual(['geojson', 'gpx', 'kml', null, null]);
  });
});

describe('GPX', () => {
  const pt = (tag: string, lat: string, lon: string, ...kids: GeoElement[]) => el(tag, { lat, lon }, ...kids);

  it('converts tracks, routes and waypoints, points last', () => {
    const gpx = el('gpx', { version: '1.1' },
      pt('wpt', '48.8584', '2.2945', el('name', {}, 'Tower'), el('ele', {}, '330'), el('time', {}, '2024-05-01T10:00:00Z'), el('desc', {}, 'Iron')),
      el('rte', {}, el('name', {}, 'Plan'), pt('rtept', '0', '0'), pt('rtept', '0', '1')),
      el('trk', {},
        el('name', {}, 'Morning'),
        el('trkseg', {},
          pt('trkpt', '0', '0', el('ele', {}, '10'), el('time', {}, '2024-05-01T08:00:00Z')),
          pt('trkpt', '0', '0.01', el('ele', {}, '12'))),
        el('trkseg', {}, pt('trkpt', '1', '1'), pt('trkpt', '1', '1.01'), pt('trkpt', 'bad', '1'))),
      el('trk', {}, el('trkseg', {}, pt('trkpt', '5', '5'))), // one point: nothing to draw
    );
    const r = gpxToGeoJson(gpx);
    expect(r.skipped).toBe(1);
    const [trk, rte, wpt] = r.collection.features;
    expect(r.collection.features).toHaveLength(3);
    expect(trk.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [[[0, 0, 10], [0.01, 0, 12]], [[1, 1], [1.01, 1]]],
    });
    expect(trk.properties).toEqual({ name: 'Morning', time: '2024-05-01T08:00:00Z' });
    expect(rte.geometry).toEqual({ type: 'LineString', coordinates: [[0, 0], [1, 0]] });
    expect(rte.properties).toEqual({ name: 'Plan' });
    expect(wpt.geometry).toEqual({ type: 'Point', coordinates: [2.2945, 48.8584, 330] });
    expect(wpt.properties).toEqual({ name: 'Tower', desc: 'Iron', ele: 330, time: '2024-05-01T10:00:00Z' });
  });

  it('matches namespaced tags on their local name', () => {
    // `local` = a real parsed node (localName set); `pt` = a prefixed tagName only.
    const gpx = local('gpx:gpx', local('gpx:trk', local('gpx:trkseg',
      pt('gpx:trkpt', '10', '20'), pt('GPX:TRKPT', '10.5', '20.5'))));
    const r = gpxToGeoJson(gpx);
    expect(r.collection.features[0].geometry).toEqual({ type: 'LineString', coordinates: [[20, 10], [20.5, 10.5]] });
  });

  it('refuses another XML document', () => {
    expect(() => gpxToGeoJson(el('kml'))).toThrow(/root element is <kml>/);
  });
});

describe('KML', () => {
  it('finds Placemarks at any depth, with prefixed tags', () => {
    const kml = local('kml:kml',
      local('kml:Document',
        local('kml:Folder',
          local('kml:Placemark',
            local('kml:name', 'Camp'),
            local('kml:description', '<b>Tents</b> &amp; fire'),
            local('kml:Point', local('kml:coordinates', ' 6.86,45.83,1035 '))),
          local('kml:Placemark',
            local('kml:name', 'Trail'),
            local('kml:LineString', local('kml:coordinates', '\n  6.86, 45.83\n  6.87,45.84,1100  6.88,45.85\n'))))));
    const r = kmlToGeoJson(kml);
    expect(r.skipped).toBe(0);
    expect(r.collection.features.map((f) => f.geometry)).toEqual([
      { type: 'Point', coordinates: [6.86, 45.83, 1035] },
      { type: 'LineString', coordinates: [[6.86, 45.83], [6.87, 45.84, 1100], [6.88, 45.85]] },
    ]);
    expect(r.collection.features[0].properties).toEqual({ name: 'Camp', description: '<b>Tents</b> &amp; fire' });
  });

  it('reads polygons with holes (closing open rings), MultiGeometry, gx:Track and ExtendedData', () => {
    const kml = el('kml', {}, el('Document', {},
      el('Placemark', {},
        el('ExtendedData', {},
          el('Data', { name: 'owner' }, el('value', {}, 'city')),
          el('SchemaData', {}, el('SimpleData', { name: 'area' }, '42'))),
        el('name', {}, 'Park'),
        el('Polygon', {},
          el('outerBoundaryIs', {}, el('LinearRing', {}, el('coordinates', {}, '0,0 4,0 4,4 0,4 0,0'))),
          el('innerBoundaryIs', {}, el('LinearRing', {}, el('coordinates', {}, '1,1 2,1 2,2'))))),
      el('Placemark', {},
        el('MultiGeometry', {},
          el('Point', {}, el('coordinates', {}, '9,9')),
          el('MultiGeometry', {}, el('LineString', {}, el('coordinates', {}, '9,9 10,10'))))),
      el('Placemark', {},
        el('gx:Track', {}, el('when', {}, '2024'), el('gx:coord', {}, '1 2 3'), el('gx:coord', {}, '1.1 2.1 4'))),
      el('Placemark', {}, el('Point', {}, el('coordinates', {}, 'x,y'))), // malformed
      el('Placemark', {}, el('name', {}, 'no geometry')),
    ));
    const r = kmlToGeoJson(kml);
    expect(r.skipped).toBe(1);
    const [park, multi, track] = r.collection.features;
    expect(park.geometry).toEqual({
      type: 'Polygon',
      coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 1]]],
    });
    expect(park.properties).toEqual({ owner: 'city', area: '42', name: 'Park' });
    expect(multi.geometry).toEqual({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [9, 9] }, { type: 'LineString', coordinates: [[9, 9], [10, 10]] }],
    });
    expect(track.geometry).toEqual({ type: 'LineString', coordinates: [[1, 2, 3], [1.1, 2.1, 4]] });
  });

  it('parses coordinate bodies strictly', () => {
    expect(parseKmlCoordinates('1,2,3\t4,5')).toEqual([[1, 2, 3], [4, 5]]);
    expect(parseKmlCoordinates('1,2,')).toEqual([[1, 2]]);
    expect(parseKmlCoordinates('1,200')).toBeNull();
    expect(parseKmlCoordinates('')).toEqual([]);
  });

  it('refuses another XML document, and pipes through parseGeoText', () => {
    expect(() => kmlToGeoJson(el('gpx'))).toThrow(/not a KML file/);
    const doc = el('kml', {}, el('Placemark', {}, el('Point', {}, el('coordinates', {}, '1,2'))));
    expect(parseGeoText('<kml/>', 'kml', () => doc).collection.features).toHaveLength(1);
    expect(() => parseGeoText('<kml', 'kml', () => { throw new GeoParseError('bad'); })).toThrow('bad');
  });
});

describe('XML errors', () => {
  it('reduces browser parsererror text to one line', () => {
    expect(xmlErrorMessage('This page contains the following errors:error on line 3 at column 7: Opening and ending tag mismatch: trkseg line 2 and trk\nBelow is a rendering of the page up to the first error.'))
      .toBe('not valid XML: Opening and ending tag mismatch: trkseg line 2 and trk (line 3, column 7)');
    expect(xmlErrorMessage('XML Parsing Error: mismatched tag. Expected: </trkseg>.\nLocation: about:blank\nLine Number 3, Column 7:</trk>\n------^'))
      .toBe('not valid XML: mismatched tag. Expected: </trkseg>. (line 3, column 7)');
    expect(xmlErrorMessage('This page contains the following errors:error on line 67 at column 8: Unexpected closing tag: {http://www.topografix.com/GPX/1/1}trk != {http://www.topografix.com/GPX/1/1}trkseg\nBelow is a rendering of the page up to the first error.'))
      .toBe('not valid XML: Unexpected closing tag: trk != trkseg (line 67, column 8)');
    expect(xmlErrorMessage('')).toBe('not valid XML');
  });
});

describe('measures', () => {
  it('haversine: one degree of longitude on the equator, London → Paris', () => {
    expect(haversineMeters([0, 0], [1, 0])).toBeCloseTo(111_195, -1);
    expect(haversineMeters([-0.1278, 51.5074], [2.3522, 48.8566]) / 1000).toBeCloseTo(343.5, 0);
    expect(haversineMeters([10, 10], [10, 10])).toBe(0);
    expect(lineLengthMeters([[0, 0], [1, 0], [2, 0]])).toBeCloseTo(2 * 111_195, -1);
    expect(lineLengthMeters([[0, 0]])).toBe(0);
  });

  it('counts per geometry, sums line lengths, frames the bounds', () => {
    const { collection } = normalizeGeoJson({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 0]], [[0, 1], [0, 2]]] } },
        { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[-3, -1], [5, 4]] } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
      ],
    });
    const s = geoStats(collection);
    expect(s).toMatchObject({ lines: 1, points: 2, polygons: 1 });
    expect(s.lengthM / 1000).toBeCloseTo(222.4, 0);
    expect(geoSummary(s, 'gpx')).toBe('1 track · 1 polygon · 2 points · 222 km');
    expect(geoSummary(s, 'kml')).toBe('1 line · 1 polygon · 2 points · 222 km');
    expect(geoSummary({ lines: 0, polygons: 0, points: 0, lengthM: 0 }, 'kml')).toBe('');
    expect(geoBounds(collection)).toEqual({ west: -3, south: -1, east: 5, north: 4 });
    expect(geoBounds({ type: 'FeatureCollection', features: [] })).toBeNull();
  });

  it('formats distances', () => {
    expect([12.4, 850.2, 12_400, 99_960, 1_204_000].map(formatDistance))
      .toEqual(['12 m', '850 m', '12.4 km', '100 km', '1,204 km']);
    expect(formatDistance(999.7)).toBe('1.0 km');
  });

  it('refits only on a first frame or a drastic change', () => {
    const b = { west: 0, south: 0, east: 1, north: 1 };
    expect(boundsMoved(null, b)).toBe(true);
    expect(boundsMoved(b, null)).toBe(false);
    expect(boundsMoved(b, { west: 0, south: 0, east: 1.1, north: 1 })).toBe(false); // a vertex nudged
    expect(boundsMoved(b, { west: 0.2, south: 0.2, east: 0.8, north: 0.8 })).toBe(false); // trimmed
    expect(boundsMoved(b, { west: 10, south: 10, east: 11, north: 11 })).toBe(true); // elsewhere
    expect(boundsMoved(b, { west: -5, south: -5, east: 5, north: 5 })).toBe(true); // 10× wider
    expect(boundsMoved(b, { west: 0.5, south: 0.5, east: 0.51, north: 0.51 })).toBe(true); // 100× narrower
    const p = { west: 2, south: 48, east: 2, north: 48 };
    expect(boundsMoved(p, { west: 2.0001, south: 48, east: 2.0001, north: 48 })).toBe(false);
    expect(boundsMoved(p, { west: 2.01, south: 48, east: 2.01, north: 48 })).toBe(true);
  });
});

describe('popups', () => {
  it('reduces HTML to text, decoding entities once', () => {
    expect(plainText('<p>Hi&nbsp;<b>there</b></p><script>alert(1)</script>a&amp;lt;b')).toBe('Hi there\na&lt;b');
    expect(plainText('a < b and c > d')).toBe('a < b and c > d');
    expect(plainText('x<br/>y &#x41;&#66;')).toBe('x\ny AB');
  });

  it('titles by name, lists the rest as text, adds geometry facts', () => {
    const line: GeoFeature = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0]] },
      properties: { name: 'Ridge', description: '<i>steep</i>', ele: 1200, open: true, tags: { a: 1 }, empty: '', none: null },
    };
    expect(popupModel(line)).toEqual({
      title: 'Ridge',
      rows: [['description', 'steep'], ['ele', '1200'], ['open', 'true'], ['tags', '{"a":1}']],
      more: 0,
      facts: [['length', '111 km']],
    });
    const point: GeoFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: [2.2945, 48.8584] }, properties: {} };
    expect(popupModel(point)).toEqual({ title: 'Point', rows: [], more: 0, facts: [['coordinates', '48.85840, 2.29450']] });
    const many: GeoFeature = { ...point, properties: Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}`, i])) };
    expect(popupModel(many)).toMatchObject({ more: 5 });
    expect(popupModel(many).rows).toHaveLength(40);
  });
});
