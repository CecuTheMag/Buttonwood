// Pure strategy library: trend following, grid, rebalancing. See sleeve.ts for the contract.
import { sma, type DecideResult, type SleeveStrategy } from './sleeve.ts';

const MIN_ORDER_USD = 1;

// ── Trend following ─────────────────────────────────────────────────────────
export type TrendParams = { fastHours: number; slowHours: number; bandPct: number };

/** Long when the fast average is above the slow one (by `bandPct`, to avoid flip-flopping), cash otherwise. Decides once per completed hour. */
export const trend: SleeveStrategy<TrendParams> = {
  type: 'trend',
  label: 'Trend following',
  defaults: { fastHours: 24, slowHours: 72, bandPct: 0.5 },
  describe: (p) => `trend ${p.fastHours}h/${p.slowHours}h`,
  warmupBars: (p) => p.slowHours,
  decide(p, bars, _price, s): DecideResult {
    const last = bars.at(-1);
    if (!last || bars.length < p.slowHours || s.memo.lastBar === last.ts) return { decision: null, memo: s.memo };
    const memo = { ...s.memo, lastBar: last.ts };
    const closes = bars.map((b) => b.close);
    const fast = sma(closes, p.fastHours);
    const slow = sma(closes, p.slowHours);
    if (s.tokens === 0 && fast > slow * (1 + p.bandPct / 100) && s.cashUsd > MIN_ORDER_USD) {
      return { decision: { side: 'buy', usd: s.cashUsd * 0.995, reason: `Uptrend: ${p.fastHours}h average crossed above ${p.slowHours}h average` }, memo };
    }
    if (s.tokens > 0 && fast < slow * (1 - p.bandPct / 100)) {
      return { decision: { side: 'sell', fraction: 1, reason: `Trend ended: ${p.fastHours}h average fell below ${p.slowHours}h average` }, memo };
    }
    return { decision: null, memo };
  },
};

// ── Grid ────────────────────────────────────────────────────────────────────
export type GridParams = { levels: number; rangePct: number };

/**
 * Splits a ±rangePct/2 band around a center price into levels. Each level down buys one slice,
 * each level up sells one. Out of range above (fully sold) → recenter. Falls a full extra half-range
 * below the band → stop out, and stay out until price is back above its 48h average: grids are for
 * sideways markets, so it must not keep catching a falling knife.
 */
export const grid: SleeveStrategy<GridParams> = {
  type: 'grid',
  label: 'Grid',
  defaults: { levels: 10, rangePct: 20 },
  describe: (p) => `grid ${p.levels} levels ±${p.rangePct / 2}%`,
  warmupBars: () => 0,
  decide(p, bars, price, s): DecideResult {
    const memo = { ...s.memo };
    if (memo.stopped) {
      const avg = sma(bars.map((b) => b.close), 48);
      if (Number.isNaN(avg) || price < avg) return { decision: null, memo };
      memo.stopped = false;
      memo.center = undefined;
    }
    const recenter = () => {
      memo.center = price;
      memo.level = Math.floor(p.levels / 2);
      memo.held = 0;
    };
    if (memo.center === undefined) recenter();
    const lower = memo.center * (1 - p.rangePct / 200);
    const step = (memo.center * p.rangePct / 100) / p.levels;
    const slice = s.budgetUsd / p.levels;

    if (price < lower - (memo.center * p.rangePct) / 200 && s.tokens > 0) {
      recenter();
      memo.stopped = true;
      return { decision: { side: 'sell', fraction: 1, reason: 'Grid stop: price fell far below the range. Pausing until it recovers above its 48h average' }, memo };
    }
    const level = Math.max(0, Math.min(p.levels, Math.floor((price - lower) / step)));
    if (level >= p.levels && memo.held === 0) {
      recenter();
      return { decision: null, memo };
    }
    if (level < memo.level) {
      const n = memo.level - level;
      const usd = Math.min(n * slice, s.cashUsd * 0.995);
      memo.level = level;
      if (usd < MIN_ORDER_USD) return { decision: null, memo };
      memo.held += n;
      return { decision: { side: 'buy', usd, reason: `Grid: price dropped ${n} level(s), buying` }, memo };
    }
    if (level > memo.level) {
      const n = Math.min(level - memo.level, memo.held);
      memo.level = level;
      if (n <= 0 || s.tokens <= 0) return { decision: null, memo };
      const fraction = n / memo.held;
      memo.held -= n;
      return { decision: { side: 'sell', fraction, reason: `Grid: price rose ${n} level(s), taking profit` }, memo };
    }
    return { decision: null, memo };
  },
};

// ── Rebalancing ─────────────────────────────────────────────────────────────
export type RebalanceParams = { targetPct: number; driftPct: number };

/** Keeps the token at targetPct of the sleeve. Rebalances when it drifts by driftPct points. */
export const rebalance: SleeveStrategy<RebalanceParams> = {
  type: 'rebalance',
  label: 'Rebalancing',
  defaults: { targetPct: 50, driftPct: 5 },
  describe: (p) => `rebalance to ${p.targetPct}% ±${p.driftPct}`,
  warmupBars: () => 0,
  decide(p, _bars, price, s): DecideResult {
    const tokenUsd = s.tokens * price;
    const total = s.cashUsd + tokenUsd;
    if (total <= 0) return { decision: null, memo: s.memo };
    const pct = (tokenUsd / total) * 100;
    const target = (p.targetPct / 100) * total;
    if (pct < p.targetPct - p.driftPct) {
      const usd = Math.min(target - tokenUsd, s.cashUsd * 0.995);
      if (usd >= MIN_ORDER_USD) return { decision: { side: 'buy', usd, reason: `Rebalance: token is ${pct.toFixed(0)}% of the sleeve (target ${p.targetPct}%)` }, memo: s.memo };
    }
    if (pct > p.targetPct + p.driftPct && tokenUsd > 0) {
      const fraction = (tokenUsd - target) / tokenUsd;
      if (tokenUsd * fraction >= MIN_ORDER_USD) return { decision: { side: 'sell', fraction, reason: `Rebalance: token is ${pct.toFixed(0)}% of the sleeve (target ${p.targetPct}%)` }, memo: s.memo };
    }
    return { decision: null, memo: s.memo };
  },
};

export const SLEEVE_STRATEGIES: Record<string, SleeveStrategy<any>> = { trend, grid, rebalance };
export const isSleeveType = (type: string) => type in SLEEVE_STRATEGIES;
