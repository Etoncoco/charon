// A resync's `sync_installs` (§3.3) lists the RUNNING installs at R. A local
// row still `running` that the list omits FINISHED during the gap (its
// `install_finished` frame is gone with it): the hub still holds that finished
// session, so the row is refetched and replaced by its success/error state —
// the install row is a fresh VPS's only sidebar slot and must outlive
// `running` (CLAUDE.md §14.22). Only a 404 (hub restarted: the in-memory
// install is lost) drops it. Listed ids the tab does not know are fetched and
// added. Pure (deps injected) for tests.

export type InstallRow = { id: string; status: string; vpsId: string };

export type InstallResyncDeps<T extends InstallRow> = {
  getInstall: (id: string) => Promise<T>;
  /** Functional update of the installs list. */
  update: (fn: (prev: T[]) => T[]) => void;
  /** A refetched row that finished with success (the live `install_finished`
   *  side effects: the VPS's agent badge). */
  onFinished?: (info: T) => void;
};

/** `GET /api/installs/:id → 404` (lib/api.ts error shape). */
export function isInstallNotFound(err: unknown): boolean {
  return err instanceof Error && /→ 404\b/.test(err.message);
}

export function reconcileInstallsOnResync<T extends InstallRow>(
  current: readonly T[],
  runningIds: readonly string[],
  deps: InstallResyncDeps<T>,
): void {
  const listed = new Set(runningIds);
  const known = new Set(current.map((i) => i.id));
  const finishedInGap = current.filter((i) => i.status === 'running' && !listed.has(i.id)).map((i) => i.id);
  const unknownListed = runningIds.filter((id) => !known.has(id));
  for (const id of [...finishedInGap, ...unknownListed]) {
    const gapRow = !listed.has(id);
    void deps.getInstall(id).then((info) => {
      deps.update((prev) => {
        const i = prev.findIndex((r) => r.id === id);
        if (i < 0) return gapRow ? prev : [...prev, info];
        const next = prev.slice();
        next[i] = info;
        return next;
      });
      if (gapRow && info.status === 'success') deps.onFinished?.(info);
    }).catch((err) => {
      if (!gapRow || !isInstallNotFound(err)) return;
      // Lost with a hub restart: nothing left to show. Only a row still
      // `running` (a live frame may have refreshed it meanwhile).
      deps.update((prev) => {
        const next = prev.filter((r) => !(r.id === id && r.status === 'running'));
        return next.length === prev.length ? prev : next;
      });
    });
  }
}
