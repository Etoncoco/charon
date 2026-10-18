'use client';
import { offeredSuggestions, type PermissionSuggestion } from '@/lib/permissionSuggestions';
import { supportsSessionCapability, type SessionProvider } from '@/lib/sessionCapabilities';

/**
 * The answer buttons of a permission card, shared by the focused session's
 * card and the cross-session popup so both answer the same way.
 *
 * Claude: one button per "don't ask again" option the CLI itself offered,
 * labelled with its scope, exactly the choices its terminal dialog lists; none
 * when it offered none (its safety checks, for one). Elsewhere: the provider's
 * native session grant (Codex).
 */
export default function PermissionActions({ kind, suggestions, onRespond }: {
  kind: SessionProvider | undefined;
  suggestions?: PermissionSuggestion[];
  onRespond: (allow: boolean, always: boolean, suggestion?: number) => void;
}) {
  const cliOptions = kind != null && supportsSessionCapability(kind, 'permissionSuggestions');
  return (
    <>
      <button type="button" className="allow" onClick={() => onRespond(true, false)}>allow once</button>
      {cliOptions
        ? offeredSuggestions(suggestions).map((o) => (
            <button
              key={o.index} type="button" className="always"
              onClick={() => onRespond(true, false, o.index)}
            >{o.label}</button>
          ))
        : <button type="button" className="always" onClick={() => onRespond(true, true)}>allow always (session)</button>}
      <button type="button" className="deny" onClick={() => onRespond(false, false)}>deny</button>
    </>
  );
}
