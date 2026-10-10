/**
 * Wires OS shutdown signals to an AbortController and returns it, rather
 * than bootstrap() calling process.on inline -- this is the specific
 * thing Sull #11 flagged: if the entrypoint constructs its own
 * AbortController but never actually attaches it to SIGINT/SIGTERM, a
 * process manager's shutdown signal has nothing to abort, and both loops
 * keep running mid-execution until the process is force-killed,
 * abandoning whatever node either loop was in the middle of.
 *
 * Zero-dependency by design (no pg, no other project imports) -- same
 * precedent as sleep.ts, so it's testable without pulling in a real
 * database driver just to test signal wiring.
 */
export function attachShutdownSignals(
  signalNames: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'],
  target: NodeJS.Process = process
): AbortController {
  const controller = new AbortController();
  let alreadySignaled = false;

  for (const name of signalNames) {
    target.on(name, () => {
      if (alreadySignaled) {
        console.error(`[bootstrap] second ${name} received during shutdown -- forcing exit.`);
        target.exit(1);
        return;
      }
      alreadySignaled = true;
      console.error(`[bootstrap] ${name} received -- signalling both loops to stop after their current tick.`);
      controller.abort();
    });
  }

  return controller;
}
