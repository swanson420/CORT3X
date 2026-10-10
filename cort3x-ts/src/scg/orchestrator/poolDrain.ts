/**
 * Races pool.end() against a timeout. The critical property: .catch() is
 * attached to the end() promise BEFORE the race, not after -- so if
 * end() rejects, that rejection is captured synchronously in this
 * function's own promise chain no matter which side of the race resolves
 * first. Racing the raw (still-rejectable) promise directly would leave
 * a late rejection -- one that arrives after the timeout already won --
 * with nothing left awaiting it: an unhandled rejection, the same class
 * of bug already fixed once in this codebase (fanInReconciliationSweep's
 * forEach risk). Converting end() into an always-resolves promise before
 * racing it removes the timing dependency entirely rather than relying
 * on catching it "in time."
 *
 * The result carries the underlying error on the 'error' branch rather
 * than only logging it here -- a caller that wants to alert, set a
 * process exit code, or attach this to its own structured shutdown
 * report needs the actual Error object, not just a printed line this
 * function chose to emit. console.error below stays for immediate
 * visibility; it supplements the return value, it doesn't replace it.
 *
 * Zero-dependency (no pg, no other project imports) so this is testable
 * with a fake { end } object, without needing a real Pool.
 */
export type DrainResult =
  | { status: 'drained' }
  | { status: 'timeout' }
  | { status: 'error'; error: unknown };

export async function drainPoolWithTimeout(
  pool: { end: () => Promise<void> },
  timeoutMs: number
): Promise<DrainResult> {
  const endPromise: Promise<DrainResult> = pool
    .end()
    .then((): DrainResult => ({ status: 'drained' }))
    .catch((err): DrainResult => {
      console.error('[bootstrap] pool.end() rejected:', err);
      return { status: 'error', error: err };
    });

  const timeoutPromise = new Promise<DrainResult>((resolve) => {
    setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });

  return Promise.race([endPromise, timeoutPromise]);
}
