/** One absolute deadline shared by a sequence of asynchronous operations. */
export class Deadline {
  readonly #expiresAt: number;

  private constructor(expiresAt: number) {
    this.#expiresAt = expiresAt;
  }

  static after(timeoutMs: number): Deadline {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("Deadline timeout must be a non-negative finite number");
    }
    return new Deadline(Date.now() + timeoutMs);
  }

  static none(): Deadline {
    return new Deadline(Number.POSITIVE_INFINITY);
  }

  get remainingMs(): number {
    return Math.max(0, this.#expiresAt - Date.now());
  }

  async run<T>(description: string, operation: () => PromiseLike<T>): Promise<T> {
    if (this.#expiresAt === Number.POSITIVE_INFINITY) return await operation();
    const remainingMs = this.remainingMs;
    if (remainingMs === 0) throw new Error(`Timed out waiting for ${description}`);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)), remainingMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(operation), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Preserve the operation error and the cleanup error in their observed order. */
export function cleanupFailure(
    operationError: unknown, cleanupError: unknown, message: string): AggregateError {
  return new AggregateError(
      [operationError, cleanupError], message, { cause: cleanupError });
}

/** Run cleanup once and retain both errors when the operation and cleanup fail. */
export async function runWithCleanup<T>(
    operation: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await cleanup();
  } catch (cleanupError) {
    if (!outcome.ok) {
      throw cleanupFailure(
          outcome.error, cleanupError, "Trial failed, and cleanup also failed");
    }
    throw cleanupError;
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
