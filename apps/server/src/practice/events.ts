// In-process wake-ups for practice_wait: inserts notify a session, waiters re-check the persisted queue until timeout or abort.
import { EventEmitter } from "node:events";

const notifier = new EventEmitter();
notifier.setMaxListeners(0);

// Fallback re-check covers anything the in-process signal can miss (e.g. another server process).
const RECHECK_MS = 5_000;

export function notifyPracticeEvent(sessionId: string): void {
  notifier.emit(sessionId);
}

/**
 * Calls `claim` until it yields a value, sleeping between tries until a notify for
 * `sessionId`, the periodic re-check, the deadline, or `signal` aborts. Returns null on timeout/abort.
 */
export async function waitForClaim<T>(
  sessionId: string,
  timeoutMs: number,
  claim: () => Promise<T | null>,
  signal?: AbortSignal,
  recheckMs = RECHECK_MS,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let woken = false;
  let wake: (() => void) | null = null;
  const onSignal = (): void => {
    woken = true;
    wake?.();
  };
  // Subscribe before the first claim so a notify between claim and sleep is not lost.
  notifier.on(sessionId, onSignal);
  signal?.addEventListener("abort", onSignal);
  try {
    while (!signal?.aborted) {
      woken = false;
      const claimed = await claim();
      if (claimed !== null) return claimed;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted) return null;
      if (woken) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, recheckMs));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
    return null;
  } finally {
    notifier.off(sessionId, onSignal);
    signal?.removeEventListener("abort", onSignal);
  }
}
