/**
 * Ordered, failure-tolerant teardown for a full revoke.
 *
 * A revoke must always finish its local part (write `lan`, delete the persisted
 * host token) even when closing the tunnel or the LAN-direct listener fails, and
 * the hub call must be bounded so the panel's RPC never hangs on a slow hub.
 * Keeping that ordering here makes the semantics unit-testable without a tunnel
 * or a hub.
 * @module
 */

/** The steps a full revoke performs, in order. */
export interface RevokeSteps {
  /** Close the join tunnel. A failure must not block the local revoke. */
  stopTunnel(): Promise<void>;
  /** Stop the LAN-direct listener (best effort). */
  stopDirect(): Promise<void>;
  /** Persist the profile as `lan`, with no hub binding. */
  saveLan(): Promise<void>;
  /** Delete the persisted host token of the hub being left. */
  clearToken(): void;
  /** Ask the hub to revoke this host. */
  selfRevoke(): Promise<void>;
  /** Upper bound for the hub call, in milliseconds. */
  hubTimeoutMs: number;
}

/** Why a revoke finished partially; an absent field means that step succeeded. */
export interface RevokeOutcome {
  /** Closing the tunnel or the direct listener failed; the local revoke still completed. */
  teardownError?: string;
  /** The hub call failed or timed out; the local revoke still completed. */
  hubError?: string;
}

/** Render an unknown thrown value as a message. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a revoke's steps, containing the failures that must not stop the local part.
 * @param steps - the ordered steps and the hub timeout.
 * @returns the failures that occurred, if any.
 */
export async function performRevoke(steps: RevokeSteps): Promise<RevokeOutcome> {
  const outcome: RevokeOutcome = {};
  try {
    await steps.stopTunnel();
  } catch (error) {
    outcome.teardownError = message(error);
  }
  try {
    await steps.stopDirect();
  } catch (error) {
    outcome.teardownError ??= message(error);
  }
  // A failed `saveLan` rejects: leaving `join + token` is the safe state when the
  // local binding cannot be rewritten, so the caller surfaces `revoke-failed`.
  await steps.saveLan();
  steps.clearToken();
  try {
    await withTimeout(steps.selfRevoke(), steps.hubTimeoutMs);
  } catch (error) {
    outcome.hubError = message(error);
  }
  return outcome;
}

/**
 * Await `work` for at most `ms`.
 * `Promise.race` keeps both branches handled, so a late rejection of `work`
 * cannot surface as an unhandled rejection that DSH reports as a fatal load
 * failure.
 *
 * The timer is deliberately kept ref'd: an unref'd timer lets the event loop
 * drain first when nothing else is pending, so the bound would never fire and
 * node:test reports the pending revoke as cancelled instead of failed.
 * @param work - the promise to bound.
 * @param ms - the upper bound in milliseconds.
 */
async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
