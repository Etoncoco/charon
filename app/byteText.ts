// Bytes → what the log and hex views show (§14.112). PLAIN module, zero
// imports: pure functions the views and vitest share.

/** base64 → bytes (the agent's range and archive answers). */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Terminal colour/cursor sequences out: a log shows the text, not the escapes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * A chunk read from the MIDDLE of a file starts mid-line (and maybe mid-UTF-8
 * character): drop everything up to the first newline. Returns the text and
 * how many bytes were dropped, so the next earlier read ends exactly there.
 */
export function cutToLineStart(bytes: Uint8Array): { bytes: Uint8Array; dropped: number } {
  const nl = bytes.indexOf(0x0a);
  if (nl < 0) return { bytes: new Uint8Array(0), dropped: bytes.length };
  return { bytes: bytes.subarray(nl + 1), dropped: nl + 1 };
}

/** Lines containing `query` (case-insensitive), with their count. */
export function filterLines(text: string, query: string): { text: string; count: number } {
  const q = query.trim().toLowerCase();
  if (!q) return { text, count: -1 };
  const kept = text.split('\n').filter((l) => l.toLowerCase().includes(q));
  return { text: kept.join('\n'), count: kept.length };
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** `00000010  48 65 6c 6c 6f 20 77 6f  72 6c 64 0a 00 01 02 03  |Hello world.....|` */
export function hexDump(bytes: Uint8Array, baseOffset = 0): string {
  const rows: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const row = bytes.subarray(at, at + 16);
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      if (i === 8) hex += ' ';
      if (i < row.length) {
        const b = row[i];
        hex += `${HEX[b]} `;
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      } else {
        hex += '   ';
      }
    }
    rows.push(`${(baseOffset + at).toString(16).padStart(8, '0')}  ${hex} |${ascii}|`);
  }
  return rows.join('\n');
}

// Leading bytes → what the file most likely is. Enough to answer "what is
// this binary" for the formats an agent leaves lying around.
const MAGIC: Array<[number[] | string, string, number?]> = [
  ['\x7fELF', 'ELF executable / shared object'],
  ['MZ', 'Windows/DOS executable'],
  [[0xcf, 0xfa, 0xed, 0xfe], 'Mach-O binary'],
  [[0xca, 0xfe, 0xba, 0xbe], 'Java class / Mach-O fat binary'],
  ['\x00asm', 'WebAssembly module'],
  ['%PDF', 'PDF document'],
  [[0x89, 0x50, 0x4e, 0x47], 'PNG image'],
  [[0xff, 0xd8, 0xff], 'JPEG image'],
  ['GIF8', 'GIF image'],
  ['PK\x03\x04', 'ZIP archive (or docx/xlsx/jar…)'],
  [[0x1f, 0x8b], 'gzip data'],
  ['BZh', 'bzip2 data'],
  [[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], 'xz data'],
  [[0x28, 0xb5, 0x2f, 0xfd], 'zstd data'],
  ['7z\xbc\xaf\x27\x1c', '7-Zip archive'],
  ['Rar!', 'RAR archive'],
  ['SQLite format 3\x00', 'SQLite database'],
  ['ustar', 'tar archive', 257],
  ['RIFF', 'RIFF container (WAV/AVI/WebP)'],
  ['OggS', 'Ogg media'],
  ['fLaC', 'FLAC audio'],
  ['ID3', 'MP3 audio'],
  [[0x1a, 0x45, 0xdf, 0xa3], 'Matroska/WebM video'],
  ['ftyp', 'MP4/QuickTime media', 4],
  ['wOFF', 'WOFF font'],
  ['wOF2', 'WOFF2 font'],
  [[0x00, 0x01, 0x00, 0x00], 'TrueType font'],
  ['OTTO', 'OpenType font'],
  ['glTF', 'glTF binary model'],
  [[0x50, 0x41, 0x52, 0x31], 'Parquet file'],
  ['ARROW1', 'Arrow file'],
  [[0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59], 'NumPy array'],
  [[0x80, 0x04, 0x95], 'Python pickle'],
  ['\x89HDF', 'HDF5 data'],
];

export function sniffMagic(bytes: Uint8Array): string | null {
  for (const [sig, label, at = 0] of MAGIC) {
    const want = typeof sig === 'string' ? [...sig].map((c) => c.charCodeAt(0)) : sig;
    if (bytes.length < at + want.length) continue;
    if (want.every((b, i) => bytes[at + i] === b)) return label;
  }
  return null;
}

/** Looks like text: no NUL in the first 8 KB and decodes as UTF-8. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, lastCompleteUtf8(head)));
    return true;
  } catch {
    return false;
  }
}

/** Length of `bytes` up to the end of its last COMPLETE UTF-8 character. */
function lastCompleteUtf8(bytes: Uint8Array): number {
  let i = bytes.length;
  // Step back over continuation bytes (10xxxxxx) to the last lead byte.
  let back = 0;
  while (back < 4 && i - back - 1 >= 0 && (bytes[i - back - 1] & 0xc0) === 0x80) back++;
  const leadAt = i - back - 1;
  if (leadAt < 0) return i;
  const lead = bytes[leadAt];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return back + 1 < need ? leadAt : i;
}

