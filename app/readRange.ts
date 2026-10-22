'use client';
import { api } from '@/lib/api';
import { fromBase64 } from './byteText';

export type RangeRead = { bytes: Uint8Array; size: number; offset: number };

/**
 * `length` bytes of a file from `offset` (negative = from the end), §14.112.
 * The agent's range RPC first (one request on the persistent channel); an
 * agent older than 0.108.0 answers `unsupported`, and then HTTP Range on the
 * byte route does the same job — one SSH stream per read, fine for a view
 * that is opened, not one that polls.
 */
export async function readRange(
  vpsId: string, root: string, path: string, offset: number, length: number,
): Promise<RangeRead> {
  const r = await api.fsReadRange(vpsId, root, path, offset, length);
  if (r.ok && r.data != null) {
    return { bytes: fromBase64(r.data), size: r.size ?? 0, offset: r.offset ?? 0 };
  }
  if (r.reason !== 'unsupported') throw new Error(r.error ?? 'could not read this file');
  const range = offset < 0 ? `bytes=${offset}` : `bytes=${offset}-${offset + Math.max(0, length - 1)}`;
  const res = await fetch(api.fsFileUrl(vpsId, root, path), { headers: { range }, credentials: 'same-origin' });
  const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
  if (res.status === 416) return { bytes: new Uint8Array(0), size: Number(total?.[1] ?? 0), offset: Number(total?.[1] ?? 0) };
  if (!res.ok) throw new Error(`could not read this file (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (res.status === 206) {
    const start = Number(/bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')?.[1] ?? 0);
    return { bytes, size: Number(total?.[1] ?? bytes.length), offset: start };
  }
  // A whole-file answer (no Range support): cut the window locally.
  const size = bytes.length;
  const start = offset < 0 ? Math.max(0, size + offset) : Math.min(offset, size);
  return { bytes: bytes.subarray(start, Math.min(size, start + Math.abs(length || size))), size, offset: start };
}
