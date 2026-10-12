// Minimal dependency-free assertions (no remote std imports: the project runs fully offline).
export class AssertionError extends Error {}

export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg} expected ${e} got ${a}`);
}

export function assertAlmostEquals(actual: number, expected: number, eps = 1e-6, msg = ""): void {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new AssertionError(`${msg} expected ${expected} +- ${eps} got ${actual}`);
  }
}

export function assertThrows(fn: () => unknown, msg = "expected a throw"): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new AssertionError(msg);
}
