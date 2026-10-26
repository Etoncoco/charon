/**
 * What a repo's web URL is, for a tooltip and a button: `owner/repo` and the
 * forge's name. The URL itself was rebuilt hub-side from a validated host +
 * path (`webUrlFromRemote`, §14.76), so this only reads it, never builds one.
 */
const FORGES: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
  'codeberg.org': 'Codeberg',
};

export type Forge = { url: string; name: string; host: string; label: string; github: boolean };

export function forgeOf(url: string | null | undefined): Forge | null {
  if (!url) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  const name = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (!name) return null;
  return { url, name, host, label: FORGES[host] ?? host, github: host === 'github.com' };
}
