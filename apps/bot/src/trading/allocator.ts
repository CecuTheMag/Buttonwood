// Pure: splits a capital pool between competing strategies according to their results.

export type Contender = { id: number; score: number; drawdownPct: number };
export type AllocationRules = { floorPct: number; capPct: number; benchDrawdownPct: number; benchScore: number };
export const DEFAULT_RULES: AllocationRules = { floorPct: 5, capPct: 40, benchDrawdownPct: 25, benchScore: -10 };

/**
 * Score → weight. Losers past the bench thresholds get nothing (benched). The rest get a share that
 * grows with their score, clamped between floorPct and capPct of the pool, so one lucky streak
 * can't take everything and a slow starter still gets a chance.
 */
export function allocate(contenders: Contender[], poolUsd: number, rules: AllocationRules = DEFAULT_RULES): Map<number, number> {
  const result = new Map<number, number>();
  const active = contenders.filter((c) => c.drawdownPct < rules.benchDrawdownPct && c.score > rules.benchScore);
  for (const c of contenders) result.set(c.id, 0);
  if (active.length === 0 || poolUsd <= 0) return result;

  const minScore = Math.min(...active.map((c) => c.score));
  const weight = new Map(active.map((c) => [c.id, c.score - minScore + 5])); // +5: the weakest still gets weight
  const floor = Math.min(rules.floorPct, 100 / active.length);
  const cap = Math.max(rules.capPct, 100 / active.length);

  // Start proportional to weight, then clamp to [floor, cap] and hand any excess or shortfall to
  // those still inside their bounds (by weight), until the whole pool is assigned.
  const ids = active.map((c) => c.id);
  const totalWeight = ids.reduce((sum, id) => sum + weight.get(id)!, 0);
  const pct = new Map(ids.map((id) => [id, (100 * weight.get(id)!) / totalWeight]));
  for (let i = 0; i < 100; i++) {
    for (const id of ids) pct.set(id, Math.min(cap, Math.max(floor, pct.get(id)!)));
    const gap = 100 - [...pct.values()].reduce((a, b) => a + b, 0);
    if (Math.abs(gap) < 1e-9) break;
    const room = ids.filter((id) => (gap > 0 ? pct.get(id)! < cap - 1e-12 : pct.get(id)! > floor + 1e-12));
    if (room.length === 0) break;
    const roomWeight = room.reduce((sum, id) => sum + weight.get(id)!, 0);
    for (const id of room) pct.set(id, pct.get(id)! + (gap * weight.get(id)!) / roomWeight);
  }
  for (const [id, p] of pct) result.set(id, (poolUsd * p) / 100);
  return result;
}
