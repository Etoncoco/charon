import { describe, expect, it } from 'vitest';
import {
  FileFetchError, MODEL_BASE, describeModelError, fitDistance, formatBytes, formatCount, formatDims,
  formatModelStats, gltfExtensions, gltfUnsupported, gridSpec, isInlineImage, mixRgb, modelAbsPath,
  modelFormat, needsMeshopt, niceStep, parseCssColor, plyFaceCount, pointSize, readFileBytes,
  resolveModelUri,
} from '../app/modelViewerHelpers';

// §14.112: the 3D model pane's pure helpers.

const enc = (s: string) => new TextEncoder().encode(s);

function glb(json: object): ArrayBuffer {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const body = enc(text);
  const out = new Uint8Array(20 + body.length);
  const v = new DataView(out.buffer);
  out.set(enc('glTF'), 0);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, body.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(body, 20);
  return out.buffer;
}

describe('which files the model pane reads', () => {
  it('goes by extension, any case', () => {
    expect(modelFormat('robot.GLB')).toBe('glb');
    expect(modelFormat('scene.gltf')).toBe('gltf');
    expect(modelFormat('part.v2.stl')).toBe('stl');
    expect(modelFormat('mesh.obj')).toBe('obj');
    expect(modelFormat('scan.ply')).toBe('ply');
    expect(modelFormat('notes.txt')).toBeNull();
    expect(modelFormat('stl')).toBeNull();
  });
});

describe('glTF side files resolve next to the model', () => {
  const model = modelAbsPath('/srv/app/', 'assets/car/car.gltf');

  it('builds the absolute model path from the tab root', () => {
    expect(model).toBe('/srv/app/assets/car/car.gltf');
  });

  it('resolves relative, ./ and ../ uris against the model folder', () => {
    expect(resolveModelUri(model, 'scene.bin')).toBe('/srv/app/assets/car/scene.bin');
    expect(resolveModelUri(model, './textures/paint.png')).toBe('/srv/app/assets/car/textures/paint.png');
    expect(resolveModelUri(model, '../shared/wheel.bin')).toBe('/srv/app/assets/shared/wheel.bin');
  });

  it('decodes percent-encoding and drops query and fragment', () => {
    expect(resolveModelUri(model, 'my%20texture.png?v=2#x')).toBe('/srv/app/assets/car/my texture.png');
  });

  it('reads Windows separators', () => {
    expect(resolveModelUri(model, 'textures\\paint.png')).toBe('/srv/app/assets/car/textures/paint.png');
  });

  it('leaves non-files alone', () => {
    expect(resolveModelUri(model, 'https://cdn.example.com/a.png')).toBeNull();
    expect(resolveModelUri(model, 'data:application/octet-stream;base64,AAAA')).toBeNull();
    expect(resolveModelUri(model, '')).toBeNull();
    expect(resolveModelUri(model, 'bad%zz.png')).toBeNull();
  });

  it('is what a loader-prefixed request strips back to', () => {
    const asked = `${MODEL_BASE}textures/a.png`;
    expect(resolveModelUri(model, asked.slice(MODEL_BASE.length))).toBe('/srv/app/assets/car/textures/a.png');
  });

  it('asks for images inline, everything else raw', () => {
    expect(isInlineImage('/a/b.PNG')).toBe(true);
    expect(isInlineImage('/a/b.jpeg')).toBe(true);
    expect(isInlineImage('/a/scene.bin')).toBe(false);
    expect(isInlineImage('/a/tex.ktx2')).toBe(false);
  });
});

describe('glTF extensions are read before the loader runs', () => {
  it('reads a GLB JSON chunk and a .gltf text', () => {
    const ext = { extensionsUsed: ['EXT_meshopt_compression', 'KHR_materials_unlit'], extensionsRequired: ['EXT_meshopt_compression'] };
    expect(gltfExtensions(glb({ asset: { version: '2.0' }, ...ext }))).toEqual({
      used: ext.extensionsUsed, required: ext.extensionsRequired,
    });
    expect(gltfExtensions(enc(JSON.stringify({ asset: { version: '2.0' } })).buffer)).toEqual({ used: [], required: [] });
    expect(gltfExtensions(enc('not json').buffer)).toBeNull();
  });

  it('turns Draco and required KTX2 into a sentence, fetches meshopt only when used', () => {
    expect(gltfUnsupported({ used: ['KHR_draco_mesh_compression'], required: [] })).toMatch(/Draco/);
    expect(gltfUnsupported({ used: ['KHR_texture_basisu'], required: ['KHR_texture_basisu'] })).toMatch(/KTX2/);
    expect(gltfUnsupported({ used: ['KHR_texture_basisu'], required: [] })).toBeNull();
    expect(gltfUnsupported(null)).toBeNull();
    expect(needsMeshopt({ used: ['EXT_meshopt_compression'], required: [] })).toBe(true);
    expect(needsMeshopt({ used: ['KHR_meshopt_compression'], required: [] })).toBe(true);
    expect(needsMeshopt({ used: [], required: [] })).toBe(false);
  });
});

