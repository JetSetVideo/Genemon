/**
 * The Ledger: Genemon's single event schema. Every mechanic (battle, breeding, evolution, market,
 * world, UI action, hardware/session probe) records WHAT happened, WHO did it, WHY (the decision
 * that caused it), WHEN, WHERE (x,y,z + zone + space), FROM which source/state TO which target,
 * with its ENTRIES (inputs) and EXITS (outputs). The ledger feeds:
 *   - the ladder's condition-aware MMR,
 *   - the ML datasets (outcome predictors, policies, projections),
 *   - the Data screen (live feed + graphs),
 *   - AI coding sessions (JSONL exports under artifacts/ are read back as feedback).
 * Schema reference: docs/DATA-MODEL.md. Keep payload values primitive (number/string/boolean) so a
 * row is always one flat JSON line.
 */

export type Space = "physical" | "virtual" | "arena" | "lab" | "market" | "world" | "sim" | "ui" | "device";

export interface Where {
  x: number;
  y: number;
  z: number;
  zone: string;
  space: Space;
}

export type Scalar = number | string | boolean;

export interface GEvent {
  id: string;
  seq: number;
  /** ms: real epoch for live play, simulated ms inside sims/battles. */
  when: number;
  where: Where;
  who: string;
  what: string;
  why: string;
  from: string;
  to: string;
  entries: Record<string, Scalar>;
  exits: Record<string, Scalar>;
  tags?: string[];
}

export type EventInput = Omit<GEvent, "id" | "seq">;

export const NOWHERE: Where = { x: 0, y: 0, z: 0, zone: "none", space: "sim" };

export class Ledger {
  readonly name: string;
  readonly capacity: number;
  #rows: GEvent[] = [];
  #seq = 0;
  #counts = new Map<string, number>();
  #subs = new Set<(e: GEvent) => void>();

  constructor(name = "main", capacity = 20000) {
    this.name = name;
    this.capacity = capacity;
  }

  emit(e: EventInput): GEvent {
    const seq = ++this.#seq;
    const row: GEvent = { id: `${this.name}-${seq}`, seq, ...e };
    this.#rows.push(row);
    if (this.#rows.length > this.capacity) this.#rows.splice(0, this.#rows.length - this.capacity);
    this.#counts.set(e.what, (this.#counts.get(e.what) ?? 0) + 1);
    for (const fn of this.#subs) fn(row);
    return row;
  }

  subscribe(fn: (e: GEvent) => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  get size(): number {
    return this.#rows.length;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  /** Rows with seq > afterSeq (used by renderers to consume new events once per frame). */
  since(afterSeq: number): GEvent[] {
    const out: GEvent[] = [];
    for (let i = this.#rows.length - 1; i >= 0; i--) {
      if (this.#rows[i].seq <= afterSeq) break;
      out.push(this.#rows[i]);
    }
    return out.reverse();
  }

  query(filter: { what?: string | RegExp; who?: string; tag?: string; limit?: number } = {}): GEvent[] {
    const out: GEvent[] = [];
    for (let i = this.#rows.length - 1; i >= 0 && out.length < (filter.limit ?? Infinity); i--) {
      const r = this.#rows[i];
      if (filter.what !== undefined) {
        if (typeof filter.what === "string" ? r.what !== filter.what : !filter.what.test(r.what)) continue;
      }
      if (filter.who !== undefined && r.who !== filter.who) continue;
      if (filter.tag !== undefined && !(r.tags ?? []).includes(filter.tag)) continue;
      out.push(r);
    }
    return out.reverse();
  }

  counts(): Record<string, number> {
    return Object.fromEntries([...this.#counts.entries()].sort((a, b) => b[1] - a[1]));
  }

  rows(): readonly GEvent[] {
    return this.#rows;
  }

  toJSONL(): string {
    return this.#rows.map((r) => JSON.stringify(r)).join("\n");
  }

  clear(): void {
    this.#rows = [];
    this.#counts.clear();
  }
}

/** Validate a row against the schema (used by tests and by import of external data). */
export function isValidEvent(e: unknown): e is GEvent {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  const w = r.where as Record<string, unknown> | undefined;
  const flat = (o: unknown) =>
    !!o && typeof o === "object" &&
    Object.values(o as object).every((v) => ["number", "string", "boolean"].includes(typeof v));
  return typeof r.id === "string" && typeof r.seq === "number" && typeof r.when === "number" &&
    !!w && typeof w.x === "number" && typeof w.y === "number" && typeof w.z === "number" &&
    typeof w.zone === "string" && typeof w.space === "string" &&
    ["who", "what", "why", "from", "to"].every((k) => typeof r[k] === "string") &&
    flat(r.entries) && flat(r.exits);
}
