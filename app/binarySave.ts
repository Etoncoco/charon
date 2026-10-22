'use client';
import { api } from '@/lib/api';
import { FS_UPLOAD_CHUNK_BYTES } from '@/lib/fsUpload';

export type BinarySave =
  | { ok: true; version: string | null }
  | { ok: false; reason: 'stale' | 'error'; error: string };

/**
 * Write a binary file back (a workbook edited in its viewer, §14.112).
 *
 * fs_write is text-only, so the bytes ride the explorer's upload channel with
 * `overwrite` — a temporary file renamed over the target, never a half
 * written one (§14.82). That channel has no sha precondition, so the version
 * read when the file was opened is checked first: if an agent rewrote it
 * meanwhile, the save refuses (`stale`) instead of discarding their work
 * (§14.79's rule, as close as an upload can get).
 */
export async function saveBytes(
  vpsId: string, root: string, path: string, bytes: Uint8Array, expectedVersion: string | null,
): Promise<BinarySave> {
  try {
    if (expectedVersion) {
      const st = await api.statFsFile(vpsId, root, path);
      if (st.ok && st.exists !== false && st.version && st.version !== expectedVersion) {
        return { ok: false, reason: 'stale', error: 'the file changed on the VPS since it was opened' };
      }
    }
    const begun = await api.fsUpload(vpsId, { op: 'begin', root, path, size: bytes.length, overwrite: true });
    if (!begun.ok) return { ok: false, reason: 'error', error: begun.error ?? 'could not start the write' };
    if (!begun.done) {
      if (!begun.uploadId) return { ok: false, reason: 'error', error: 'the hub returned no upload id' };
      let offset = 0;
      let last = begun;
      while (offset < bytes.length) {
        const chunk = bytes.subarray(offset, offset + FS_UPLOAD_CHUNK_BYTES);
        last = await api.fsUploadChunk(vpsId, begun.uploadId, offset, new Blob([chunk as BlobPart]));
        if (!last.ok) return { ok: false, reason: 'error', error: last.error ?? 'the write failed' };
        offset += chunk.length;
      }
      if (!last.done) return { ok: false, reason: 'error', error: 'the VPS did not confirm the write' };
    }
    const after = await api.statFsFile(vpsId, root, path);
    return { ok: true, version: after.ok ? after.version ?? null : null };
  } catch (e: unknown) {
    return { ok: false, reason: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}
