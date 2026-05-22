/**
 * Throws an AbortError immediately if the signal is already aborted.
 * No-op when signal is undefined.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

/**
 * Runs `fn` but rejects with AbortError as soon as `signal` aborts.
 * The abort listener is always removed when `fn` settles, abort fires,
 * or this function rejects — no leaked listeners.
 */
export function withAbort<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!signal) {
    return fn();
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal.reason));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    fn().then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/**
 * Creates a Node-style AbortError ({@link Error} with `name: "AbortError"` and
 * `code: "ABORT_ERR"`). Non-string `reason` is attached as `cause`.
 */
export function createAbortError(reason?: unknown): Error {
  const message = typeof reason === "string" && reason ? reason : "Aborted";
  const err = new Error(message) as Error & { code?: string; cause?: unknown };
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  if (reason !== undefined && typeof reason !== "string") {
    err.cause = reason;
  }

  return err;
}