describe('PLY faces decide mesh vs point cloud', () => {
  const header = (body: string) => enc(`ply\nformat binary_little_endian 1.0\n${body}end_header\n\x00\x01`);
  it('counts declared faces', () => {
    expect(plyFaceCount(header('element vertex 8\nproperty float x\nelement face 12\nproperty list uchar int vertex_indices\n'))).toBe(12);
    expect(plyFaceCount(header('element vertex 8\nproperty float x\n'))).toBe(0);
    expect(plyFaceCount(header('element vertex 8\nelement face 0\n'))).toBe(0);
  });
  it('is null for something that is not a PLY header', () => {
    expect(plyFaceCount(enc('solid cube\nfacet'))).toBeNull();
    expect(plyFaceCount(enc('ply\nformat ascii 1.0\n'))).toBeNull();
  });
});

describe('camera and grid maths', () => {
  it('fits the sphere in the tighter field of view', () => {
    const wide = fitDistance(1, 40, 2, 1);
    expect(wide * Math.sin((20 * Math.PI) / 180)).toBeCloseTo(1, 9);
    // A tall pane: the horizontal angle is the limit, so it backs off further.
    const tall = fitDistance(1, 40, 0.5, 1);
    const h = 2 * Math.atan(Math.tan((20 * Math.PI) / 180) * 0.5);
    expect(tall * Math.sin(h / 2)).toBeCloseTo(1, 9);
    expect(tall).toBeGreaterThan(wide);
    expect(fitDistance(2, 40, 1)).toBeCloseTo(2 * fitDistance(1, 40, 1), 9);
  });

  it('rounds steps to 1/2/5 × 10ⁿ', () => {
    expect(niceStep(0.16)).toBeCloseTo(0.2, 12);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(100)).toBe(100);
    expect(niceStep(0)).toBe(1);
  });

  it('sizes the grid past the footprint, in round even cells', () => {
    for (const extent of [0.003, 1, 7.5, 42, 1234]) {
      const g = gridSpec(extent);
      expect(g.size).toBeGreaterThanOrEqual(extent * 1.6 - 1e-9);
      expect(g.divisions % 2).toBe(0);
      expect(g.size).toBeCloseTo(g.step * g.divisions, 9);
      expect(g.divisions).toBeLessThanOrEqual(12);
    }
    expect(gridSpec(1)).toEqual({ size: expect.closeTo(1.6, 9), divisions: 8, step: expect.closeTo(0.2, 12) });
  });

  it('keeps point clouds between dust and blobs', () => {
    expect(pointSize(1, 1e9)).toBeCloseTo(1 / 2000, 9);
    // ~ the mean spacing of a million points on the unit sphere, ×1.2.
    expect(pointSize(1, 1_000_000)).toBeCloseTo(Math.sqrt((4 * Math.PI) / 1e6) * 1.2, 9);
    expect(pointSize(1, 3)).toBeCloseTo(1 / 40, 9);
    const mid = pointSize(1, 200_000);
    expect(mid).toBeGreaterThan(1 / 2000);
    expect(mid).toBeLessThan(1 / 40);
  });
});

describe('theme tokens become WebGL colours', () => {
  it('parses the forms a computed token takes', () => {
    expect(parseCssColor('#ffffff')).toEqual([1, 1, 1]);
    expect(parseCssColor(' #000 ')).toEqual([0, 0, 0]);
    expect(parseCssColor('#11131a')).toEqual([0x11 / 255, 0x13 / 255, 0x1a / 255]);
    expect(parseCssColor('#ff000080')).toEqual([1, 0, 0]);
    expect(parseCssColor('rgb(255, 0, 51)')).toEqual([1, 0, 0.2]);
    expect(parseCssColor('rgba(0 128 255 / 0.5)')).toEqual([0, 128 / 255, 1]);
    expect(parseCssColor('color(srgb 0.25 0.5 1)')).toEqual([0.25, 0.5, 1]);
    expect(parseCssColor('var(--bg)')).toBeNull();
    expect(parseCssColor('')).toBeNull();
  });

  it('mixes like color-mix(in srgb)', () => {
    expect(mixRgb([1, 1, 1], [0, 0, 0], 0.25)).toEqual([0.25, 0.25, 0.25]);
    expect(mixRgb([1, 0, 0], [0, 0, 1], 1)).toEqual([1, 0, 0]);
  });
});

