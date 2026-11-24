/**
 * Amounts are whole numbers: tokens, or USD in millionths of a dollar.
 * A store must check and add every entry of a reservation as one atomic step.
 */
export interface ReserveEntry {
  key: string;
  amount: number;
  limit: number;
  /** When the budget's period ends, in milliseconds. The store may drop the counter after it. */
  expiresAt: number;
}

export type ReserveResult = { ok: true } | { ok: false; key: string; available: number };

export interface BudgetStore {
  reserve(id: string, entries: ReserveEntry[], ttlMs: number): Promise<ReserveResult>;
  /** Replaces the reservation with what was spent, by key. A key left out is charged at its reserved amount. */
  settle(id: string, spent: Record<string, number>): Promise<void>;
  release(id: string): Promise<void>;
  usage(keys: string[]): Promise<Record<string, { used: number; reserved: number }>>;
}

interface Counter {
  used: number;
  reserved: number;
  expiresAt: number;
}

interface Hold {
  amounts: Map<string, number>;
  expiresAt: number;
}

/** Keeps budgets in this process. Use a shared store when more than one instance serves requests. */
export function memoryStore(options: { now?: () => number } = {}): BudgetStore {
  const now = options.now ?? Date.now;
  const counters = new Map<string, Counter>();
  const holds = new Map<string, Hold>();

  const counter = (key: string, expiresAt = Number.POSITIVE_INFINITY) => {
    let c = counters.get(key);
    if (!c) counters.set(key, (c = { used: 0, reserved: 0, expiresAt }));
    return c;
  };

  const drop = (id: string) => {
    const hold = holds.get(id);
    if (!hold) return undefined;
    holds.delete(id);
    for (const [key, amount] of hold.amounts) {
      const c = counters.get(key);
      if (c) c.reserved -= amount;
    }
    return hold;
  };

  const sweep = () => {
    const t = now();
    for (const [id, hold] of holds) if (hold.expiresAt <= t) drop(id);
    for (const [key, c] of counters) if (c.expiresAt <= t && c.reserved === 0) counters.delete(key);
  };

  return {
    async reserve(id, entries, ttlMs) {
      sweep();
      if (holds.has(id)) throw new Error(`Reservation ${id} already exists.`);
      for (const e of entries) {
        const c = counters.get(e.key);
        const taken = c ? c.used + c.reserved : 0;
        if (taken + e.amount > e.limit) return { ok: false, key: e.key, available: Math.max(0, e.limit - taken) };
      }
      const amounts = new Map<string, number>();
      for (const e of entries) {
        counter(e.key, e.expiresAt).reserved += e.amount;
        amounts.set(e.key, (amounts.get(e.key) ?? 0) + e.amount);
      }
      holds.set(id, { amounts, expiresAt: now() + ttlMs });
      return { ok: true };
    },

    async settle(id, spent) {
      const hold = drop(id);
      if (!hold) return;
      for (const [key, reserved] of hold.amounts) counter(key).used += spent[key] ?? reserved;
    },

    async release(id) {
      drop(id);
    },

    async usage(keys) {
      sweep();
      return Object.fromEntries(keys.map((k) => [k, { used: counters.get(k)?.used ?? 0, reserved: counters.get(k)?.reserved ?? 0 }]));
    },
  };
}
