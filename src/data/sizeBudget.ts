/**
 * Size classes, slot costs and power budgets (pass 6: moved out of phenotype.ts so the balance owner can tune
 * them without touching the genome). XXL = "Colossal": a lone creature that fills the whole 6-slot team.
 * Balance contract [SPEC B1]: power is normalised to POWER_BUDGET[class] x quality x level x growth.
 */
export const SIZE_CLASSES = ["XS", "S", "M", "L", "XL", "XXL"] as const;
export type SizeClass = typeof SIZE_CLASSES[number];
export const SLOT_COST: Record<SizeClass, number> = { XS: 1, S: 1, M: 2, L: 3, XL: 4, XXL: 6 };
/**
 * Relative combat-power budget per class. Per-slot OUTCOME parity is the target ([SPEC B3]: big vs swarm at equal
 * slots, measured by tools/balance.ts), not per-slot power: pass 6 gave many small bodies real answers (focus fire,
 * flanking, Pack, sensory overload of keen bodies), so M / L / XL now get 1.05 / 1.12 / 1.2 per slot (the content
 * test caps any class at +-20 %) and measured 46-52 % vs an equal-slot swarm. XXL (a lone colossus, 6 slots) gets
 * 0.98 per slot and its own battle traits (TUNING.colossus* in src/combat/battle.ts): a median random six of S
 * bodies meets it at ~50 %, a well-composed six beats it, a mono-element six weak to it loses (tools/batch.ts).
 * Pass 5 values: M 2, L 2.9, XL 3.9, XXL 5.6.
 */
/**
 * XXL 5.0 (pass 6, orchestrator): measured on REAL colossi (complexity genomes; they carry high quality genes and
 * every part) with `deno task batch 48`: pooled six win rate poor 32 % / median 48 % / good 69 % (seed 5),
 * 35 / 52 / 69 % (held-out 1005). 5.9 gave 10 / 19 / 49 %: the stand-in recipe colossi it was tuned on were weaker.
 */
export const POWER_BUDGET: Record<SizeClass, number> = { XS: 0.85, S: 1, M: 2.1, L: 3.35, XL: 4.8, XXL: 5.0 };
