import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// Pure helpers are duplicated here to avoid loading the database in unit tests
const maxDrawdownPct = (values: number[]) => {
  let peak = -Infinity, worst = 0;
  for (const v of values) { peak = Math.max(peak, v); if (peak > 0) worst = Math.max(worst, ((peak - v) / peak) * 100); }
  return worst;
};
const avgDailyReturnPct = (s: number, e: number, d: number) => (d < 1 || s <= 0 || e <= 0 ? null : ((e / s) ** (1 / d) - 1) * 100);

describe('performance math', () => {
  it('drawdown is the worst peak-to-trough drop', () => {
    assert.equal(maxDrawdownPct([100, 120, 90, 130, 117]), 25);
    assert.equal(maxDrawdownPct([100, 101, 102]), 0);
  });
  it('average daily return compounds', () => {
    assert.equal(avgDailyReturnPct(100, 121, 2)!.toFixed(6), '10.000000');
    assert.equal(avgDailyReturnPct(100, 200, 0.5), null);
  });
  it('4% a day for a year is about 1.6 million x (why that target is not realistic)', () => {
    assert.ok(1.04 ** 365 > 1_500_000);
  });
});
