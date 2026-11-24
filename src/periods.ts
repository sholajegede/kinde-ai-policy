import type { Period } from "./types.js";

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** The current UTC calendar window. Weeks start on Monday. */
export function periodWindow(period: Period, now: Date): { id: string; end: Date } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (period === "day") return { id: isoDate(now), end: new Date(midnight + DAY) };
  if (period === "week") {
    const start = midnight - ((now.getUTCDay() + 6) % 7) * DAY;
    return { id: `week-of-${isoDate(new Date(start))}`, end: new Date(start + 7 * DAY) };
  }
  return {
    id: `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`,
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}
