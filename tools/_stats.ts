// Tiny stats helpers for tools (the full toolkit lives in src/ml/stats.ts).
export function wilsonLike(wins: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 1 };
  const p = wins / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}
