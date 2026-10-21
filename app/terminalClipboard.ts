// The shell terminal's clipboard (ShellTerminal.tsx).
//
// Text leaves a terminal two ways:
//   · xterm's OWN selection (a plain drag): Ctrl+C copies it in ShellTerminal's
//     key handler — it is drawn by xterm, not a DOM selection, so the browser
//     has nothing to copy by itself;
//   · a program that owns the mouse (Claude Code, tmux, vim with mouse=a)
//     draws ITS selection and copies through OSC 52
//     (`ESC ] 52 ; c ; <base64> BEL`), the only clipboard a program on the
//     VPS can reach. xterm.js drops that sequence unless a handler takes it.
//
// OSC 52 is honoured for WRITES only (a read would hand the clipboard to any
// program on the VPS), never during a log replay, and only in the visible
// terminal right after the user's own gesture in it: a shell in a background
// tab must not overwrite the clipboard while the user works elsewhere.

/** How long after a key or a click in the terminal its programs may copy. */
export const OSC52_GESTURE_WINDOW_MS = 5_000;
/** ~768 KB of text: bigger is not a copy anyone asked for. */
const OSC52_MAX_BASE64 = 1 << 20;

/** The text an OSC 52 payload (`Pc;Pd`, as xterm's OSC handler receives it)
 *  writes, or null: a query (`?`), an empty or malformed payload. */
export function osc52Text(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep < 0) return null;
  if (!/^[cpqs0-7]*$/.test(data.slice(0, sep))) return null;
  const payload = data.slice(sep + 1).replace(/\s+/g, '');
  if (!payload || payload === '?' || payload.length > OSC52_MAX_BASE64) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}

/** Write `text` to the system clipboard: the async API, else the legacy copy
 *  command (no permission prompt; needs the user's recent gesture). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* not allowed or not focused: the legacy path below */ }
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  try {
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    try { prev?.focus({ preventScroll: true }); } catch {}
  }
}
