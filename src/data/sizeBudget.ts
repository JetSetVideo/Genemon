/**
 * Size classes, slot costs and power budgets (pass 6: moved out of phenotype.ts so the balance owner can tune
 * them without touching the genome). XXL = "Colossal": a lone creature that fills the whole 6-slot team.
 * Balance contract [SPEC B1]: power is normalised to POWER_BUDGET[class] x quality x level x growth.
 */
export const SIZE_CLASSES = ["XS", "S", "M", "L", "XL", "XXL"] as const;
export type SizeClass = typeof SIZE_CLASSES[number];
export const SLOT_COST: Record<SizeClass, number> = { XS: 1, S: 1, M: 2, L: 3, XL: 4, XXL: 6 };
/**
 * Relative combat-power budget per class. Per-slot parity is the target ([SPEC B3]: big vs swarm at equal
 * slots within 35-65 %, measured by tools/balance.ts); big bodies get slightly less than 1.0 per slot because
 * they also hit harder in contact, cleave in melee and shrug off knockback. Pass 6 goal: six well-raised,
 * well-combined small Genemon beat a lone XXL; a badly composed team loses to it (tools/batch.ts).
 */
export const POWER_BUDGET: Record<SizeClass, number> = { XS: 0.85, S: 1, M: 2, L: 2.9, XL: 3.9, XXL: 5.6 };
