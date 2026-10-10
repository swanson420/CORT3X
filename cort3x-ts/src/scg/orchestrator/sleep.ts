/** Abort-aware sleep — an aborted signal wakes the caller immediately
 * rather than waiting out the full duration, bounding shutdown latency.
 * Deliberately zero-dependency (no imports) so any loop can use it
 * without transitively pulling in a database driver or anything else --
 * this file exists specifically to remove that coupling from
 * workerLoop.ts/fanInSweepLoop.ts, where it was previously re-exported
 * from workerLoop.ts and dragged its pg dependency along with it. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
