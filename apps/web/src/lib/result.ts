/**
 * The engine refuses rather than approximates: it throws for telecentric pupils,
 * unknown glass, wavelengths outside a glass's fit range, geometry it cannot
 * model, and more. The UI has to render those refusals as messages, so every
 * engine call goes through here instead of being allowed to blank the screen.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function attempt<T>(compute: () => T): Result<T> {
  try {
    return { ok: true, value: compute() };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** The value if the computation succeeded, otherwise `undefined`. */
export function valueOf<T>(result: Result<T>): T | undefined {
  return result.ok ? result.value : undefined;
}

/**
 * Runs the next step only if the previous one succeeded, carrying the first
 * failure through. For edits that are really two edits — changing a mirror back
 * into a refracting surface *and* giving it a glass — so that a rejection
 * anywhere in the chain leaves the design exactly as it was.
 */
export function chain<T, U>(result: Result<T>, next: (value: T) => Result<U>): Result<U> {
  return result.ok ? next(result.value) : result;
}