describe('the toolbar facts', () => {
  it('groups thousands with a narrow no-break space', () => {
    expect(formatCount(12840)).toBe('12 840');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1234567)).toBe('1 234 567');
  });

  it('prints sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
    expect(formatBytes(42 * 1024 * 1024)).toBe('42 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
  });

  it('reads like the spec line', () => {
    expect(formatModelStats({ triangles: 12840, points: 0, meshes: 2, bytes: 3.4 * 1024 * 1024 }))
      .toBe('12 840 triangles · 2 meshes · 3.4 MB');
    expect(formatModelStats({ triangles: 1, points: 0, meshes: 1, bytes: 0 })).toBe('1 triangle · 1 mesh');
    expect(formatModelStats({ triangles: 0, points: 50000, meshes: 0, bytes: 2048 })).toBe('50 000 points · 2.0 KB');
  });

  it('prints dimensions with three significant digits', () => {
    expect(formatDims([42, 10.125, 0.5])).toBe('42 × 10.1 × 0.5');
    expect(formatDims([123456, 0, 0.0001])).toBe('1.23e+5 × 0 × 1.00e-4');
  });
});

describe('reading the file route', () => {
  const bytes = (n: number, headers: Record<string, string> = {}) =>
    new Response(new Uint8Array(n).fill(7), {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(n), ...headers },
    });

  it('returns the bytes and reports progress', async () => {
    const seen: [number, number][] = [];
    const buf = await readFileBytes(bytes(5), (l, t) => seen.push([l, t]));
    expect([...new Uint8Array(buf)]).toEqual([7, 7, 7, 7, 7]);
    expect(seen.at(-1)).toEqual([5, 5]);
  });

  it('treats a 200 JSON envelope as the failure it is', async () => {
    const res = new Response(JSON.stringify({ ok: false, error: 'the agent is not connected' }), {
      headers: { 'content-type': 'application/json' },
    });
    await expect(readFileBytes(res)).rejects.toMatchObject({ name: 'FileFetchError', message: 'the agent is not connected' });
  });

  it('carries the status of an HTTP error', async () => {
    const res = new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
    const err = await readFileBytes(res).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileFetchError);
    expect(err).toMatchObject({ status: 404, message: 'HTTP 404' });
  });

  it('refuses a file over the cap, by header or by count', async () => {
    await expect(readFileBytes(bytes(10), undefined, 8)).rejects.toMatchObject({ status: 413 });
    const unsized = new Response(new Uint8Array(10), { headers: { 'content-type': 'application/octet-stream' } });
    await expect(readFileBytes(unsized, undefined, 8)).rejects.toMatchObject({ status: 413 });
  });
});

describe('error sentences', () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it('explains route, empty and unsupported failures', () => {
    expect(describeModelError(new FileFetchError('file not found', 404), 'stl'))
      .toBe('could not read this file from the VPS: file not found');
    expect(describeModelError(new FileFetchError('the file is too large to open here (600 MB)', 413), 'glb'))
      .toBe('the file is too large to open here (600 MB)');
    expect(describeModelError(named('EmptyModel', 'empty'), 'obj')).toBe('this file contains no geometry to show');
    expect(describeModelError(named('UnsupportedModel', 'why not'), 'gltf')).toBe('why not');
  });

  it('translates three.js loader messages', () => {
    expect(describeModelError(new Error('THREE.GLTFLoader: No DRACOLoader instance provided.'), 'glb')).toMatch(/Draco/);
    expect(describeModelError(new Error('THREE.GLTFLoader: Failed to load buffer "scene.bin".'), 'gltf'))
      .toBe('could not load "scene.bin", a file this model needs next to it');
    expect(describeModelError(new Error('THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are supported.'), 'gltf'))
      .toMatch(/glTF 2\.0/);
    expect(describeModelError(new SyntaxError('Unexpected token o in JSON'), 'gltf')).toBe('this file is not valid glTF');
    expect(describeModelError(new Error('bad header'), 'ply')).toBe('could not read this PLY file: bad header');
    expect(describeModelError(new RangeError('Offset is outside the bounds of the DataView'), 'stl'))
      .toBe('this STL file is truncated or damaged');
  });
});
