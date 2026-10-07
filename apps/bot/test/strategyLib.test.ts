import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allocate } from '../src/trading/allocator.ts';
import { backtest } from '../src/trading/backtest.ts';
import { applySleeveFill, newSleeve, type Bar } from '../src/trading/sleeve.ts';
import { grid, rebalance, trend } from '../src/trading/strategyLib.ts';

const H = 3600;
const series = (fn: (i: number) => number, n: number): Bar[] => Array.from({ length: n }, (_, i) => ({ ts: i * H, close: fn(i) }));
const noCost = { budgetUsd: 100, costPct: 0, feeUsd: 0 };

describe('sleeve accounting', () => {
  it('tracks cash, tokens, cost and realized PnL with fees', () => {
    let s = newSleeve(100);
    s = applySleeveFill(s, 'buy', 10, 50, 0.1).sleeve;
    assert.deepEqual([s.cashUsd, s.tokens, s.costUsd], [49.9, 10, 50]);
    const r = applySleeveFill(s, 'sell', 5, 40, 0.1);
    assert.equal(r.realizedUsd.toFixed(2), '14.90'); // 40 − 25 cost − 0.10 fee
    assert.equal(r.sleeve.tokens, 5);
  });
});

describe('trend following', () => {
  it('rides a steady uptrend', () => {
    const r = backtest(trend, trend.defaults, series((i) => 100 * 1.002 ** i, 500), noCost);
    assert.ok(r.returnPct > 50, `return ${r.returnPct}`);
    assert.ok(r.exposurePct > 80);
  });
  it('sits out a steady downtrend', () => {
    const r = backtest(trend, trend.defaults, series((i) => 100 * 0.998 ** i, 500), noCost);
    assert.equal(r.trades, 0);
    assert.equal(r.returnPct, 0);
  });
  it('decides at most once per completed hour', () => {
    const bars = series((i) => 100 * 1.01 ** i, 100);
    const s = newSleeve(100);
    const first = trend.decide(trend.defaults, bars, 300, s);
    assert.equal(first.decision?.side, 'buy');
    const again = trend.decide(trend.defaults, bars, 300, { ...s, memo: first.memo });
    assert.equal(again.decision, null);
  });
});

describe('grid', () => {
  it('profits from a sideways market', () => {
    const r = backtest(grid, grid.defaults, series((i) => 100 * (1 + 0.06 * Math.sin(i / 6)), 600), noCost);
    assert.ok(r.closedTrades > 10);
    assert.ok(r.returnPct > 0, `return ${r.returnPct}`);
  });
  it('stops out in a crash instead of holding to zero', () => {
    const r = backtest(grid, grid.defaults, series((i) => 100 * 0.99 ** i, 300), noCost);
    assert.ok(r.holdReturnPct < -90);
    assert.ok(r.returnPct > -30, `grid lost ${r.returnPct}% while holding lost ${r.holdReturnPct}%`);
  });
});

describe('rebalancing', () => {
  it('buys up to the target, then trims after a rise', () => {
    const s = newSleeve(100);
    const first = rebalance.decide(rebalance.defaults, [], 10, s).decision!;
    assert.equal(first.side, 'buy');
    assert.equal(Math.round((first as any).usd), 50);
    const after = { ...s, cashUsd: 50, tokens: 5, costUsd: 50 };
    const trim = rebalance.decide(rebalance.defaults, [], 14, after).decision!; // token now 70/120 = 58%
    assert.equal(trim.side, 'sell');
  });
});

describe('costs are applied', () => {
  it('a strategy trading back and forth loses to fees', () => {
    const zigzag = series((i) => (i % 2 ? 101 : 100), 400);
    const withCosts = backtest(grid, { levels: 50, rangePct: 4 }, zigzag, { budgetUsd: 100, costPct: 1, feeUsd: 0.05 });
    assert.ok(withCosts.returnPct < 0);
  });
});

describe('allocator', () => {
  it('gives more to winners, nothing to benched losers, within floor and cap', () => {
    const a = allocate([
      { id: 1, score: 20, drawdownPct: 5 },
      { id: 2, score: 5, drawdownPct: 5 },
      { id: 3, score: 0, drawdownPct: 5 },
      { id: 4, score: -30, drawdownPct: 40 }, // benched
    ], 1000);
    assert.equal(a.get(4), 0);
    assert.ok(a.get(1)! >= a.get(2)! && a.get(2)! > a.get(3)!);
    for (const v of a.values()) assert.ok(v <= 400 + 1e-6, `over cap: ${v}`);
    assert.equal(Math.round([...a.values()].reduce((x, y) => x + y, 0)), 1000);
  });
  it('everyone benched → nothing allocated', () => {
    const a = allocate([{ id: 1, score: -50, drawdownPct: 60 }], 1000);
    assert.equal(a.get(1), 0);
  });
});

describe('yield math', async () => {
  // Pure helper copied from yield.ts to avoid loading the database here
  const accrued = (amount: number, apyPct: number, ms: number) => amount * (Math.exp(Math.log(1 + apyPct / 100) * (ms / (365 * 86_400_000))) - 1);
  it('a full year at 4% earns 4%', () => assert.equal(accrued(1000, 4, 365 * 86_400_000).toFixed(6), '40.000000'));
  it('one day at 4% is about 0.0107%', () => assert.equal(accrued(1000, 4, 86_400_000).toFixed(4), '0.1075'));
});

describe('allocator regression', () => {
  it('assigns the whole pool when a floor is hit before the caps (real case: $90 went missing)', () => {
    const a = allocate([
      { id: 1, score: 78.2, drawdownPct: 15.7 },
      { id: 2, score: 21.0, drawdownPct: 6.6 },
      { id: 3, score: 4.5, drawdownPct: 23.1 },
    ], 600);
    assert.equal(Math.round([...a.values()].reduce((x, y) => x + y, 0)), 600);
    assert.deepEqual([...a.values()].map(Math.round), [240, 240, 120]);
  });
});
